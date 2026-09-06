import assert from "node:assert/strict";
import test from "node:test";

import { routeA2AEnvelope } from "../src/consilium/a2a.ts";
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
