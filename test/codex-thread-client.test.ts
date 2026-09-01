import assert from "node:assert/strict";
import test from "node:test";

import { CodexConsiliumAgentRuntime } from "../src/runtime/codex-consilium-agent.ts";
import { CodexAppServerThreadClient } from "../src/runtime/codex-thread-client.ts";
import { JsonRpcClient } from "../src/runtime/json-rpc-client.ts";

function appServerHarness() {
  const messages: Record<string, unknown>[] = [];
  let listener: ((line: string) => void) | undefined;
  const send = async (line: string): Promise<void> => {
    const message = JSON.parse(line) as Record<string, unknown>;
    messages.push(message);
    const respond = (body: unknown): void => listener?.(JSON.stringify(body));
    if (message.method === "initialize") respond({ id: message.id, result: {} });
    if (message.method === "thread/start") respond({ id: message.id, result: { thread: { id: "thread-specialist-01" } } });
    if (message.method === "turn/start") {
      respond({ id: message.id, result: { turn: { id: "turn-specialist-0001", status: "inProgress", items: [] } } });
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
  return { messages, rpc: new JsonRpcClient({ channel }) };
}

test("starts one real Codex thread and preserves only the completed agent message", async () => {
  const harness = appServerHarness();
  const client = new CodexAppServerThreadClient({
    rpc: harness.rpc,
    clientInfo: { name: "personal-consultant", title: "Personal Consultant", version: "0.1.0" }
  });
  const thread = await client.startIsolatedThread({ modelId: "catalog-only-model" });
  assert.deepEqual(thread, { ok: true, value: { threadId: "thread-specialist-01", modelId: "catalog-only-model" } });
  if (!thread.ok) throw new Error("Expected thread.");
  const turn = await client.runTextTurn({ lease: thread.value, body: "Завдання.", reasoningEffort: "high" });
  assert.deepEqual(turn, { ok: true, turnId: "turn-specialist-0001", body: "Повна позиція агента." });
  assert.deepEqual(harness.messages.map((message) => message.method), ["initialize", "initialized", "thread/start", "turn/start"]);
  assert.deepEqual(harness.messages[2], {
    jsonrpc: "2.0",
    id: 2,
    method: "thread/start",
    params: { model: "catalog-only-model", ephemeral: true }
  });
  assert.deepEqual(harness.messages.at(-1), {
    jsonrpc: "2.0",
    id: 3,
    method: "turn/start",
    params: {
      threadId: "thread-specialist-01",
      input: [{ type: "text", text: "Завдання.", text_elements: [] }],
      model: "catalog-only-model",
      effort: "high"
    }
  });
  harness.rpc.close();
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
