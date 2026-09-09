import assert from "node:assert/strict";
import test from "node:test";
import { access, lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

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

test("Codex restores supplied vault bytes into a new non-hidden private home on each launch", async () => {
  const launch = createSubprocessCodexAppServerLauncher({ executable: resolve("test/fixtures/ignores-term-codex.mjs"), environment: { PATH: dirname(process.execPath) + ":/usr/bin:/bin" } });
  const auth = new TextEncoder().encode('{"synthetic":"not-a-real-token"}');
  const homes = new Set<string>();
  for (let restart = 0; restart < 2; restart++) {
    const connection = await launch(auth);
    try {
      const received = new Promise<{ codexHome: string }>(resolveMessage => connection.channel.onLine(line => resolveMessage(JSON.parse(line).result)));
      await connection.channel.send(JSON.stringify({ id: 1 }));
      const { codexHome } = await received;
      assert.equal(basename(codexHome), "codex-home");
      assert.equal((await lstat(codexHome)).mode & 0o777, 0o700);
      assert.equal((await lstat(resolve(codexHome, "auth.json"))).mode & 0o777, 0o600);
      assert.deepEqual(new Uint8Array((await connection.readAuthState())!), auth);
      homes.add(codexHome);
    } finally { await connection.close(); }
  }
  assert.equal(homes.size, 2);
  for (const home of homes) await assert.rejects(access(home));
});

test("an unresponsive owned app-server is killed and its private directory removed before close resolves", async () => {
  const launch = createSubprocessCodexAppServerLauncher({ executable: resolve("test/fixtures/ignores-term-codex.mjs"), environment: { PATH: dirname(process.execPath) + ":/usr/bin:/bin" } });
  const connection = await launch(undefined);
  assert.equal(connection.isAlive?.(), true);
  const received = new Promise<{ pid: number; cwd: string }>(resolveMessage => connection.channel.onLine(line => resolveMessage(JSON.parse(line).result)));
  await connection.channel.send(JSON.stringify({ id: 1 }));
  const owned = await received;
  assert.match(owned.cwd, /personal-consultant-codex-/);
  await Promise.all([connection.close(), connection.close()]);
  assert.equal(connection.isAlive?.(), false);
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

test("dead cached Codex child is retired once before concurrent preflights restore the same sealed OAuth", async () => {
  const storage = new MemoryStorage(); const vault = createRuntimeCredentialVault({ storage, rootSecret })!;
  const auth = new TextEncoder().encode('{"managed":"same-owner-existing-oauth"}');
  await vault.write("codex_auth_state", auth);
  const launches: Array<Uint8Array | undefined> = [];
  const calls: string[] = [];
  let alive = true; let release = () => {}; let entered = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const retiring = new Promise<void>(resolve => { entered = resolve; });
  const launch: CodexAppServerLauncher = async state => {
    launches.push(state); const index = launches.length;
    const fake = launcher(responses, auth); const base = await fake.launch(state);
    calls.push(`launch-${index}`);
    return { ...base, isAlive: () => index !== 1 || alive, close: async () => {
      calls.push(`closing-${index}`);
      if (index === 1) { entered(); await held; }
      calls.push(`closed-${index}`);
    } };
  };
  const runtime = createGoDaddyCodexAppServer({ environment: {}, vault, launch });
  assert.equal((await runtime.inspectSubscription()).runtime.readiness, "ready");
  alive = false;
  const clients = [runtime.getThreadClient!(), runtime.getThreadClient!(), runtime.getThreadClient!()];
  await retiring;
  assert.equal(launches.length, 1);
  release(); await Promise.all(clients);
  assert.equal(launches.length, 2);
  assert.deepEqual(launches, [auth, auth]);
  assert.deepEqual(calls, ["launch-1", "closing-1", "closed-1", "launch-2"]);
  assert.equal((await runtime.inspectSubscription()).runtime.readiness, "ready");
  assert.doesNotMatch(JSON.stringify([...storage.records.values()]), /same-owner-existing-oauth/);
  await runtime.close();
});

test("a transient launch failure is not cached forever or repaired by a login/reset", async () => {
  const vault = createRuntimeCredentialVault({ storage: new MemoryStorage(), rootSecret })!;
  const fake = launcher(responses);
  let attempts = 0;
  const runtime = createGoDaddyCodexAppServer({ environment: {}, vault, launch: async state => {
    if (++attempts === 1) throw new Error("PRIVATE-LAUNCH-DETAILS");
    return fake.launch(state);
  } });
  assert.equal((await runtime.inspectSubscription()).runtime.readiness, "unavailable");
  assert.equal((await runtime.inspectSubscription()).runtime.readiness, "ready");
  assert.equal(attempts, 2);
  assert.equal(fake.calls.includes("account/login/start"), false); assert.equal(fake.calls.includes("account/logout"), false);
  await runtime.close();
});

test("a child exiting during subscription preflight gets one same-credential restart, not an auth/quota retry", async () => {
  const vault = createRuntimeCredentialVault({ storage: new MemoryStorage(), rootSecret })!;
  let launches = 0; let oldAlive = true;
  const calls: string[] = [];
  const runtime = createGoDaddyCodexAppServer({ environment: {}, vault, launch: async state => {
    const index = ++launches; const fake = launcher(responses); const base = await fake.launch(state);
    return { ...base, isAlive: () => index !== 1 || oldAlive, channel: {
      onLine: base.channel.onLine,
      send: async line => {
        const request = JSON.parse(line); calls.push(request.method);
        if (index === 1 && request.method === "account/read") { oldAlive = false; throw new Error("dead pipe"); }
        return base.channel.send(line);
      }
    } };
  } });
  assert.equal((await runtime.inspectSubscription()).runtime.readiness, "ready");
  assert.equal(launches, 2);
  assert.equal(calls.includes("account/login/start"), false); assert.equal(calls.includes("account/logout"), false);
  await runtime.close();
  assert.equal((await runtime.inspectSubscription()).runtime.readiness, "unavailable");
  assert.equal(launches, 2);
});
