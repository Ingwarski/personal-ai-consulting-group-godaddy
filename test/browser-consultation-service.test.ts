import assert from "node:assert/strict";
import test from "node:test";

import { ArchiveService } from "../src/archive/archive-service.ts";
import { createArchiveCloseGate } from "../src/archive/close-gate.ts";
import { createBrowserConsultationService } from "../src/godaddy/browser-consultation-service.ts";
import type { GoDaddyConsiliumRuntime } from "../src/godaddy/consilium-runtime.ts";
import type { ConsultationLeadership } from "../src/godaddy/consultation-leadership.ts";
import { createGoDaddyRegistrarRuntime } from "../src/godaddy/registrar-runtime.ts";
import { MySqlKeyValueStorage } from "../src/godaddy/mysql-storage.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemoryArchiveStorage } from "./fixtures/memory-archive-storage.ts";
import { MemoryMySqlPool } from "./fixtures/memory-mysql-pool.ts";

const requestId = "request-browser-0001";

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for consultation.");
}

async function harness(overrides: Readonly<{ plan?: GoDaddyConsiliumRuntime["plan"] }> = {}) {
  const pool = new MemoryMySqlPool();
  const registrarRuntime = createGoDaddyRegistrarRuntime({ pool, now: () => activeNow });
  const receipt = createCapabilityReceipt();
  const resolved = resolveEffectiveSessionSnapshot({
    sessionId: `session-${requestId}`,
    settingsRevision: 1,
    settings: receipt.defaults,
    capabilityReceipt: receipt
  }, activeNow);
  if (!resolved.ok) throw new Error("Expected snapshot.");
  const archives = new MemoryArchiveStorage();
  const archiveService = new ArchiveService({ storage: archives, now: () => activeNow });
  const archiveKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  let locked = false;
  const leadership: ConsultationLeadership = {
    async acquire() { if (locked) return false; locked = true; return true; },
    async check() { return locked; },
    async release() { locked = false; }
  };
  const executor = {
    plan: overrides.plan ?? (async () => ({ ok: true as const, kind: "direct" as const, answer: "A reviewed direct answer.", language: "en" })),
    async run() { return { ok: false as const, code: "runtime_unavailable" as const }; },
    async close() {},
    async canResumeFinalization() { return false; },
    async resumeFinalization() { return { ok: false as const, code: "runtime_unavailable" as const }; },
    async transcribeVoice() { return { ok: false as const, code: "runtime_unavailable" as const }; },
    async translateServiceMessages() { return { ok: false as const, code: "runtime_unavailable" as const }; }
  } as unknown as GoDaddyConsiliumRuntime;
  const service = createBrowserConsultationService({
    storage: new MySqlKeyValueStorage({ executor: pool, namespace: "browser-consultation-v1" }),
    registrarRuntime,
    executor,
    prepareSnapshot: async () => resolved.value,
    archiveService,
    archiveKey,
    archiveBeforeClose: createArchiveCloseGate({ archiveService, key: archiveKey }),
    leadership,
    now: () => activeNow
  });
  return { service, pool, registrarRuntime, archives, archiveService, archiveKey };
}

test("authenticated browser consultation archives a direct answer before closing and stores only a task hash", async () => {
  const value = await harness();
  const submitted = await value.service.submit({ requestId, task: "Explain gross margin.", consent: true });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) throw new Error("Expected accepted consultation.");
  await waitFor(async () => (await value.service.read(requestId))?.record.status === "completed");

  const view = await value.service.read(requestId);
  assert.equal(view?.record.outcome, "direct");
  assert.equal(view?.messages[0]?.body, "A reviewed direct answer.");
  assert.equal((await value.registrarRuntime.registrar.getSession(view!.record.generation!))?.phase, "closed");
  const archiveId = view?.record.archiveId;
  assert.ok(archiveId);
  assert.equal(value.archives.records.get(archiveId!)?.lifecycle, "committed");
  assert.doesNotMatch([...value.pool.values.values()].join("\n"), /Explain gross margin/u);
  assert.match(view!.record.taskSha256, /^[a-f0-9]{64}$/u);

  const replay = await value.service.submit({ requestId, task: "A different body is ignored for this idempotency key.", consent: true });
  assert.equal(replay.ok && replay.replayed, true);
});

test("consultation admission rejects missing consent, secret-like content, and concurrent starts", async () => {
  let resolvePlan: ((value: { ok: true; kind: "direct"; answer: string; language: string }) => void) | undefined;
  const value = await harness({ plan: async () => new Promise(resolve => { resolvePlan = resolve; }) });
  assert.deepEqual(await value.service.submit({ requestId, task: "Ordinary task", consent: false }), { ok: false, code: "consent_required" });
  assert.deepEqual(await value.service.submit({ requestId, task: "Use token sk-123456789012345678901234567890", consent: true }), { ok: false, code: "secret_detected" });
  const first = await value.service.submit({ requestId, task: "First task", consent: true });
  assert.equal(first.ok, true);
  assert.deepEqual(await value.service.submit({ requestId: "request-browser-0002", task: "Second task", consent: true }), { ok: false, code: "busy" });
  resolvePlan?.({ ok: true, kind: "direct", answer: "Finished.", language: "en" });
  await waitFor(async () => (await value.service.read(requestId))?.record.status === "completed");
});

test("owner stop wins its race with an aborted provider turn and seals the partial session", async () => {
  const value = await harness({ plan: async request => new Promise(resolve => {
    if (request.signal?.aborted) { resolve({ ok: false, code: "intake_failed" }); return; }
    request.signal?.addEventListener("abort", () => resolve({ ok: false, code: "intake_failed" }), { once: true });
  }) });
  const submitted = await value.service.submit({ requestId, task: "Long task", consent: true });
  assert.equal(submitted.ok, true);
  const stopped = await value.service.stop(requestId);
  assert.equal(stopped.ok, true);
  await waitFor(async () => (await value.service.read(requestId))?.record.status === "stopped");
  assert.equal((await value.service.read(requestId))?.record.errorCode, "owner_stopped");
  await value.service.close();
});

test("restart recovery fails closed instead of replaying an uncertain provider call", async () => {
  const value = await harness({ plan: async request => new Promise(resolve => {
    if (request.signal?.aborted) { resolve({ ok: false, code: "intake_failed" }); return; }
    request.signal?.addEventListener("abort", () => resolve({ ok: false, code: "intake_failed" }), { once: true });
  }) });
  const submitted = await value.service.submit({ requestId, task: "Interrupted task", consent: true });
  assert.equal(submitted.ok, true);
  // A new process sees the durable active record but has no safe evidence that
  // the old provider call can be replayed exactly once.
  const recovered = await harness();
  recovered.pool.values = new Map(value.pool.values);
  await recovered.service.start();
  const record = await recovered.service.read(requestId);
  assert.equal(record?.record.status, "failed");
  assert.equal(record?.record.errorCode, "interrupted_before_completion");
  await value.service.stop(requestId);
  await value.service.close();
});
