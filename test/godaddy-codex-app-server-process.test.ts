import assert from "node:assert/strict";
import test from "node:test";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createGoDaddyCodexAppServer,
  createSubprocessCodexAppServerLauncher,
  writeCodexAppServerLine,
  type CodexAppServerLauncher
} from "../src/godaddy/codex-app-server-process.ts";
import { createRuntimeCredentialVault, type RuntimeCredentialStorage } from "../src/godaddy/runtime-credential-vault.ts";
import type { JsonRpcLineChannel } from "../src/runtime/json-rpc-client.ts";

class MemoryStorage implements RuntimeCredentialStorage {
  readonly records = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.records.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.records.set(key, value); }
  async delete(key: string): Promise<void> { this.records.delete(key); }
}

const rootSecret = "a-random-root-secret-used-only-in-this-test-and-never-in-production";

test("an unresponsive owned app-server is killed and its private directory removed before close resolves", async () => {
  const launch = createSubprocessCodexAppServerLauncher({ executable: resolve("test/fixtures/ignores-term-codex.mjs"), environment: { PATH: dirname(process.execPath) + ":/usr/bin:/bin" } });
  const connection = await launch(undefined);
  const received = new Promise<{ pid: number; cwd: string }>(resolveMessage => connection.channel.onLine(line => resolveMessage(JSON.parse(line).result)));
  await connection.channel.send(JSON.stringify({ id: 1 }));
  const owned = await received;
  assert.match(owned.cwd, /personal-consultant-codex-/);
  await Promise.all([connection.close(), connection.close()]);
  assert.throws(() => process.kill(owned.pid, 0));
  await assert.rejects(access(owned.cwd));
});

function launcher(responses: Record<string, unknown>, initialAuthState = new TextEncoder().encode('{"managed":"oauth"}')): Readonly<{
  launch: CodexAppServerLauncher;
  calls: string[];
  emit: (line: string) => void;
  setAuthState: (value: Uint8Array | undefined) => void;
}> {
  const listeners = new Set<(line: string) => void>();
  const calls: string[] = [];
  let authState = initialAuthState;
  const channel: JsonRpcLineChannel = {
    async send(line): Promise<void> {
      const request = JSON.parse(line) as { id?: number; method: string };
      calls.push(request.method);
      if (request.id !== undefined) {
        const value = responses[request.method];
        queueMicrotask(() => {
          for (const listener of listeners) listener(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: value }));
        });
      }
    },
    onLine(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
  return Object.freeze({
    launch: async () => Object.freeze({ channel, readAuthState: async () => authState, close: async () => {} }),
    calls,
    emit: (line) => { for (const listener of listeners) listener(line); },
    setAuthState: (value) => { authState = value; }
  });
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  throw last;
}

const responses = Object.freeze({
  initialize: {},
  "account/read": { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: true },
  "model/list": { data: [{
    id: "codex-current", model: "gpt-5.6-codex", displayName: "Codex", hidden: false, isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }]
  }] },
  "account/rateLimits/read": { rateLimits: { rateLimitReachedType: null } },
  "account/login/start": { type: "chatgptDeviceCode", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" }
});

test("exact Astra Extra High proof shares the managed OAuth client and always releases its ephemeral thread", async () => {
  const storage = new MemoryStorage();
  const vault = createRuntimeCredentialVault({ storage, rootSecret })!;
  const fake = launcher({ ...responses,
    "thread/start": { model: "gpt-6-astra", thread: { id: "astra-proof-thread" } },
    "turn/start": { turn: { id: "astra-proof-turn", status: "completed", items: [{ type: "agentMessage", text: "OK" }] } },
    "thread/unsubscribe": {}
  });
  const runtime = createGoDaddyCodexAppServer({ environment: {}, vault, launch: fake.launch });
  assert.equal(await runtime.verifyModelSelection!("gpt-6-astra", "high"), false);
  assert.equal(fake.calls.length, 0);
  assert.equal(await runtime.verifyModelSelection!("gpt-6-astra", "xhigh"), true);
  const client = await runtime.getThreadClient!();
  await client.transport.request("account/read", {});
  assert.equal(fake.calls.filter(method => method === "initialize").length, 1);
  assert.equal(fake.calls.filter(method => method === "thread/unsubscribe").length, 1);
  assert.doesNotMatch(JSON.stringify([...storage.records.values()]), /managed/);
  await runtime.close();
});

