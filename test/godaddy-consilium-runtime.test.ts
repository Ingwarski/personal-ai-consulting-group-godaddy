import assert from "node:assert/strict";
import test from "node:test";
import { access } from "node:fs/promises";
import { createGoDaddyConsiliumRuntime, type GoDaddyConsiliumRequest } from "../src/godaddy/consilium-runtime.ts";
import { createGoDaddyApplicationRuntime } from "../src/godaddy/application-runtime.ts";
import type { GoDaddyRegistrarRuntime } from "../src/godaddy/registrar-runtime.ts";
import type { RuntimeBootstrap } from "../src/godaddy/runtime-bootstrap.ts";
import { MySqlMatrixIngressReceipts, MySqlMatrixOutbox } from "../src/godaddy/mysql-matrix-outbox.ts";
import { CodexAppServerThreadClient } from "../src/runtime/codex-thread-client.ts";
import { JsonRpcClient } from "../src/runtime/json-rpc-client.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import type { ConfirmedAgentMessage } from "../src/session/registrar-do.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { activeNow, createCapabilityReceipt, createResolvedTestSpeedPolicyCatalog } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";

const request: GoDaddyConsiliumRequest = {
  sessionGeneration: 1, task: "Порівняти варіанти й ухвалити практичне рішення.",
  head: { agentId: "head", role: "Головний консультант" },
  specialists: [{ agentId: "finance", role: "Фінансовий консультант" }, { agentId: "strategy", role: "Стратег" }],
  critic: { agentId: "critic", role: "Критик" }
};
const productionEnvironment = {
  RUNTIME_MODE: "production", GODADDY_STATE_DATABASE_ROLE: "published", DB_HOST: "db.invalid",
  DB_PORT: "3306", DB_NAME: "test_only", DB_USER: "test_only", DB_PASSWORD: "fixture-only"
};

