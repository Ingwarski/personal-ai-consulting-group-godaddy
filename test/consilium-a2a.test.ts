import assert from "node:assert/strict";
import test from "node:test";

import { routeA2AEnvelope, routeHeadAssignment } from "../src/consilium/a2a.ts";
import { validateConsiliumRoster, type AgentRegistration } from "../src/consilium/roster.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";

const specialists: readonly AgentRegistration[] = [
  { agentId: "finance", role: "Фінансовий консультант", provider: "codex", runtimeSessionRef: "codex-thread-finance" },
  { agentId: "strategy", role: "Стратег", provider: "codex", runtimeSessionRef: "codex-thread-strategy" }
];
const critic: AgentRegistration = { agentId: "critic", role: "Критик", provider: "claude_code", runtimeSessionRef: "claude-process-critic" };

async function startedRegistrar() {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "settings-snapshot-source",
    settingsRevision: 1,
    settings: receipt.defaults,
    capabilityReceipt: receipt
  }, activeNow);
  if (!snapshot.ok) throw new Error("Snapshot must resolve.");
  const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
  await registrar.startSession({ sessionId: "task-a2a", settingsSnapshot: snapshot.value });
  return registrar;
}

test("requires two to five registered Codex specialists and one separate Claude or Codex critic", () => {
  const valid = validateConsiliumRoster(specialists, critic);
  assert.equal(valid.ok, true);
  assert.deepEqual(validateConsiliumRoster([specialists[0]], critic), { ok: false, code: "invalid_specialist_count" });
  assert.equal(validateConsiliumRoster(specialists, { ...critic, provider: "codex" }).ok, true);
  assert.deepEqual(validateConsiliumRoster(specialists, { ...critic, provider: "codex", runtimeSessionRef: specialists[0]!.runtimeSessionRef }), { ok: false, code: "invalid_agent_registration" });
});

test("shared head assignment is a single idempotent record with all recipients bound to its fingerprint", async () => {
  const registrar = await startedRegistrar();
  const head: AgentRegistration = { agentId: "head", role: "Головний консультант", provider: "codex", runtimeSessionRef: "head-thread" };
  const roster = [head, ...specialists, critic];
  const input = { messageId: "head-broadcast-one", sessionGeneration: 1, toAgentIds: specialists.map(agent => agent.agentId), body: "Кожен надішліть свою первинну позицію." };
  assert.deepEqual(await routeHeadAssignment(registrar, roster, head, input), { ok: true, visibleSequence: 1, replayed: false });
  assert.deepEqual(await routeHeadAssignment(registrar, roster, head, input), { ok: true, visibleSequence: 1, replayed: true });
  assert.deepEqual(await routeHeadAssignment(registrar, roster, head, { ...input, toAgentIds: [critic.agentId] }),
    { ok: false, code: "registrar_rejected", cause: "idempotency_conflict" });
  const messages = await registrar.getConfirmedMessages(1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.addressedTo, "Фінансовий консультант; Стратег");
  assert.equal(messages[0]?.authority?.kind, "assignment");
  assert.equal(await registrar.getCriticReview(1), undefined);
  const outbox = await registrar.getLocalMatrixOutboxRecordForTest(1, 1);
  assert.equal(outbox?.message.internalEventId, input.messageId);
  assert.equal(await registrar.getLocalMatrixOutboxRecordForTest(1, 2), undefined);
});

