import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GoDaddyMatrixCapabilityProbe } from "../src/godaddy/capability-probe.mjs";

const cryptoModule = () => import("@matrix-org/matrix-sdk-crypto-nodejs");

test("the capability probe creates only synthetic crypto stores and proves their restart-safe reopen", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "godaddy-capability-probe-test-"));
  const first = new GoDaddyMatrixCapabilityProbe({
    workingDirectory: join(root, "app"),
    temporaryDirectory: join(root, "tmp"),
    fetchImpl: async () => new Response("{}", { status: 200 }),
    loadCrypto: cryptoModule
  });
  t.after(() => first.remove());

  const started = await first.start();
  assert.deepEqual(started, {
    ok: true,
    nativeCrypto: true,
    childProcess: true,
    matrixHttps: true,
    stores: [
      { kind: "app", writable: true, cryptoStore: true },
      { kind: "tmp", writable: true, cryptoStore: true }
    ]
  });

  const restarted = new GoDaddyMatrixCapabilityProbe({
    workingDirectory: join(root, "app"),
    temporaryDirectory: join(root, "tmp"),
    fetchImpl: async () => new Response("{}", { status: 200 }),
    loadCrypto: cryptoModule
  });
  assert.deepEqual(await restarted.status(), {
    ok: true,
    nativeCrypto: true,
    stores: [
      { kind: "app", survivedRestart: true, cryptoStoreReopened: true },
      { kind: "tmp", survivedRestart: true, cryptoStoreReopened: true }
    ]
  });

  assert.equal(await first.directoryExists("app"), true);
  assert.equal(await first.directoryExists("tmp"), true);
  assert.deepEqual(await first.remove(), { ok: true, removed: true });
  assert.equal(await first.directoryExists("app"), false);
  assert.equal(await first.directoryExists("tmp"), false);
});

test("the capability probe fails closed when the native module is unavailable", async () => {
  const probe = new GoDaddyMatrixCapabilityProbe({
    workingDirectory: join(tmpdir(), "probe-no-native-app"),
    temporaryDirectory: join(tmpdir(), "probe-no-native-tmp"),
    fetchImpl: async () => { throw new Error("blocked"); },
    loadCrypto: async () => { throw new Error("native module unavailable"); }
  });
  const result = await probe.start();
  assert.deepEqual(result, {
    ok: true,
    nativeCrypto: false,
    childProcess: true,
    matrixHttps: false,
    stores: [
      { kind: "app", writable: false, cryptoStore: false },
      { kind: "tmp", writable: false, cryptoStore: false }
    ]
  });
});