test("accepts Node's null child-process write callback as success", async () => {
  let written = "";
  await writeCodexAppServerLine({
    write(line, callback) {
      written = line;
      callback(null);
      return true;
    }
  }, '{"jsonrpc":"2.0"}');
  assert.equal(written, '{"jsonrpc":"2.0"}\n');

  const failure = new Error("write failed");
  await assert.rejects(writeCodexAppServerLine({
    write(_line, callback) {
      callback(failure);
      return false;
    }
  }, "{}"), failure);
});

test("uses Codex-managed device OAuth and seals its restored auth state", async () => {
  const storage = new MemoryStorage();
  const vault = createRuntimeCredentialVault({ storage, rootSecret });
  if (vault === undefined) throw new Error("Expected vault.");
  const fake = launcher(responses);
  const runtime = createGoDaddyCodexAppServer({ environment: {}, vault, launch: fake.launch });
  const probe = await runtime.inspectSubscription();
  assert.equal(probe.runtime.authMode, "chatgpt_oauth");
  assert.equal(probe.runtime.readiness, "ready");
  assert.deepEqual(fake.calls, ["initialize", "initialized", "account/read", "model/list", "account/rateLimits/read"]);
  assert.doesNotMatch(JSON.stringify(storage.records.get("codex_auth_state")), /managed/);
  const authorization = await runtime.startDeviceAuthorization();
  assert.deepEqual(authorization, { verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" });
  await runtime.close();
});

test("never returns a malformed device-code response", async () => {
  const storage = new MemoryStorage();
  const vault = createRuntimeCredentialVault({ storage, rootSecret });
  if (vault === undefined) throw new Error("Expected vault.");
  const fake = launcher({ ...responses, "account/login/start": { type: "chatgptDeviceCode", verificationUrl: "http://not-safe.test", userCode: "abc" } });
  const runtime = createGoDaddyCodexAppServer({ environment: {}, vault, launch: fake.launch });
  assert.equal(await runtime.startDeviceAuthorization(), undefined);
  await runtime.close();
});

test("persists the updated auth state after App Server reports an account change", async () => {
  const storage = new MemoryStorage();
  const vault = createRuntimeCredentialVault({ storage, rootSecret });
  if (vault === undefined) throw new Error("Expected vault.");
  const fake = launcher(responses);
  const runtime = createGoDaddyCodexAppServer({ environment: {}, vault, launch: fake.launch });
  await runtime.inspectSubscription();
  const renewed = new TextEncoder().encode('{"managed":"renewed"}');
  fake.setAuthState(renewed);
  fake.emit(JSON.stringify({ jsonrpc: "2.0", method: "account/updated", params: { authMode: "chatgpt", planType: "pro" } }));

  await eventually(async () => assert.deepEqual(Array.from((await vault.read("codex_auth_state")) ?? []), Array.from(renewed)));

  await runtime.close();
});

test("clears the sealed Codex state before a replacement login", async () => {
  const storage = new MemoryStorage();
  const vault = createRuntimeCredentialVault({ storage, rootSecret });
  if (vault === undefined) throw new Error("Expected vault.");
  const fake = launcher({ ...responses, "account/logout": {} });
  const runtime = createGoDaddyCodexAppServer({ environment: {}, vault, launch: fake.launch });
  await runtime.inspectSubscription();

  assert.equal(await runtime.resetAuthorization(), true);
  assert.ok(fake.calls.includes("account/logout"));
  assert.equal(await vault.read("codex_auth_state"), undefined);
});
