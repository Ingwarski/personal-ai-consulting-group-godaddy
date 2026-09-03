import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GoDaddyNode22CryptoCompatibilityProbe } from "../src/godaddy/node22-crypto-compatibility-probe.mjs";

test("the current Matrix binding opens only synthetic SQLite stores and removes them exactly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "godaddy-node22-crypto-test-"));
  const probe = new GoDaddyNode22CryptoCompatibilityProbe({
    workingDirectory: join(root, "app"),
    temporaryDirectory: join(root, "tmp")
  });
  t.after(() => probe.remove());

  assert.deepEqual(await probe.start(), {
    ok: true,
    imported: true,
    openedStore: true,
    stores: [
      { kind: "app", writable: true, cryptoStore: true },
      { kind: "tmp", writable: true, cryptoStore: true }
    ]
  });
  assert.deepEqual(await probe.remove(), { ok: true, removed: true });
});

test("the compatibility probe reports a native import failure without creating stores", async () => {
  const probe = new GoDaddyNode22CryptoCompatibilityProbe({
    loadCrypto: async () => {
      const error = new Error("native binding unavailable");
      error.code = "ERR_DLOPEN_FAILED";
      throw error;
    }
  });
  assert.deepEqual(await probe.start(), {
    ok: true,
    imported: false,
    openedStore: false,
    failure: { code: "ERR_DLOPEN_FAILED", message: "native binding unavailable" }
  });
});
