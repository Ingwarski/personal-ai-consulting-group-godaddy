import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeCredentialVault, runtimeCredentialVaultText, type RuntimeCredentialStorage } from "../src/godaddy/runtime-credential-vault.ts";

class MemoryStorage implements RuntimeCredentialStorage {
  readonly records = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.records.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.records.set(key, value);
  }
}

const rootSecret = "a-random-root-secret-used-only-in-this-test-and-never-in-production";

test("seals a runtime credential before it reaches persistent storage", async () => {
  const storage = new MemoryStorage();
  const vault = createRuntimeCredentialVault({ storage, rootSecret });
  assert.notEqual(vault, undefined);
  if (vault === undefined) throw new Error("Expected vault.");
  await vault.write("codex_auth_state", new TextEncoder().encode('{"tokens":"sensitive"}'));
  const stored = JSON.stringify(storage.records.get("codex_auth_state"));
  assert.doesNotMatch(stored, /sensitive/);
  const restored = await vault.read("codex_auth_state");
  assert.equal(restored === undefined ? undefined : runtimeCredentialVaultText(restored), '{"tokens":"sensitive"}');
});

test("fails closed when a sealed record is tampered with or opened under a different root", async () => {
  const storage = new MemoryStorage();
  const vault = createRuntimeCredentialVault({ storage, rootSecret });
  if (vault === undefined) throw new Error("Expected vault.");
  await vault.write("codex_auth_state", new TextEncoder().encode("private"));
  const original = storage.records.get("codex_auth_state") as { ciphertextBase64: string };
  storage.records.set("codex_auth_state", { version: "v1", ivBase64: "AAAAAAAAAAAAAAAA", ciphertextBase64: `${original.ciphertextBase64.slice(0, -2)}AA` });
  assert.equal(await vault.read("codex_auth_state"), undefined);
  const second = createRuntimeCredentialVault({ storage, rootSecret: "a-different-random-root-secret-used-only-for-a-negative-test" });
  if (second === undefined) throw new Error("Expected vault.");
  assert.equal(await second.read("codex_auth_state"), undefined);
});