test("shared assignment rejects invalid recipients, substituted head, unsafe content and stopped generations", async () => {
  const registrar = await startedRegistrar();
  const head: AgentRegistration = { agentId: "head", role: "Головний консультант", provider: "codex", runtimeSessionRef: "head-thread" };
  const roster = [head, ...specialists, critic];
  const input = { messageId: "head-broadcast-invalid", sessionGeneration: 1, toAgentIds: ["finance", "strategy"], body: "Первинні позиції." };
  let delivered = 0;
  const observe = async () => { delivered++; };
  for (const toAgentIds of [[], ["finance", "finance"], ["head"], ["unknown"], ["invalid id"], ["a", "b", "c", "d", "e", "f"]]) {
    assert.equal((await routeHeadAssignment(registrar, roster, head, { ...input, toAgentIds }, observe)).ok, false);
  }
  assert.equal((await routeHeadAssignment(registrar, roster, { ...head, runtimeSessionRef: "substituted" }, input, observe)).ok, false);
  assert.equal((await routeHeadAssignment(registrar, roster, head, { ...input, body: "password=private-value" }, observe)).ok, false);
  assert.deepEqual(await registrar.getConfirmedMessages(1), []);
  await registrar.stopSession(1);
  assert.deepEqual(await routeHeadAssignment(registrar, roster, head, input, observe), { ok: false, code: "registrar_rejected", cause: "session_not_active" });
  assert.equal(delivered, 0);
});

test("routes a complete addressed A2A message through the sole registrar", async () => {
  const roster = validateConsiliumRoster(specialists, critic);
  if (!roster.ok) throw new Error("Roster must be valid.");
  const registrar = await startedRegistrar();
  const routed = await routeA2AEnvelope(registrar, roster.agents, {
    messageId: "a2a-message-0001",
    sessionGeneration: 1,
    fromAgentId: "finance",
    toAgentId: "critic",
    kind: "initial_position",
    body: "Мій повний незалежний висновок."
  });

  assert.deepEqual(routed, { ok: true, visibleSequence: 1, replayed: false });
  const messages = await registrar.getConfirmedMessages(1);
  assert.equal(messages[0]?.role, "Фінансовий консультант");
  assert.equal(messages[0]?.addressedTo, "Критик");
  assert.equal(messages[0]?.body, "Мій повний незалежний висновок.");
});

test("does not route an envelope from an unregistered agent", async () => {
  const roster = validateConsiliumRoster(specialists, critic);
  if (!roster.ok) throw new Error("Roster must be valid.");
  const result = await routeA2AEnvelope(await startedRegistrar(), roster.agents, {
    messageId: "a2a-message-0002",
    sessionGeneration: 1,
    fromAgentId: "ghost",
    toAgentId: "critic",
    kind: "critique",
    body: "Ця репліка не повинна потрапити в журнал."
  });
  assert.deepEqual(result, { ok: false, code: "agent_not_registered", cause: "sender_not_registered" });
});

test("preserves a safe Registrar failure cause instead of flattening it", async () => {
  const roster = validateConsiliumRoster(specialists, critic);
  if (!roster.ok) throw new Error("Roster must be valid.");
  const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
  const result = await routeA2AEnvelope(registrar, roster.agents, {
    messageId: "a2a-message-no-session",
    sessionGeneration: 1,
    fromAgentId: "finance",
    toAgentId: "critic",
    kind: "initial_position",
    body: "Немає активної сесії."
  });
  assert.deepEqual(result, { ok: false, code: "registrar_rejected", cause: "no_active_session" });
});

test("unsafe generated A2A bodies are rejected whole before append, Critic receipt, or publication", async () => {
  const registrar = await startedRegistrar();
  await registrar.designateCritic({ generation: 1, critic });
  const roster = [...specialists, critic];
  let delivered = 0;
  for (const [index, body] of ["password=private-value", "IBAN: GB82WEST12345698765432", "SSN: 123-45-6789"].entries()) {
    const result = await routeA2AEnvelope(registrar, roster, {
      messageId: `unsafe-critic-${index}`, sessionGeneration: 1, fromAgentId: critic.agentId,
      toAgentId: specialists[0]!.agentId, kind: "critique", body
    }, async () => { delivered += 1; });
    assert.deepEqual(result, { ok: false, code: "invalid_envelope", cause: "invalid_runtime_emission" });
    assert.equal(JSON.stringify(result).includes(body), false);
  }
  assert.deepEqual(await registrar.getConfirmedMessages(1), []);
  assert.equal(await registrar.getCriticReview(1), undefined);
  assert.equal(delivered, 0);
});