async function fixture(input: { approved?: boolean; missingSession?: boolean; missingCatalog?: boolean; holdTurns?: boolean } = {}) {
  const base = createCapabilityReceipt();
  const receipt = createCapabilityReceipt({ codexModels: [...base.codexModels, {
    productId: "gpt-6-astra", runtimeModelId: "gpt-6-astra", displayName: "GPT-6 Astra", availability: "available",
    supportedReasoningEfforts: ["high", "xhigh"], reasoningMappings: { high: "high", xhigh: "xhigh" }
  }], claudeModels: [], defaults: { ...base.defaults, critic: {
    provider: "codex", claude: base.defaults.critic.claude, codex: { modelId: "gpt-6-astra", reasoningEffort: "xhigh" }
  } } });
  const snapshot = resolveEffectiveSessionSnapshot({ sessionId: "production-settings-snapshot", settingsRevision: 17,
    settings: receipt.defaults, capabilityReceipt: receipt,
    ...(input.approved === false ? {} : { speedPolicyCatalog: createResolvedTestSpeedPolicyCatalog() }) }, activeNow);
  if (!snapshot.ok) throw new Error("Invalid test snapshot");
  const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
  if (!input.missingSession) {
    const session = await registrar.startSession({ sessionId: "production-session", settingsSnapshot: snapshot.value });
    assert.equal(session.ok, true);
  }
  const sent: Record<string, unknown>[] = [];
  const confirmed: ConfirmedAgentMessage[] = [];
  const lifecycle: string[] = [];
  let loadCalls = 0;
  let clientCalls = 0;
  let claudeCalls = 0;
  let firstTurn = () => {};
  const turnStarted = new Promise<void>(resolve => { firstTurn = resolve; });
  let nextThread = 0;
  let nextTurn = 0;
  let listener: ((line: string) => void) | undefined;
  const channel = {
    onLine: (callback: (line: string) => void) => { listener = callback; return () => { listener = undefined; }; },
    send: async (line: string) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      sent.push(message);
      const reply = (result: unknown) => listener?.(JSON.stringify({ id: message.id, result }));
      if (message.method === "initialized") return;
      if (["initialize", "thread/unsubscribe", "turn/interrupt"].includes(String(message.method))) { reply({}); return; }
      if (message.method === "account/read") { reply({ account: { type: "chatgpt" } }); return; }
      if (message.method === "account/rateLimits/read") { reply({ rateLimits: { rateLimitReachedType: null } }); return; }
      if (message.method === "model/list") {
        reply({ data: receipt.codexModels.map(model => ({ id: model.productId, model: model.runtimeModelId,
          displayName: model.displayName, hidden: model.runtimeModelId === "gpt-6-astra",
          supportedReasoningEfforts: model.supportedReasoningEfforts.map(reasoningEffort => ({ reasoningEffort })) })) });
        return;
      }
      if (message.method === "thread/start") { reply({ thread: { id: `prod-thread-${++nextThread}` } }); return; }
      if (message.method === "turn/start") {
        const params = message.params as { threadId: string; model: string };
        firstTurn();
        const body = params.threadId === "prod-thread-1" ? JSON.stringify({ decision: "Перевірити попит до інвестицій.",
          actions: [{ action: "Провести інтерв'ю", owner: "Власник", timeframe: "Цього тижня", evidence: "П'ять відповідей" }],
          riskOrAssumption: "Попит ще не підтверджено.", reviewCondition: "Після п'яти відповідей." }) :
          params.model === "gpt-6-astra" ? "Повна критика Astra: перевірити припущення про попит." : "Повна первинна або уточнена позиція спеціаліста.";
        reply({ turn: { id: `prod-turn-${++nextTurn}`, status: input.holdTurns ? "inProgress" : "completed",
          items: input.holdTurns ? [] : [{ type: "agentMessage", text: body }] } });
        return;
      }
      throw new Error(`Unexpected fake RPC method: ${String(message.method)}`);
    }
  };
  const client = new CodexAppServerThreadClient({ rpc: new JsonRpcClient({ channel }),
    clientInfo: { name: "runtime-test", title: "Runtime test", version: "1" } });
  const pool = {
    execute: async (): Promise<readonly [unknown, unknown]> => { throw new Error("Test must not access MySQL"); },
    getConnection: async () => { throw new Error("Test must not access MySQL"); },
    end: async () => { lifecycle.push("pool.close"); }
  };
  const registrarRuntime: GoDaddyRegistrarRuntime = {
    registrar, matrixOutbox: new MySqlMatrixOutbox(pool), matrixIngressReceipts: new MySqlMatrixIngressReceipts(pool),
    matrixPublicationSynchronizer: {
      withPublicationPermit: async <T>(publish: () => Promise<T>) => publish(),
      withGenerationFence: async <T>(_fence: Readonly<{ generation: number }>, operation: () => Promise<T>) => operation()
    },
    afterConfirmed: async message => { confirmed.push(message); }, getActiveSessionSummary: async () => null
  };
  const bootstrap: RuntimeBootstrap = {
    loadCatalog: async () => { loadCalls++; return input.missingCatalog ? undefined : receipt; },
    getCodexThreadClient: async () => { clientCalls++; return client; },
    getClaudeProcess: () => { claudeCalls++; throw new Error("Inactive Claude must never be acquired"); },
    status: async () => { throw new Error("Runner uses selected preflight instead"); },
    refreshCatalog: async () => { throw new Error("No refresh authorized"); },
    startCodexDeviceAuthorization: async () => { throw new Error("No auth mutation authorized"); },
    resetCodexAuthorization: async () => { throw new Error("No auth mutation authorized"); }, close: async () => {}
  };
  const runtime = createGoDaddyConsiliumRuntime({ bootstrap, registrarRuntime, environment: productionEnvironment, now: () => activeNow });
  return { runtime, registrarRuntime, registrar, sent, confirmed, turnStarted, pool, lifecycle,
    calls: () => ({ loadCalls, clientCalls, claudeCalls }), snapshot: snapshot.value };
}

