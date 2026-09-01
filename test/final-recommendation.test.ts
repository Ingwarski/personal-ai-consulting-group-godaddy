import assert from "node:assert/strict";
import test from "node:test";

import { routeA2AEnvelope } from "../src/consilium/a2a.ts";
import { CriticGatedFinalizer, formatFinalRecommendation } from "../src/consilium/final-recommendation.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";

const head = { agentId: "head", role: "Головний консультант", provider: "codex" as const, runtimeSessionRef: "codex-thread-head" };
const finance = { agentId: "finance", role: "Фінансовий консультант", provider: "codex" as const, runtimeSessionRef: "codex-thread-finance" };
const critic = { agentId: "critic", role: "Критик", provider: "claude_code" as const, runtimeSessionRef: "claude-process-critic" };

const recommendation = {
  decision: "Зупинити витрати, що не дають результату, до контрольної точки.",
  actions: [{ action: "Перевірити cash runway", owner: "Власник", timeframe: "Сьогодні", evidence: "Оновлена таблиця руху коштів" }],
  riskOrAssumption: "Дані про доходи за поточний місяць ще неповні.",
  reviewCondition: "Переглянути рішення після надходження фактичних оплат."
};

async function startedRegistrar(): Promise<RegistrarDO> {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "final-snapshot-source",
    settingsRevision: 1,
    settings: receipt.defaults,
    capabilityReceipt: receipt
  }, activeNow);
  if (!snapshot.ok) throw new Error("Snapshot must resolve.");
  const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
  await registrar.startSession({ sessionId: "final-task", settingsSnapshot: snapshot.value });
  return registrar;
}

test("does not emit a final conclusion before a real Claude critic message is registered", async () => {
  const registrar = await startedRegistrar();
  const finalizer = new CriticGatedFinalizer({ registrar, head, critic });

  assert.deepEqual(await finalizer.publish({
    sessionGeneration: 1,
    messageId: "final-message-0001",
    recommendation
  }), { ok: false, code: "critic_not_ready" });
  assert.deepEqual(await registrar.getConfirmedMessages(1), []);
});

test("does not mistake an ordinary critic message for a registered critique", async () => {
  const registrar = await startedRegistrar();
  const finalizer = new CriticGatedFinalizer({ registrar, head, critic });
  const roster = [head, finance, critic] as const;
  const initial = await routeA2AEnvelope(registrar, roster, {
    messageId: "critic-position-0001",
    sessionGeneration: 1,
    fromAgentId: critic.agentId,
    toAgentId: head.agentId,
    kind: "initial_position",
    body: "Моя первинна позиція до перевірки інших висновків."
  });
  assert.equal(initial.ok, true);

  assert.deepEqual(await finalizer.publish({
    sessionGeneration: 1,
    messageId: "final-message-0004",
    recommendation
  }), { ok: false, code: "critic_not_ready" });
});

test("publishes a compact structured final only after the critic body is visibly registered, then fences late output", async () => {
  const registrar = await startedRegistrar();
  const finalizer = new CriticGatedFinalizer({ registrar, head, critic });
  const roster = [head, finance, critic] as const;

  const criticRoute = await routeA2AEnvelope(registrar, roster, {
    messageId: "critic-message-0001",
    sessionGeneration: 1,
    fromAgentId: critic.agentId,
    toAgentId: head.agentId,
    kind: "critique",
    body: "Ризик недостатньо перевірений; потрібна контрольна точка."
  });
  assert.equal(criticRoute.ok, true);

  const published = await finalizer.publish({
    sessionGeneration: 1,
    messageId: "final-message-0002",
    recommendation
  });
  assert.deepEqual(published, { ok: true, visibleSequence: 2, replayed: false });
  assert.equal((await registrar.getConfirmedMessages(1))[1]?.body, formatFinalRecommendation(recommendation));

  const late = await routeA2AEnvelope(registrar, roster, {
    messageId: "late-message-0001",
    sessionGeneration: 1,
    fromAgentId: finance.agentId,
    toAgentId: head.agentId,
    kind: "revision",
    body: "Це пізня репліка і вона не має бути додана."
  });
  assert.deepEqual(late, { ok: false, code: "registrar_rejected", cause: "session_not_active" });
});

