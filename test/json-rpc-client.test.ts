import assert from "node:assert/strict";
import test from "node:test";

import { JsonRpcClient } from "../src/runtime/json-rpc-client.ts";

function channelHarness() {
  const sent: unknown[] = [];
  let listener: ((line: string) => void) | undefined;
  return {
    sent,
    channel: {
      send: async (line: string) => { sent.push(JSON.parse(line)); },
      onLine: (next: (line: string) => void) => {
        listener = next;
        return () => { listener = undefined; };
      }
    },
    respond: (value: unknown) => listener?.(JSON.stringify(value))
  };
}

test("concurrent role clients share exactly one managed-OAuth connection initialization", async () => {
  const harness = channelHarness();
  const client = new JsonRpcClient({ channel: harness.channel });
  const info = { name: "app", title: "Application", version: "1" };
  const pending = [client.initialize(info), client.initialize(info), client.initialize(info)];
  assert.equal(harness.sent.length, 1);
  harness.respond({ id: 1, result: {} });
  await Promise.all(pending);
  assert.deepEqual(harness.sent.map((message: { method: string }) => message.method), ["initialize", "initialized"]);
  client.close();
});

test("requires the documented initialize then initialized handshake before Codex app-server requests", async () => {
  const harness = channelHarness();
  const client = new JsonRpcClient({ channel: harness.channel });
  await assert.rejects(client.request("account/read", {}), { message: "not_initialized" });

  const initialized = client.initialize({ name: "personal-consultant", title: "Personal Consultant", version: "0.1.0" });
  harness.respond({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.deepEqual(await initialized, { ok: true });
  assert.deepEqual(harness.sent.map((message) => message.method), ["initialize", "initialized"]);

  const account = client.request("account/read", { refreshToken: false });
  harness.respond({ jsonrpc: "2.0", id: 2, result: { account: { type: "chatgpt" } } });
  assert.deepEqual(await account, { account: { type: "chatgpt" } });
  client.close();
});

test("does not surface raw server error bodies and cancels unresolved requests on close", async () => {
  const harness = channelHarness();
  const client = new JsonRpcClient({ channel: harness.channel, timeoutMilliseconds: 100 });
  const initialized = client.initialize({ name: "personal-consultant", title: "Personal Consultant", version: "0.1.0" });
  harness.respond({ jsonrpc: "2.0", id: 1, result: {} });
  await initialized;

  const rejected = client.request("account/read", {});
  harness.respond({ jsonrpc: "2.0", id: 2, error: { code: -1, message: "secret value must not escape" } });
  await assert.rejects(rejected, { message: "server_error" });

  const pending = client.request("model/list", {});
  client.close();
  await assert.rejects(pending, { message: "closed" });
});
