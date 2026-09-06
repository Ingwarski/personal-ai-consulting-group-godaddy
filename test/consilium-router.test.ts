import assert from "node:assert/strict";
import test from "node:test";

import { ConsiliumRouter, type ConsiliumAgentRuntime } from "../src/consilium/router.ts";
import type { AgentRegistration } from "../src/consilium/roster.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { activeNow, createCapabilityReceipt, createResolvedTestSpeedPolicyCatalog } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";
import { UNAPPROVED_SPEED_POLICY_CATALOG } from "../src/settings/speed-policy.ts";

const head: AgentRegistration = { agentId: "head", role: "Головний консультант", provider: "codex", runtimeSessionRef: "codex-head-thread" };
const finance: AgentRegistration = { agentId: "finance", role: "Фінансовий консультант", provider: "codex", runtimeSessionRef: "codex-finance-thread" };
const strategy: AgentRegistration = { agentId: "strategy", role: "Стратег", provider: "codex", runtimeSessionRef: "codex-strategy-thread" };
const critic: AgentRegistration = { agentId: "critic", role: "Критик", provider: "claude_code", runtimeSessionRef: "claude-critic-process" };

async function activeRegistrar(): Promise<RegistrarDO> {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "router-settings",
    settingsRevision: 1,
    settings: receipt.defaults,
    capabilityReceipt: receipt,
    speedPolicyCatalog: createResolvedTestSpeedPolicyCatalog()
  }, activeNow);
  if (!snapshot.ok) throw new Error("Expected a snapshot.");
  const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
  await registrar.startSession({ sessionId: "router-session", settingsSnapshot: snapshot.value });
  return registrar;
}

const runtime = (registration: AgentRegistration, handler: ConsiliumAgentRuntime["run"]): ConsiliumAgentRuntime => ({ registration, run: handler });

test("starts independent specialist passes, records the critic, then records each visible specialist revision", async () => {
  const registrar = await activeRegistrar();
  const started: string[] = [];
  let criticEvidence: readonly { fromRole: string; body: string }[] = [];
  const router = new ConsiliumRouter({
    registrar,
    head,
    specialists: [finance, strategy],
    critic,
    runtimes: [
      runtime(head, async () => { throw new Error("Head must not run before critique."); }),
      runtime(finance, async (input, emit) => {
        started.push(`${input.phase}:${finance.agentId}`);
        if (input.phase === "initial_position") {
          await emit({ messageId: "router-finance-0001", kind: "initial_position", toAgentId: critic.agentId, body: "Повний фінансовий висновок." });
        } else {
          assert.equal(input.evidence.at(-1)?.fromRole, critic.role);
          await emit({ messageId: "router-finance-0002", kind: "revision", toAgentId: head.agentId, body: "Фінансовий висновок доопрацьовано після критики." });
        }
      }),
      runtime(strategy, async (input, emit) => {
        started.push(`${input.phase}:${strategy.agentId}`);
        if (input.phase === "initial_position") {
          await emit({ messageId: "router-strategy-0001", kind: "initial_position", toAgentId: critic.agentId, body: "Повний стратегічний висновок." });
        } else {
          assert.equal(input.evidence.at(-1)?.fromRole, critic.role);
          await emit({ messageId: "router-strategy-0002", kind: "revision", toAgentId: head.agentId, body: "Стратегічний висновок доопрацьовано після критики." });
        }
      }),
      runtime(critic, async (input, emit) => {
        started.push(`${input.phase}:${critic.agentId}`);
        criticEvidence = input.evidence;
        await emit({ messageId: "router-critic-0001", kind: "critique", toAgentId: head.agentId, body: "Критична перевірка обох висновків." });
      })
    ]
  });

  const result = await router.run({ sessionGeneration: 1, task: "Дай практичне рішення." });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected a routed consilium.");
  assert.deepEqual([...result.assignmentVisibleSequences].sort((left, right) => left - right), [1, 2, 5, 7, 8]);
  assert.deepEqual([...result.initialVisibleSequences].sort((left, right) => left - right), [3, 4]);
  assert.equal(result.critiqueVisibleSequence, 6);
  assert.deepEqual([...result.revisionVisibleSequences].sort((left, right) => left - right), [9, 10]);
  assert.deepEqual(new Set(started.slice(0, 2)), new Set(["initial_position:finance", "initial_position:strategy"]));
  assert.equal(started[2], "critique:critic");
  assert.deepEqual(new Set(started.slice(3)), new Set(["revision:finance", "revision:strategy"]));
  assert.deepEqual(criticEvidence, [
    { fromRole: "Фінансовий консультант", body: "Повний фінансовий висновок." },
    { fromRole: "Стратег", body: "Повний стратегічний висновок." }
  ]);
  const messages = await registrar.getConfirmedMessages(1);
  assert.deepEqual(new Set(messages.slice(2, 4).map((message) => message.body)), new Set([
    "Повний фінансовий висновок.", "Повний стратегічний висновок."
  ]));
  assert.equal(messages[5]?.body, "Критична перевірка обох висновків.");
  assert.deepEqual(new Set(messages.slice(8).map((message) => message.body)), new Set([
    "Фінансовий висновок доопрацьовано після критики.",
    "Стратегічний висновок доопрацьовано після критики."
  ]));
});

