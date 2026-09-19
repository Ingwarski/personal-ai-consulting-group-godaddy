import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createConnection, createPool } from "mysql2/promise";

import { ArchiveService } from "../src/archive/archive-service.ts";
import { createConsultationLeadership } from "../src/godaddy/consultation-leadership.ts";
import { MySqlArchiveStorage } from "../src/godaddy/mysql-archive-storage.ts";
import { MySqlKeyValueStorage, type MySqlPool } from "../src/godaddy/mysql-storage.ts";
import { createInstructionDocumentService } from "../src/instructions/documents.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";

const enabled = process.env.MYSQL_INTEGRATION === "1";
const configuration = {
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? "3306"),
  database: process.env.DB_NAME ?? "personal_consultant_test",
  user: process.env.DB_USER ?? "root",
  password: process.env.DB_PASSWORD ?? "test-password"
};
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("real MySQL preserves transactional state, encrypted documents, archive lifecycle, and namespaced leadership", { skip: !enabled, timeout: 30_000 }, async () => {
  const schema = await readFile(resolve(repositoryRoot, "scripts/godaddy-state-schema.sql"), "utf8");
  const setup = await createConnection({ ...configuration, multipleStatements: true });
  try { await setup.query(schema); } finally { await setup.end(); }

  const pool = createPool({ ...configuration, connectionLimit: 6, waitForConnections: true });
  const typedPool = pool as unknown as MySqlPool;
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const state = new MySqlKeyValueStorage({ executor: typedPool, namespace: "integration-test-v1" });
    await state.put(`before-${suffix}`, { revision: 1 });
    await assert.rejects(state.transaction(async transaction => {
      await transaction.put(`before-${suffix}`, { revision: 2 });
      throw new Error("rollback");
    }), /rollback/u);
    assert.deepEqual(await state.get(`before-${suffix}`), { revision: 1 });

    const secret = "integration-instruction-root-secret-with-sufficient-independent-entropy";
    const instruction = createInstructionDocumentService({
      pool: typedPool,
      rootSecret: secret,
      repositoryRoot,
      now: () => activeNow
    });
    assert.notEqual(instruction, undefined);
    await instruction!.initialize();
    const first = await instruction!.read("agents");
    assert.ok(first);
    const changed = await instruction!.update({ id: "agents", expectedRevision: first!.revision, markdown: `# Integration ${suffix}` });
    assert.equal(changed.ok, true);
    const [cipherRows] = await pool.execute(
      "SELECT state_value FROM personal_consultant_state WHERE state_namespace = ? AND state_key LIKE 'doc-agents-r%'",
      ["instruction-documents-v1"]
    );
    assert.doesNotMatch(JSON.stringify(cipherRows), new RegExp(`Integration ${suffix}`, "u"));
    assert.match(JSON.stringify(cipherRows), /ciphertextBase64/u);

    const receipt = createCapabilityReceipt();
    const snapshot = resolveEffectiveSessionSnapshot({ sessionId: `integration-${suffix}`.slice(0, 120), settingsRevision: 1,
      settings: receipt.defaults, capabilityReceipt: receipt }, activeNow);
    assert.equal(snapshot.ok, true);
    if (!snapshot.ok) throw new Error("Expected snapshot.");
    const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
    const started = await registrar.startSession({ sessionId: snapshot.value.sessionId, settingsSnapshot: snapshot.value });
    assert.equal(started.ok, true);
    if (!started.ok) throw new Error("Expected session.");
    await registrar.appendConfirmedMessage({ generation: started.value.generation, eventId: `event-${suffix}`.slice(0, 120), role: "Head", body: `Private result ${suffix}` });
    const stopped = await registrar.stopSession(started.value.generation);
    if (!stopped.ok) throw new Error("Expected stopped session.");
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const archive = new ArchiveService({ storage: new MySqlArchiveStorage(typedPool), now: () => activeNow });
    const sealed = await archive.seal({ session: stopped.value, messages: await registrar.getConfirmedMessages(started.value.generation), key });
    assert.equal(sealed.ok, true);
    if (!sealed.ok) throw new Error("Expected archive.");
    const [archiveRows] = await pool.execute("SELECT ciphertext_base64 FROM personal_consultant_archives WHERE archive_id = ?", [sealed.archiveId]);
    assert.doesNotMatch(JSON.stringify(archiveRows), new RegExp(`Private result ${suffix}`, "u"));
    assert.equal((await archive.exportWholeSession({ archiveId: sealed.archiveId, key, ownerConfirmed: true })).ok, true);
    assert.deepEqual(await archive.deleteWholeSession({ archiveId: sealed.archiveId, ownerConfirmed: true }), { ok: true, replayed: false });

    const firstNamespace = createConsultationLeadership(typedPool, `db-a-${suffix}`);
    const sameNamespace = createConsultationLeadership(typedPool, `db-a-${suffix}`);
    const otherNamespace = createConsultationLeadership(typedPool, `db-b-${suffix}`);
    assert.equal(await firstNamespace.acquire(), true);
    assert.equal(await sameNamespace.acquire(), false);
    assert.equal(await otherNamespace.acquire(), true);
    await Promise.all([firstNamespace.release(), sameNamespace.release(), otherNamespace.release()]);
  } finally {
    await pool.end();
  }
});