test("production application runner reaches fresh Astra critic, registered full critique and final through the shared registrar", async () => {
  const h = await fixture();
  let matrixReady = false;
  let readinessChecks = 0;
  const application = createGoDaddyApplicationRuntime({ environment: productionEnvironment }, {
    now: () => activeNow, createPool: () => h.pool, createRegistrarRuntime: () => h.registrarRuntime,
    createSettingsRuntime: (_environment, dependencies) => {
      assert.equal(dependencies.registrarRuntime, h.registrarRuntime);
      return { configured: true, consilium: h.runtime, handle: async () => undefined,
        close: async () => { h.lifecycle.push("providers.close"); await h.runtime.close(); } };
    },
    createMatrixService: () => ({ configured: true, start: async () => {}, wakeOutbox: () => {},
      getReadiness: () => ({ configured: true, ready: matrixReady, reason: matrixReady ? "ready" : "blocked" }),
      assertReadyForNewSession: () => { readinessChecks++; if (!matrixReady) throw new Error("Matrix/E2EE not ready"); },
      stop: async () => { h.lifecycle.push("matrix.close"); }
    })
  });
  assert.deepEqual(await application.runConsilium?.(request), { ok: false, code: "runtime_unavailable" });
  assert.deepEqual(h.calls(), { loadCalls: 0, clientCalls: 0, claudeCalls: 0 });
  matrixReady = true;
  const result = await application.runConsilium?.(request);
  assert.equal(result?.ok, true);
  assert.equal(readinessChecks, 2);
  const messages = await h.registrar.getConfirmedMessages(1);
  assert.equal(messages.length, 11);
  assert.equal(h.confirmed.length, 11);
  assert.equal(messages[5]?.authority?.agentId, "critic");
  assert.equal(messages[5]?.authority?.provider, "codex");
  assert.equal(messages[5]?.authority?.runtimeSessionRef, "prod-thread-4");
  assert.equal(messages[5]?.body, "Повна критика Astra: перевірити припущення про попит.");
  assert.match(messages.at(-1)?.body ?? "", /Перевірити попит до інвестицій/u);
  assert.equal((await h.registrar.getActiveSession())?.phase, "stopped");
  assert.deepEqual((await h.registrar.getActiveSession())?.settingsSnapshot, h.snapshot);
  const turns = h.sent.filter(message => message.method === "turn/start").map(message => message.params as Record<string, unknown>);
  assert.ok(turns.some(turn => turn.model === "gpt-6-astra" && turn.effort === "xhigh"));
  assert.ok(turns.filter(turn => turn.threadId !== "prod-thread-4").every(turn => turn.model === "codex-runtime-primary" && turn.effort === "high"));
  assert.equal(h.sent.some(message => message.method === "thread/fork"), false);
  assert.equal(h.calls().claudeCalls, 0);
  // Pending turn/start may require a second unsubscribe after its reply;
  // every distinct owned thread must be released, including that race.
  assert.equal(new Set(h.sent.filter(message => message.method === "thread/unsubscribe").map(message => (message.params as { threadId: string }).threadId)).size, 4);
  for (const start of h.sent.filter(message => message.method === "thread/start")) await assert.rejects(access((start.params as { cwd: string }).cwd));
  await application.stop();
  assert.deepEqual(h.lifecycle, ["matrix.close", "providers.close", "pool.close"]);
  assert.deepEqual(await application.runConsilium?.(request), { ok: false, code: "runtime_unavailable" });
});

test("unapproved speed policy, missing or stale generation fail before any catalog or provider acquisition", async () => {
  for (const [options, nextRequest, code] of [
    [{ approved: false }, request, "speed_policy_unresolved"],
    [{ missingSession: true }, request, "session_unavailable"],
    [{}, { ...request, sessionGeneration: 2 }, "session_unavailable"]
  ] as const) {
    const h = await fixture(options);
    assert.deepEqual(await h.runtime.run(nextRequest), { ok: false, code });
    assert.deepEqual(h.calls(), { loadCalls: 0, clientCalls: 0, claudeCalls: 0 });
    assert.equal(h.sent.length, 0);
    await h.runtime.close();
  }
});

test("missing catalog and invalid task fail without provider turns", async () => {
  const h = await fixture({ missingCatalog: true });
  assert.deepEqual(await h.runtime.run({ ...request, task: " " }), { ok: false, code: "invalid_task" });
  assert.deepEqual(await h.runtime.run({ ...request, task: "x".repeat(32_001) }), { ok: false, code: "invalid_task" });
  assert.deepEqual(await h.runtime.run(request), { ok: false, code: "catalog_unavailable" });
  assert.deepEqual(h.calls(), { loadCalls: 1, clientCalls: 0, claudeCalls: 0 });
  await h.runtime.close();
});

test("duplicate generation cannot start another run; close interrupts live turns and releases every context", async () => {
  const h = await fixture({ holdTurns: true });
  const running = h.runtime.run(request);
  await h.turnStarted;
  assert.deepEqual(await h.runtime.run(request), { ok: false, code: "session_busy" });
  assert.equal(h.calls().clientCalls, 1);
  await h.runtime.close();
  assert.equal((await running).ok, false);
  assert.ok(h.sent.some(message => message.method === "turn/interrupt"));
  assert.equal(new Set(h.sent.filter(message => message.method === "thread/unsubscribe").map(message => (message.params as { threadId: string }).threadId)).size, 4);
  for (const start of h.sent.filter(message => message.method === "thread/start")) await assert.rejects(access((start.params as { cwd: string }).cwd));
  assert.deepEqual(await h.runtime.run(request), { ok: false, code: "runtime_unavailable" });
});

test("caller cancellation before acquisition produces no runtime effects", async () => {
  const h = await fixture();
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(await h.runtime.run({ ...request, signal: abort.signal }), { ok: false, code: "runtime_unavailable" });
  assert.deepEqual(h.calls(), { loadCalls: 0, clientCalls: 0, claudeCalls: 0 });
  assert.equal(h.sent.length, 0);
  await h.runtime.close();
});
