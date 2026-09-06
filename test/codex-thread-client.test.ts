import assert from "node:assert/strict";
import test from "node:test";

import { CodexConsiliumAgentRuntime } from "../src/runtime/codex-consilium-agent.ts";
import { CODEX_ANALYSIS_CONFIG, CodexAppServerThreadClient } from "../src/runtime/codex-thread-client.ts";
import { JsonRpcClient } from "../src/runtime/json-rpc-client.ts";

function appServerHarness(options: {
  holdTurn?: boolean;
  returnedModel?: string;
  onTurnStart?: (respond: (value: unknown) => void, message: Record<string, unknown>) => void | Promise<void>;
  onInterrupt?: (respond: (value: unknown) => void, message: Record<string, unknown>) => void;
} = {}) {
  const messages: Record<string, unknown>[] = [];
  let listener: ((line: string) => void) | undefined;
  const send = async (line: string): Promise<void> => {
    const message = JSON.parse(line) as Record<string, unknown>;
    messages.push(message);
    const respond = (body: unknown): void => listener?.(JSON.stringify(body));
    if (message.method === "initialize") respond({ id: message.id, result: {} });
    if (message.method === "thread/unsubscribe") respond({ id: message.id, result: {} });
    if (message.method === "turn/interrupt") {
      if (options.onInterrupt !== undefined) options.onInterrupt(respond, message);
      else respond({ id: message.id, result: {} });
    }
    if (message.method === "thread/start") respond({ id: message.id, result: { thread: { id: "thread-specialist-01" }, ...(options.returnedModel === undefined ? {} : { model: options.returnedModel }) } });
    if (message.method === "turn/start") {
      if (options.onTurnStart !== undefined) { await options.onTurnStart(respond, message); return; }
      respond({ id: message.id, result: { turn: { id: "turn-specialist-0001", status: "inProgress", items: [] } } });
      if (options.holdTurn) return;
      queueMicrotask(() => respond({
        method: "item/completed",
        params: { threadId: "thread-specialist-01", turnId: "turn-specialist-0001", item: { type: "agentMessage", id: "item-1", text: "Повна позиція агента." } }
      }));
      queueMicrotask(() => respond({
        method: "turn/completed",
        params: { threadId: "thread-specialist-01", turn: { id: "turn-specialist-0001", status: "completed", items: [] } }
      }));
    }
  };
  const channel = {
    send,
    onLine(next: (line: string) => void): () => void {
      listener = next;
      return () => { listener = undefined; };
    }
  };
  return { messages, rpc: new JsonRpcClient({ channel, experimentalApi: true }) };
}

test("starts one real Codex thread and preserves only the completed agent message", async () => {
  const harness = appServerHarness();
  const client = new CodexAppServerThreadClient({
    rpc: harness.rpc,
    clientInfo: { name: "personal-consultant", title: "Personal Consultant", version: "0.1.0" }
  });
  const thread = await client.startIsolatedThread({ modelId: "catalog-only-model" });
  if (!thread.ok) throw new Error("Expected thread.");
  assert.equal(thread.value.threadId, "thread-specialist-01");
  assert.equal(thread.value.modelId, "catalog-only-model");
  assert.match(thread.value.cwd!, /personal-consilium-/);
  const turn = await client.runTextTurn({ lease: thread.value, body: "Завдання.", reasoningEffort: "high" });
  assert.deepEqual(turn, { ok: true, turnId: "turn-specialist-0001", body: "Повна позиція агента." });
  assert.deepEqual(harness.messages.map((message) => message.method), ["initialize", "initialized", "thread/start", "turn/start"]);
  assert.deepEqual(harness.messages[2], {
    jsonrpc: "2.0",
    id: 2,
    method: "thread/start",
    params: { model: "catalog-only-model", ephemeral: true, cwd: thread.value.cwd, sandbox: "read-only", approvalPolicy: "never", environments: [], config: CODEX_ANALYSIS_CONFIG }
  });
  assert.deepEqual(harness.messages.at(-1), {
    jsonrpc: "2.0",
    id: 3,
    method: "turn/start",
    params: {
      threadId: "thread-specialist-01",
      input: [{ type: "text", text: "Завдання.", text_elements: [] }],
      model: "catalog-only-model",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      environments: [],
      effort: "high"
    }
  });
  await client.releaseThread(thread.value);
  harness.rpc.close();
});

test("interrupts an in-flight turn on cancellation or timeout and releases its context", async () => {
  for (const mode of ["cancel", "timeout"] as const) {
    const harness = appServerHarness({ holdTurn: true });
    const client = new CodexAppServerThreadClient({ rpc: harness.rpc, clientInfo: { name: "test", title: "Test", version: "1" } });
    const thread = await client.startIsolatedThread({ modelId: "gpt-6-astra" });
    if (!thread.ok) throw new Error("Expected fresh thread.");
    const controller = new AbortController();
    const pending = client.runTextTurn({ lease: thread.value, body: "Critique only.", reasoningEffort: "xhigh", timeoutMilliseconds: mode === "timeout" ? 5 : 100, signal: controller.signal });
    const abort = mode === "cancel" ? setTimeout(() => controller.abort(), 5) : undefined;
    const result = await pending;
    if (abort !== undefined) clearTimeout(abort);
    assert.deepEqual(result, { ok: false, code: mode === "cancel" ? "turn_cancelled" : "turn_timeout" });
    const interrupts = harness.messages.filter((message) => message.method === "turn/interrupt");
    assert.equal(interrupts.length, 1);
    assert.deepEqual(interrupts[0]?.params, { threadId: "thread-specialist-01", turnId: "turn-specialist-0001" });
    await client.releaseThread(thread.value);
    assert.equal(harness.messages.at(-1)?.method, "thread/unsubscribe");
    assert.deepEqual(await client.runTextTurn({ lease: thread.value, body: "Must not restart released work", reasoningEffort: "xhigh" }), { ok: false, code: "invalid_turn_response" });
    harness.rpc.close();
  }
});

