import assert from "node:assert/strict";
import test from "node:test";
import { access } from "node:fs/promises";

import { ConsiliumSessionLauncher, executePreparedConsilium } from "../src/consilium/session-launcher.ts";
import type { ClaudeCodeSubscriptionProcess } from "../src/runtime/claude-code-critic.ts";
import { CodexAppServerThreadClient } from "../src/runtime/codex-thread-client.ts";
import { JsonRpcClient } from "../src/runtime/json-rpc-client.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { activeNow, createCapabilityReceipt, createResolvedTestSpeedPolicyCatalog } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";

function codexHarness(options: { failThreadAt?: number } = {}) {
  const sent: Record<string, unknown>[] = [];
  const threadIds = ["thread-head-01", "thread-finance-01", "thread-strategy-01", "thread-critic-01"];
  let threadIndex = 0;
  let turnIndex = 0;
  const turnsByThread = new Map<string, number>();
  let listener: ((line: string) => void) | undefined;
  const channel = {
    send: async (line: string): Promise<void> => {
      const message = JSON.parse(line) as Record<string, unknown>;
      sent.push(message);
      const response = (value: unknown): void => listener?.(JSON.stringify(value));
      if (message.method === "initialize") response({ id: message.id, result: {} });
      if (message.method === "thread/unsubscribe" || message.method === "turn/interrupt") response({ id: message.id, result: {} });
      if (message.method === "account/read") response({ id: message.id, result: { account: { type: "chatgpt" } } });
      if (message.method === "model/list") response({ id: message.id, result: { data: [{
        id: "codex-current-primary", model: "codex-runtime-primary", displayName: "Codex", hidden: false, isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }]
      }, { id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", hidden: true, isDefault: false,
        supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "xhigh" }]
      }] } });
      if (message.method === "account/rateLimits/read") response({ id: message.id, result: { rateLimits: { rateLimitReachedType: null } } });
      if (message.method === "thread/start") {
        if (threadIndex === options.failThreadAt) response({ id: message.id, error: { code: -1, message: "failed to start" } });
        else response({ id: message.id, result: { thread: { id: threadIds[threadIndex++] } } });
      }
      if (message.method === "turn/start") {
        const params = message.params as { threadId: string };
        const turnId = `turn-${params.threadId}-${++turnIndex}`;
        const threadIteration = (turnsByThread.get(params.threadId) ?? 0) + 1;
        turnsByThread.set(params.threadId, threadIteration);
        const body = params.threadId === "thread-head-01"
          ? JSON.stringify({
              decision: "Синтезоване рішення.",
              actions: [{ action: "Зробити першу дію", owner: "Власник", timeframe: "Сьогодні", evidence: "Є перший факт." }],
              riskOrAssumption: "Потрібна перевірка попиту.",
              reviewCondition: "Переглянути після першого факту."
            })
          : `Повна позиція ${params.threadId}, ітерація ${threadIteration}.`;
        response({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
        queueMicrotask(() => response({ method: "item/completed", params: {
          threadId: params.threadId, turnId, item: { type: "agentMessage", id: `item-${turnId}`, text: body }
        } }));
        queueMicrotask(() => response({ method: "turn/completed", params: {
          threadId: params.threadId, turn: { id: turnId, status: "completed", items: [] }
        } }));
      }
    },
    onLine(next: (line: string) => void): () => void {
      listener = next;
      return () => { listener = undefined; };
    }
  };
  return { sent, client: new CodexAppServerThreadClient({
    rpc: new JsonRpcClient({ channel, experimentalApi: true }),
    clientInfo: { name: "personal-consultant", title: "Personal Consultant", version: "0.1.0" }
  }) };
}

async function activeRegistrar(receipt = createCapabilityReceipt()) {
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "launch-settings",
    settingsRevision: 1,
    settings: receipt.defaults,
    capabilityReceipt: receipt,
    speedPolicyCatalog: createResolvedTestSpeedPolicyCatalog()
  }, activeNow);
  if (!snapshot.ok) throw new Error("Expected snapshot.");
  const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
  const started = await registrar.startSession({ sessionId: "launch-session", settingsSnapshot: snapshot.value });
  if (!started.ok) throw new Error("Expected active registrar.");
  return { registrar, snapshot: snapshot.value };
}

function claude(overrides: Record<string, unknown> = {}): ClaudeCodeSubscriptionProcess {
  const receipt = createCapabilityReceipt();
  return {
    inspectSubscription: async () => ({
      processRef: "claude-critic-process-01", authMode: "claude_code_oauth" as const, readiness: "ready" as const,
      privateSingleOwner: true, bareMode: false, fastModeEnabled: false, extraUsageEnabled: false,
      models: receipt.claudeModels, ...overrides
    }),
    runCritique: async () => ({ turnRef: "claude-critic-turn-001", body: "Повна критика двох позицій." })
  };
}

