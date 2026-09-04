import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLISHED_RUST_STORAGE_GATE_LOG_PREFIX,
  runPublishedRustStorageGate
} from "../src/godaddy/published-rust-storage-gate.mjs";

const publishedEnvironment = Object.freeze({
  RUNTIME_MODE: "production",
  GODADDY_STATE_DATABASE_ROLE: "published"
});

const verificationResult = (overrides = {}) => ({
  ok: true,
  binary_verified: true,
  lock_contention: true,
  schema_version: 1,
  matrix_sdk_version: "0.18.0",
  store_created: true,
  store_reopened: true,
  wrong_key_rejected: true,
  matrix_https: true,
  survived_restart: false,
  survived_redeploy: false,
  ...overrides
});

test("the storage gate is inert outside the exact Published runtime", async () => {
  let calls = 0;
  const probe = {
    start: async () => { calls += 1; return verificationResult(); },
    remove: async () => { calls += 1; return { ok: true, removed: true }; }
  };

  assert.deepEqual(await runPublishedRustStorageGate({
    environment: { RUNTIME_MODE: "development", GODADDY_STATE_DATABASE_ROLE: "published" },
    probe
  }), { schema_version: 1, phase: "skipped", ok: true, code: "not_published_runtime" });
  assert.deepEqual(await runPublishedRustStorageGate({
    environment: { RUNTIME_MODE: "production", GODADDY_STATE_DATABASE_ROLE: "preview" },
    probe
  }), { schema_version: 1, phase: "skipped", ok: true, code: "not_published_runtime" });
  assert.equal(calls, 0);
});

test("the Published verification receipt is bounded and content-free", async () => {
  const lines = [];
  const receipt = await runPublishedRustStorageGate({
    environment: publishedEnvironment,
    configuration: { operation: "verify", deploymentId: "published-g00-a" },
    probe: { start: async () => verificationResult({ ignored_secret: "must-not-escape" }) },
    log: (line) => lines.push(line)
  });

  assert.deepEqual(receipt, {
    schema_version: 1,
    phase: "verify",
    deployment_id: "published-g00-a",
    ok: true,
    binary_verified: true,
    lock_contention: true,
    matrix_sdk_version: "0.18.0",
    store_created: true,
    store_reopened: true,
    wrong_key_rejected: true,
    matrix_https: true,
    survived_restart: false,
    survived_redeploy: false,
    code: undefined
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `${PUBLISHED_RUST_STORAGE_GATE_LOG_PREFIX} ${JSON.stringify(receipt)}`);
  assert.equal(lines[0].includes("ignored_secret"), false);
  assert.equal(lines[0].includes("public/assets"), false);
});

test("cleanup removes only through the probe's fixed-directory operation", async () => {
  let starts = 0;
  let removals = 0;
  const receipt = await runPublishedRustStorageGate({
    environment: publishedEnvironment,
    configuration: { operation: "cleanup", deploymentId: "published-g00-cleanup" },
    probe: {
      start: async () => { starts += 1; return verificationResult(); },
      remove: async () => { removals += 1; return { ok: true, removed: true }; }
    },
    log: () => undefined
  });

  assert.deepEqual(receipt, {
    schema_version: 1,
    phase: "cleanup",
    deployment_id: "published-g00-cleanup",
    ok: true,
    removed: true,
    code: undefined
  });
  assert.equal(starts, 0);
  assert.equal(removals, 1);
});

test("a partial native result cannot become a passing Published receipt", async () => {
  const receipt = await runPublishedRustStorageGate({
    environment: publishedEnvironment,
    configuration: { operation: "verify", deploymentId: "published-g00-a" },
    probe: { start: async () => verificationResult({ wrong_key_rejected: false }) },
    log: () => undefined
  });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.wrong_key_rejected, false);
});

test("an invalid gate configuration fails without invoking the probe", async () => {
  let calls = 0;
  const receipt = await runPublishedRustStorageGate({
    environment: publishedEnvironment,
    configuration: { operation: "verify", deploymentId: "../unsafe" },
    probe: { start: async () => { calls += 1; return verificationResult(); } },
    log: () => undefined
  });
  assert.deepEqual(receipt, {
    schema_version: 1,
    phase: "configuration",
    deployment_id: "invalid",
    ok: false,
    code: "gate_execution_failed"
  });
  assert.equal(calls, 0);
});