test("refuses an incomplete final and never inserts a technical section unless it is explicitly supplied", async () => {
  const incomplete = { ...recommendation, actions: [recommendation.actions[0], recommendation.actions[0], recommendation.actions[0], recommendation.actions[0]] };
  const registrar = await startedRegistrar();
  const finalizer = new CriticGatedFinalizer({ registrar, head, critic });
  assert.deepEqual(await finalizer.publish({ sessionGeneration: 1, messageId: "final-message-0003", recommendation: incomplete }), {
    ok: false,
    code: "invalid_final_recommendation"
  });
  assert.doesNotMatch(formatFinalRecommendation(recommendation), /Технічна частина/);
});

test("does not let a Claude runtime impersonate the head who publishes the final", async () => {
  const registrar = await startedRegistrar();
  const finalizer = new CriticGatedFinalizer({ registrar, head: { ...head, provider: "claude_code" }, critic });
  assert.deepEqual(await finalizer.publish({ sessionGeneration: 1, messageId: "final-message-0005", recommendation }), {
    ok: false,
    code: "invalid_final_sender"
  });
});

test("keeps a confirmed final retryable until the Matrix delivery observer accepts its exact body", async () => {
  const registrar = await startedRegistrar();
  const roster = [head, finance, critic] as const;
  const criticRoute = await routeA2AEnvelope(registrar, roster, {
    messageId: "critic-message-0005", sessionGeneration: 1, fromAgentId: critic.agentId, toAgentId: head.agentId,
    kind: "critique", body: "Повна критика для фінального висновку."
  });
  assert.equal(criticRoute.ok, true);
  const seen: string[] = [];
  const finalizer = new CriticGatedFinalizer({
    registrar,
    head,
    critic,
    afterConfirmed: async (message) => { seen.push(message.body); }
  });

  const result = await finalizer.publish({ sessionGeneration: 1, messageId: "final-message-0006", recommendation });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [formatFinalRecommendation(recommendation)]);
  assert.equal((await registrar.getActiveSession())?.phase, "stopped");
});

test("keeps the final retryable until a whole-session close observer commits its archive", async () => {
  const registrar = await startedRegistrar();
  const roster = [head, finance, critic] as const;
  const criticRoute = await routeA2AEnvelope(registrar, roster, {
    messageId: "critic-message-0006", sessionGeneration: 1, fromAgentId: critic.agentId, toAgentId: head.agentId,
    kind: "critique", body: "Критика перед зашифрованим закриттям сесії."
  });
  assert.equal(criticRoute.ok, true);
  let attempts = 0;
  const finalizer = new CriticGatedFinalizer({
    registrar,
    head,
    critic,
    beforeStop: async ({ messages }) => {
      attempts += 1;
      assert.equal(messages.at(-1)?.body, formatFinalRecommendation(recommendation));
      if (attempts === 1) throw new Error("archive store unavailable");
    }
  });
  assert.deepEqual(await finalizer.publish({ sessionGeneration: 1, messageId: "final-message-0007", recommendation }), {
    ok: false, code: "archive_rejected"
  });
  assert.equal((await registrar.getActiveSession())?.phase, "active");
  assert.equal((await registrar.getConfirmedMessages(1)).length, 2);
  assert.deepEqual(await finalizer.publish({ sessionGeneration: 1, messageId: "final-message-0007", recommendation }), {
    ok: true, visibleSequence: 2, replayed: true
  });
  assert.equal(attempts, 2);
  assert.equal((await registrar.getActiveSession())?.phase, "stopped");
});
