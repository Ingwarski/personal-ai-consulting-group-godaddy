import assert from "node:assert/strict";
import test from "node:test";
import { routeA2AEnvelope } from "../src/consilium/a2a.ts";
import { CriticGatedFinalizer } from "../src/consilium/final-recommendation.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";

const head = { agentId: "head", role: "Головний консультант", provider: "codex" as const, runtimeSessionRef: "thread-head-identity" };
const critic = { agentId: "critic", role: "Критик", provider: "codex" as const, runtimeSessionRef: "thread-critic-identity" };
const specialist = { agentId: "finance", role: "Критик", provider: "codex" as const, runtimeSessionRef: "thread-specialist-identity" };
const roster = [head, specialist, critic];
const envelope = { messageId: "critic-event-identity", sessionGeneration: 1, fromAgentId: critic.agentId, toAgentId: head.agentId, kind: "critique" as const, body: "Повна незалежна критика." };

async function setup() {
  const receipt = createCapabilityReceipt();
  const result = resolveEffectiveSessionSnapshot({ sessionId: "critic-identity-settings", settingsRevision: 1,
    settings: { ...receipt.defaults, critic: { provider: "codex", claude: null, codex: receipt.defaults.codex } }, capabilityReceipt: receipt }, activeNow);
  if (!result.ok) throw new Error("Expected current route.");
  const storage = new MemoryRegistrarStorage();
  const registrar = new RegistrarDO({ storage, now: () => activeNow });
  await registrar.startSession({ sessionId: "critic-identity-session", settingsSnapshot: result.value });
  assert.equal((await registrar.designateCritic({ generation: 1, critic })).ok, true);
  return { registrar, storage, snapshot: result.value };
}

test("only the designated critic context can submit critique, not a same-provider head/specialist or same-label runtime", async () => {
  const { registrar } = await setup();
  for (const sender of [head, specialist, { ...critic, runtimeSessionRef: "thread-fake-critic" }, { ...critic, provider: "claude_code" as const }]) {
    const alternateRoster = roster.map((agent) => agent.agentId === sender.agentId ? sender : agent);
    const rejected = await routeA2AEnvelope(registrar, alternateRoster, { ...envelope, fromAgentId: sender.agentId });
    assert.deepEqual(rejected, { ok: false, code: "registrar_rejected", cause: "runtime_identity_mismatch" });
  }
  assert.deepEqual(await registrar.getConfirmedMessages(1), []);
  assert.equal(await registrar.getCriticReview(1), undefined);
  assert.equal((await routeA2AEnvelope(registrar, roster, envelope)).ok, true);
  const review = await registrar.getCriticReview(1);
  assert.equal(review?.agentId, critic.agentId);
  assert.equal(review?.provider, "codex");
  assert.equal(review?.runtimeSessionRef, critic.runtimeSessionRef);
  assert.equal(review?.sessionId, "critic-identity-session");
  assert.equal(review?.bodyHash, (await registrar.getConfirmedMessages(1))[0]?.bodyHash);
});

test("an ordinary reply or legacy role-only receipt cannot satisfy the gate", async () => {
  const { registrar, storage } = await setup();
  await routeA2AEnvelope(registrar, roster, { ...envelope, kind: "answer" });
  assert.deepEqual(await registrar.recordCriticReview({ generation: 1, eventId: envelope.messageId, critic }), { ok: false, code: "invalid_event" });
  await storage.put("registrar:critic-review:1", { generation: 1, eventId: envelope.messageId, role: critic.role, registeredAt: activeNow.toISOString() });
  assert.equal(await registrar.getCriticReview(1), undefined);
  const finalizer = new CriticGatedFinalizer({ registrar, head, critic });
  assert.deepEqual(await finalizer.publish({ sessionGeneration: 1, messageId: "forged-final-identity", recommendation: {
    decision: "Не публікувати", actions: [], riskOrAssumption: "Немає підтвердженої критики", reviewCondition: "Після справжньої критики"
  } }), { ok: false, code: "critic_not_ready" });
});

test("critique event identity cannot be replayed across a new generation or replace a prior receipt", async () => {
  const { registrar, snapshot } = await setup();
  assert.equal((await routeA2AEnvelope(registrar, roster, envelope)).ok, true);
  assert.deepEqual(await routeA2AEnvelope(registrar, roster, envelope), { ok: true, visibleSequence: 1, replayed: true });
  await registrar.appendConfirmedMessage({ generation: 1, eventId: "second-critic-event", role: critic.role, body: "Інша репліка", authority: { agentId: critic.agentId, provider: critic.provider, runtimeSessionRef: critic.runtimeSessionRef, kind: "critique" } });
  assert.deepEqual(await registrar.recordCriticReview({ generation: 1, eventId: "second-critic-event", critic }), { ok: false, code: "idempotency_conflict" });
  await registrar.startNewTask({ sessionId: "critic-identity-next", settingsSnapshot: snapshot });
  assert.equal(await registrar.getCriticReview(1), undefined);
  await registrar.designateCritic({ generation: 2, critic: { ...critic, runtimeSessionRef: "thread-next-critic" } });
  const newRoster = roster.map((agent) => agent.agentId === critic.agentId ? { ...critic, runtimeSessionRef: "thread-next-critic" } : agent);
  assert.deepEqual(await routeA2AEnvelope(registrar, newRoster, { ...envelope, sessionGeneration: 2 }), { ok: false, code: "registrar_rejected", cause: "obsolete_generation" });
  assert.equal(await registrar.getCriticReview(2), undefined);
});

test("a tampered confirmed body hash or runtime authority invalidates an otherwise complete receipt", async () => {
  const { registrar, storage } = await setup();
  await routeA2AEnvelope(registrar, roster, envelope);
  const event = await storage.get<{ bodyHash: string; message: Record<string, unknown> }>(`registrar:event:${envelope.messageId}`);
  assert.ok(event);
  await storage.put(`registrar:event:${envelope.messageId}`, { ...event, message: { ...event.message, bodyHash: "replaced" } });
  assert.equal(await registrar.getCriticReview(1), undefined);
});
