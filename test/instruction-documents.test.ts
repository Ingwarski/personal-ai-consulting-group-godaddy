import assert from "node:assert/strict";
import test from "node:test";

import { createInstructionDocumentService, INSTRUCTION_DOCUMENTS } from "../src/instructions/documents.ts";
import { MemoryMySqlPool } from "./fixtures/memory-mysql-pool.ts";

const secret = "instruction-test-root-secret-that-is-long-enough-for-aes-key-derivation";
const defaults = new Map(INSTRUCTION_DOCUMENTS.map(document => [document.filename, `# ${document.title}\n\nReviewed default.`]));

function service(pool = new MemoryMySqlPool()) {
  const value = createInstructionDocumentService({
    pool,
    rootSecret: secret,
    repositoryRoot: "/not-used",
    now: () => new Date("2026-09-19T09:00:00.000Z"),
    readDefault: async filename => defaults.get(filename) ?? Promise.reject(new Error("Missing fixture."))
  });
  assert.notEqual(value, undefined);
  return { service: value!, pool };
}

test("instruction defaults are imported once and persist only as ciphertext", async () => {
  const value = service();
  await value.service.initialize();
  const documents = await value.service.list();
  assert.equal(documents.length, 4);
  assert.equal(documents[0]?.revision, 1);
  assert.equal(documents[0]?.markdown, "# Consulting behavior\n\nReviewed default.");

  const persisted = [...value.pool.values.values()].join("\n");
  assert.doesNotMatch(persisted, /Reviewed default|Consulting behavior/u);
  assert.match(persisted, /ciphertextBase64/u);
});

test("instruction updates are revision-fenced, encrypted, and snapshot-pinned", async () => {
  const value = service();
  await value.service.initialize();
  const updated = await value.service.update({ id: "agents", expectedRevision: 1, markdown: "# Owner rules\n\nUse current evidence." });
  assert.equal(updated.ok, true);
  if (!updated.ok) throw new Error("Expected update.");
  assert.equal(updated.document.revision, 2);

  assert.deepEqual(await value.service.update({ id: "agents", expectedRevision: 1, markdown: "# Stale overwrite" }), {
    ok: false,
    code: "revision_conflict"
  });
  assert.doesNotMatch([...value.pool.values.values()].join("\n"), /Use current evidence|Stale overwrite/u);

  const snapshot = await value.service.snapshot();
  const pinned = snapshot.documents.find(document => document.id === "agents");
  assert.equal(pinned?.revision, 2);
  assert.equal(pinned?.markdown, "# Owner rules\n\nUse current evidence.");
});

test("restoring a reviewed default creates a new encrypted revision", async () => {
  const value = service();
  await value.service.initialize();
  const changed = await value.service.update({ id: "working-context", expectedRevision: 1, markdown: "# Temporary context" });
  assert.equal(changed.ok, true);
  const restored = await value.service.restoreDefault({ id: "working-context", expectedRevision: 2 });
  assert.equal(restored.ok, true);
  if (!restored.ok) throw new Error("Expected restore.");
  assert.equal(restored.document.revision, 3);
  assert.equal(restored.document.markdown, defaults.get("WORKING_CONTEXT.md"));
});

test("instruction service fails closed for weak keys and invalid documents", async () => {
  assert.equal(createInstructionDocumentService({ pool: new MemoryMySqlPool(), rootSecret: "short", repositoryRoot: "/tmp" }), undefined);
  const value = service();
  await value.service.initialize();
  assert.deepEqual(await value.service.update({ id: "agents", expectedRevision: 1, markdown: "\u0000" }), {
    ok: false,
    code: "invalid_document"
  });
});