test("does not fabricate a consilium when a runtime is missing, mismatched or returns no complete visible message", async () => {
  const registrar = await activeRegistrar();
  const missing = new ConsiliumRouter({ registrar, head, specialists: [finance, strategy], critic, runtimes: [] });
  assert.deepEqual(await missing.run({ sessionGeneration: 1, task: "x" }), { ok: false, code: "runtime_missing", cause: "runtime_missing" });

  const mismatched = new ConsiliumRouter({
    registrar,
    head,
    specialists: [finance, strategy],
    critic,
    runtimes: [
      runtime({ ...head, runtimeSessionRef: "wrong-context" }, async () => {}),
      runtime(finance, async () => {}), runtime(strategy, async () => {}), runtime(critic, async () => {})
    ]
  });
  assert.deepEqual(await mismatched.run({ sessionGeneration: 1, task: "x" }), { ok: false, code: "runtime_identity_mismatch", cause: "runtime_identity_mismatch" });

  const empty = new ConsiliumRouter({
    registrar,
    head,
    specialists: [finance, strategy],
    critic,
    runtimes: [runtime(head, async () => {}), runtime(finance, async () => {}), runtime(strategy, async () => {}), runtime(critic, async () => {})]
  });
  assert.deepEqual(await empty.run({ sessionGeneration: 1, task: "x" }), { ok: false, code: "initial_phase_failed", cause: "runtime_no_output" });
});

test("blocks a phase after append when a configured Matrix publication receipt is not obtained", async () => {
  const registrar = await activeRegistrar();
  const router = new ConsiliumRouter({
    registrar,
    head,
    specialists: [finance, strategy],
    critic,
    afterConfirmed: async () => { throw new Error("Matrix unavailable"); },
    runtimes: [
      runtime(head, async () => {}),
      runtime(finance, async (_input, emit) => { await emit({ messageId: "router-publish-0001", kind: "initial_position", toAgentId: critic.agentId, body: "Повна позиція." }); }),
      runtime(strategy, async (_input, emit) => { await emit({ messageId: "router-publish-0002", kind: "initial_position", toAgentId: critic.agentId, body: "Ще одна повна позиція." }); }),
      runtime(critic, async () => {})
    ]
  });
  assert.deepEqual(await router.run({ sessionGeneration: 1, task: "x" }), { ok: false, code: "initial_phase_failed", cause: "confirmed_delivery_rejected" });
});

test("rejects a duplicate specialist emission before it reaches the Registrar or delivery observer", async () => {
  const registrar = await activeRegistrar();
  const deliveredBodies: string[] = [];
  const router = new ConsiliumRouter({
    registrar,
    head,
    specialists: [finance, strategy],
    critic,
    afterConfirmed: async (message) => { deliveredBodies.push(message.body); },
    runtimes: [
      runtime(head, async () => {}),
      runtime(finance, async (_input, emit) => {
        await emit({ messageId: "duplicate-finance-first", kind: "initial_position", toAgentId: critic.agentId, body: "Перша дозволена позиція." });
        await emit({ messageId: "duplicate-finance-second", kind: "initial_position", toAgentId: critic.agentId, body: "Друга заборонена позиція." });
      }),
      runtime(strategy, async (_input, emit) => {
        await emit({ messageId: "duplicate-strategy-one", kind: "initial_position", toAgentId: critic.agentId, body: "Стратегічна позиція." });
      }),
      runtime(critic, async () => {})
    ]
  });

  assert.deepEqual(await router.run({ sessionGeneration: 1, task: "x" }), {
    ok: false,
    code: "initial_phase_failed",
    cause: "duplicate_runtime_emission"
  });
  const messages = await registrar.getConfirmedMessages(1);
  assert.equal(messages.filter((message) => message.body === "Перша дозволена позиція.").length, 1);
  assert.equal(messages.some((message) => message.body === "Друга заборонена позиція."), false);
  assert.equal(deliveredBodies.filter((body) => body === "Перша дозволена позиція.").length, 1);
  assert.equal(deliveredBodies.includes("Друга заборонена позиція."), false);
});

test("fails closed before runtime work when a historical speed-policy snapshot remains unapproved", async () => {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "unresolved-speed-settings",
    settingsRevision: 1,
    settings: receipt.defaults,
    capabilityReceipt: receipt,
    speedPolicyCatalog: UNAPPROVED_SPEED_POLICY_CATALOG
  }, activeNow);
  if (!snapshot.ok) throw new Error("Expected snapshot.");
  const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
  await registrar.startSession({ sessionId: "unresolved-speed-session", settingsSnapshot: snapshot.value });
  let runtimeCalls = 0;
  const router = new ConsiliumRouter({
    registrar,
    head,
    specialists: [finance, strategy],
    critic,
    runtimes: [head, finance, strategy, critic].map((registration) => runtime(registration, async () => { runtimeCalls += 1; }))
  });

  assert.deepEqual(await router.run({ sessionGeneration: 1, task: "x" }), {
    ok: false,
    code: "speed_policy_failed",
    cause: "speed_policy_unresolved"
  });
  assert.equal(runtimeCalls, 0);
  assert.deepEqual(await registrar.getConfirmedMessages(1), []);
});
