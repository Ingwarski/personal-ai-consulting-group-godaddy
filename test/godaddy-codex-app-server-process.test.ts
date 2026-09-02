import assert from "node:assert/strict";
import test from "node:test";

import {
  createGoDaddyCodexAppServer,
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