test("rejects and unsubscribes a thread when the server silently substitutes a different model", async () => {
  const harness = appServerHarness({ returnedModel: "other-model" });
  const client = new CodexAppServerThreadClient({ rpc: harness.rpc, clientInfo: { name: "test", title: "Test", version: "1" } });
  assert.deepEqual(await client.startIsolatedThread({ modelId: "gpt-6-astra" }), { ok: false, code: "invalid_thread_response" });
  assert.equal(harness.messages.at(-1)?.method, "thread/unsubscribe");
  assert.equal(harness.messages.some((message) => message.method === "turn/start"), false);
  harness.rpc.close();
});

test("cancellation or release while turn/start is pending wins over a completed start response", async () => {
  for (const mode of ["abort", "release"] as const) {
    const controller = new AbortController();
    let client!: CodexAppServerThreadClient;
    let lease!: { threadId: string; modelId: string; cwd?: string };
    const harness = appServerHarness({ onTurnStart: async (respond, message) => {
      if (mode === "abort") controller.abort();
      else await client.releaseThread(lease);
      respond({ id: message.id, result: { turn: { id: "turn-specialist-0001", status: "completed", items: [{ type: "agentMessage", text: "Must not accept this completed reply" }] } } });
    } });
    client = new CodexAppServerThreadClient({ rpc: harness.rpc, clientInfo: { name: "test", title: "Test", version: "1" } });
    const thread = await client.startIsolatedThread({ modelId: "gpt-6-astra" });
    if (!thread.ok) throw new Error("Expected thread");
    lease = thread.value;
    assert.deepEqual(await client.runTextTurn({ lease, body: "Only critique", reasoningEffort: "xhigh", signal: controller.signal }), { ok: false, code: "turn_cancelled" });
    assert.equal(harness.messages.filter((message) => message.method === "turn/interrupt").length, 1);
    await client.releaseThread(lease);
    harness.rpc.close();
  }
});

test("pre-start buffering ignores unrelated threads and fails closed on excessive own-thread events", async () => {
  for (const unrelated of [true, false]) {
    const harness = appServerHarness({ onTurnStart: (respond, message) => {
      for (let i = 0; i < 300; i++) respond({ method: "item/completed", params: {
        threadId: unrelated ? "thread-another" : "thread-specialist-01", turnId: "turn-specialist-0001",
        item: { type: "agentMessage", text: "bounded message" }
      } });
      respond({ id: message.id, result: { turn: { id: "turn-specialist-0001", status: "completed", items: [{ type: "agentMessage", text: "Actual completed reply" }] } } });
    } });
    const client = new CodexAppServerThreadClient({ rpc: harness.rpc, clientInfo: { name: "test", title: "Test", version: "1" } });
    const thread = await client.startIsolatedThread({ modelId: "gpt-6-astra" });
    if (!thread.ok) throw new Error("Expected thread");
    const result = await client.runTextTurn({ lease: thread.value, body: "Critique", reasoningEffort: "xhigh" });
    assert.equal(result.ok, unrelated);
    if (!unrelated) assert.deepEqual(result, { ok: false, code: "invalid_turn_response" });
    await client.releaseThread(thread.value);
    harness.rpc.close();
  }
});

test("cancellation wins a simultaneous normal completion; failed interruption invokes managed-process shutdown", async () => {
  for (const failedInterrupt of [false, true]) {
    let shutdownCalls = 0;
    const harness = appServerHarness({ holdTurn: true, onInterrupt: (respond, message) => {
      if (failedInterrupt) respond({ id: message.id, error: { code: -1, message: "interrupt failed" } });
      else {
        respond({ method: "turn/completed", params: { threadId: "thread-specialist-01", turn: { id: "turn-specialist-0001", status: "completed", items: [{ type: "agentMessage", text: "Too late" }] } } });
        respond({ id: message.id, result: {} });
      }
    } });
    const client = new CodexAppServerThreadClient({ rpc: harness.rpc, clientInfo: { name: "test", title: "Test", version: "1" }, onUnresponsive: async () => { shutdownCalls++; } });
    const thread = await client.startIsolatedThread({ modelId: "gpt-6-astra" });
    if (!thread.ok) throw new Error("Expected thread");
    assert.deepEqual(await client.runTextTurn({ lease: thread.value, body: "Critique", reasoningEffort: "xhigh", timeoutMilliseconds: 5 }), { ok: false, code: "turn_timeout" });
    assert.equal(shutdownCalls, failedInterrupt ? 1 : 0);
    await client.releaseThread(thread.value);
    harness.rpc.close();
  }
});

test("a registered Codex specialist cannot substitute a role label for a different app-server thread", () => {
  const harness = appServerHarness();
  const client = new CodexAppServerThreadClient({
    rpc: harness.rpc,
    clientInfo: { name: "personal-consultant", title: "Personal Consultant", version: "0.1.0" }
  });
  assert.throws(() => new CodexConsiliumAgentRuntime({
    registration: { agentId: "finance", role: "Фінансовий консультант", provider: "codex", runtimeSessionRef: "not-the-thread" },
    lease: { threadId: "thread-specialist-01", modelId: "catalog-only-model" },
    threadClient: client,
    criticAgentId: "critic",
    headAgentId: "head",
    reasoningEffort: "high"
  }), /own real app-server thread/);
  harness.rpc.close();
});
