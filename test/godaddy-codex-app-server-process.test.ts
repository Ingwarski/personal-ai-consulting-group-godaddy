import assert from "node:assert/strict";
import test from "node:test";

import { createGoDaddyCodexAppServer, type CodexAppServerLauncher } from "../src/godaddy/codex-app-server-process.ts";
import { createRuntimeCredentialVault, type RuntimeCredentialStorage } from "../src/godaddy/runtime-credential-vault.ts";
import type { JsonRpcLineChannel } from "../src/runtime/json-rpc-client.ts";

class MemoryStorage implements RuntimeCredentialStorage {
  readonly records = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.records.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.records.set(key, value); }
}

const rootSecret = "a-random-root-secret-used-only-in-this-test-and-never-in-production";

function launcher(responses: Record<string, unknown>, authState = new TextEncoder().encode('{"managed":"oauth"}')): Readonly<{ launch: CodexAppServerLauncher; calls: string[]; emit: (line: string) => void }> {
  const listeners = new Set<(line: string) => void>();
  const calls: string[] = [];
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
    emit: (line) => { for (const listener of listeners) listener(line); }
  });
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