test("preflights before it creates a head, two real specialist threads and one isolated Claude critic", async () => {
  const receipt = createCapabilityReceipt();
  const { registrar, snapshot } = await activeRegistrar(receipt);
  const harness = codexHarness();
  const launcher = new ConsiliumSessionLauncher({
    registrar, codex: harness.client, claude: claude(), environment: { RUNTIME_MODE: "test" }, privateSingleOwner: true, now: () => activeNow
  });
  const prepared = await launcher.prepare({
    snapshot, capabilityReceipt: receipt,
    head: { agentId: "head", role: "Головний консультант" },
    specialists: [{ agentId: "finance", role: "Фінансовий консультант" }, { agentId: "strategy", role: "Стратег" }],
    critic: { agentId: "critic", role: "Критик" }
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("Expected prepared consilium.");
  assert.deepEqual(prepared.value.head.registration.runtimeSessionRef, "thread-head-01");
  assert.deepEqual(prepared.value.specialists.map((agent) => agent.runtimeSessionRef), ["thread-finance-01", "thread-strategy-01"]);
  assert.equal(prepared.value.critic.runtimeSessionRef, "claude-critic-process-01");
  assert.equal(harness.sent.filter((message) => message.method === "thread/start").length, 3);
  const run = await prepared.value.router.run({ sessionGeneration: 1, task: "Дай практичну рекомендацію." });
  assert.equal(run.ok, true);
  if (!run.ok) throw new Error("Expected routed consilium.");
  assert.deepEqual([...run.assignmentVisibleSequences].sort((left, right) => left - right), [1, 4, 6]);
  assert.deepEqual([...run.initialVisibleSequences].sort((left, right) => left - right), [2, 3]);
  assert.equal(run.critiqueVisibleSequence, 5);
  assert.deepEqual([...run.revisionVisibleSequences].sort((left, right) => left - right), [7, 8]);
  const messages = await registrar.getConfirmedMessages(1);
  assert.deepEqual(new Set(messages.slice(1, 3).map((message) => message.body)), new Set([
    "Повна позиція thread-finance-01, ітерація 1.", "Повна позиція thread-strategy-01, ітерація 1."
  ]));
  assert.equal(messages[4]?.body, "Повна критика двох позицій.");
  assert.deepEqual(new Set(messages.slice(6).map((message) => message.body)), new Set([
    "Повна позиція thread-finance-01, ітерація 2.", "Повна позиція thread-strategy-01, ітерація 2."
  ]));
  await prepared.value.cleanup();
});

test("does not create even one Codex thread when the Claude preflight is ineligible", async () => {
  const receipt = createCapabilityReceipt();
  const { registrar, snapshot } = await activeRegistrar(receipt);
  const harness = codexHarness();
  const launcher = new ConsiliumSessionLauncher({
    registrar, codex: harness.client, claude: claude({ fastModeEnabled: true }), environment: { RUNTIME_MODE: "test" }, privateSingleOwner: true, now: () => activeNow
  });
  const result = await launcher.prepare({
    snapshot, capabilityReceipt: receipt,
    head: { agentId: "head", role: "Головний консультант" },
    specialists: [{ agentId: "finance", role: "Фінансовий консультант" }, { agentId: "strategy", role: "Стратег" }],
    critic: { agentId: "critic", role: "Критик" }
  });
  assert.deepEqual(result, { ok: false, code: "preflight_failed", preflightCode: "claude_paid_acceleration_forbidden" });
  assert.equal(harness.sent.filter((message) => message.method === "thread/start").length, 0);
});

test("executes the whole prepared path through finalization after the registered critic", async () => {
  const receipt = createCapabilityReceipt();
  const { registrar, snapshot } = await activeRegistrar(receipt);
  const harness = codexHarness();
  const launcher = new ConsiliumSessionLauncher({
    registrar, codex: harness.client, claude: claude(), environment: { RUNTIME_MODE: "test" }, privateSingleOwner: true, now: () => activeNow
  });
  const prepared = await launcher.prepare({
    snapshot, capabilityReceipt: receipt,
    head: { agentId: "head", role: "Головний консультант" },
    specialists: [{ agentId: "finance", role: "Фінансовий консультант" }, { agentId: "strategy", role: "Стратег" }],
    critic: { agentId: "critic", role: "Критик" }
  });
  if (!prepared.ok) throw new Error("Expected prepared consilium.");
  const result = await executePreparedConsilium({ prepared: prepared.value, sessionGeneration: 1, task: "Дай рішення." });
  assert.equal(result.ok, true);
  const messages = await registrar.getConfirmedMessages(1);
  assert.equal(messages.length, 9);
  assert.match(messages[8]?.body ?? "", /Синтезоване рішення/);
  assert.equal((await registrar.getActiveSession())?.phase, "closed");
});

function astraReceipt() {
  const base = createCapabilityReceipt();
  return createCapabilityReceipt({
    codexModels: [...base.codexModels, { productId: "gpt-6-astra", displayName: "GPT-6 Astra", runtimeModelId: "gpt-6-astra", availability: "available", supportedReasoningEfforts: ["high", "xhigh"], reasoningMappings: { high: "high", xhigh: "xhigh" } }],
    claudeModels: [],
    defaults: { ...base.defaults, critic: { provider: "codex", codex: { modelId: "gpt-6-astra", reasoningEffort: "xhigh" }, claude: null } }
  });
}

const roleInput = {
  head: { agentId: "head", role: "Головний консультант" },
  specialists: [{ agentId: "finance", role: "Фінансовий консультант" }, { agentId: "strategy", role: "Стратег" }],
  critic: { agentId: "critic", role: "Критик" }
};

test("Astra Extra High critic uses a fourth fresh read-only workspace, independent head settings and no Claude dependency", async () => {
  const receipt = astraReceipt();
  const { registrar, snapshot } = await activeRegistrar(receipt);
  const harness = codexHarness();
  let claudeCalls = 0;
  const inactiveClaude = {
    inspectSubscription: async () => { claudeCalls++; throw new Error("expired subscription: must not be inspected"); },
    runCritique: async () => { claudeCalls++; throw new Error("must never send business data"); }
  };
  const launcher = new ConsiliumSessionLauncher({ registrar, codex: harness.client, claude: inactiveClaude, environment: {}, privateSingleOwner: true, now: () => activeNow });
  const prepared = await launcher.prepare({ snapshot, capabilityReceipt: receipt, ...roleInput });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("Expected Codex route.");
  const starts = harness.sent.filter((message) => message.method === "thread/start").map((message) => message.params as Record<string, unknown>);
  assert.equal(starts.length, 4);
  assert.equal(new Set(starts.map((params) => params.cwd)).size, 4);
  assert.deepEqual(starts.map((params) => params.model), ["codex-runtime-primary", "codex-runtime-primary", "codex-runtime-primary", "gpt-6-astra"]);
  assert.ok(starts.every((params) => params.sandbox === "read-only" && params.approvalPolicy === "never" && params.ephemeral === true));
  assert.equal(harness.sent.some((message) => message.method === "thread/fork"), false);
  assert.ok(starts.every((params) => JSON.stringify(params.environments) === "[]"));
  assert.ok(starts.every((params) => (params.config as { features: { shell_tool: boolean } }).features.shell_tool === false));
  const result = await executePreparedConsilium({ prepared: prepared.value, sessionGeneration: 1, task: "Повне завдання для консиліуму." });
  assert.equal(result.ok, true);
  const turns = harness.sent.filter((message) => message.method === "turn/start").map((message) => message.params as Record<string, unknown>);
  const criticTurn = turns.find((params) => params.threadId === "thread-critic-01");
  assert.equal(criticTurn?.model, "gpt-6-astra");
  assert.equal(criticTurn?.effort, "xhigh");
  assert.ok(turns.filter((params) => params.threadId !== "thread-critic-01").every((params) => params.model === "codex-runtime-primary" && params.effort === "high"));
  const messages = await registrar.getConfirmedMessages(1);
  assert.equal(messages[4]?.authority?.agentId, "critic");
  assert.equal(messages[4]?.authority?.provider, "codex");
  assert.equal(messages[4]?.body, "Повна позиція thread-critic-01, ітерація 1.");
  assert.equal(messages.at(-1)?.role, "Головний консультант");
  assert.equal(claudeCalls, 0);
  assert.equal(harness.sent.filter((message) => message.method === "thread/unsubscribe").length, 4);
  for (const params of starts) await assert.rejects(access(params.cwd as string));
});

test("a partial thread-start failure releases already created contexts and owned workspaces", async () => {
  const receipt = astraReceipt();
  const { registrar, snapshot } = await activeRegistrar(receipt);
  const harness = codexHarness({ failThreadAt: 2 });
  const launcher = new ConsiliumSessionLauncher({ registrar, codex: harness.client, environment: {}, privateSingleOwner: true, now: () => activeNow });
  assert.deepEqual(await launcher.prepare({ snapshot, capabilityReceipt: receipt, ...roleInput }), { ok: false, code: "codex_thread_start_failed" });
  assert.equal(harness.sent.filter((message) => message.method === "thread/unsubscribe").length, 2);
  for (const message of harness.sent.filter((message) => message.method === "thread/start")) {
    await assert.rejects(access((message.params as { cwd: string }).cwd));
  }
  assert.deepEqual(await registrar.getConfirmedMessages(1), []);
});

test("cancellation before execution closes every prepared context without sending business content", async () => {
  const receipt = astraReceipt();
  const { registrar, snapshot } = await activeRegistrar(receipt);
  const harness = codexHarness();
  const launcher = new ConsiliumSessionLauncher({ registrar, codex: harness.client, environment: {}, privateSingleOwner: true, now: () => activeNow });
  const prepared = await launcher.prepare({ snapshot, capabilityReceipt: receipt, ...roleInput });
  if (!prepared.ok) throw new Error("Expected Codex route.");
  const controller = new AbortController();
  controller.abort();
  const result = await executePreparedConsilium({ prepared: prepared.value, sessionGeneration: 1, task: "Не надсилати", signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(harness.sent.filter((message) => message.method === "turn/start").length, 0);
  assert.equal(harness.sent.filter((message) => message.method === "thread/unsubscribe").length, 4);
});
