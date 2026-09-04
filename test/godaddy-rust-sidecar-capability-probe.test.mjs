import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyGoDaddyRustProbeArtifact } from "../scripts/verify-godaddy-rust-probe-artifact.mjs";
import { GoDaddyRustSidecarCapabilityProbe } from "../src/godaddy/rust-sidecar-capability-probe.mjs";

const result = (overrides = {}) => ({
  ok: true,
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

test("the Rust probe accepts only a verified bounded artifact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rust-probe-artifact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifactPath = join(directory, "godaddy-rust-probe");
  const checksumPath = join(directory, "SHA256SUMS");
  await writeFile(artifactPath, "synthetic binary");
  await chmod(artifactPath, 0o700);
  await writeFile(checksumPath, "0184705e7acfe20d60703250ce4f1e52bed97c52150f0345b85b9249966bb38d  godaddy-rust-probe\n");
  assert.equal(await verifyGoDaddyRustProbeArtifact({ artifactPath, checksumPath }), true);
  await writeFile(checksumPath, "0".repeat(64) + "  godaddy-rust-probe\n");
  assert.equal(await verifyGoDaddyRustProbeArtifact({ artifactPath, checksumPath }), false);
  assert.equal((await readFile(artifactPath, "utf8")), "synthetic binary");
});

test("the temporary probe creates only after binary and lock gates pass", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rust-probe-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const probe = new GoDaddyRustSidecarCapabilityProbe({
    workingDirectory: directory,
    bootId: "boot_a",
    deploymentId: "deploy_a",
    verifyArtifact: async () => true,
    executor: {
      checkLockContention: async (input) => { calls.push(["lock", input.root]); return true; },
      execute: async ({ command }) => { calls.push(["execute", command]); return result(); }
    }
  });
  assert.deepEqual(await probe.start(), {
    ok: true,
    binary_verified: true,
    lock_contention: true,
    ...result()
  });
  assert.deepEqual(calls.map(([name, command]) => `${name}:${command ?? ""}`), ["lock:" + join(directory, "public", "assets", "godaddy-rust-matrix-probe-v1"), "execute:start"]);
});

test("the temporary probe fails closed and removes only its own fixed directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rust-probe-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const probe = new GoDaddyRustSidecarCapabilityProbe({
    workingDirectory: directory,
    verifyArtifact: async () => false,
    executor: { checkLockContention: async () => true, execute: async () => result() }
  });
  assert.deepEqual(await probe.start(), { ok: false, code: "binary_unavailable" });
  assert.deepEqual(await probe.status(), { ok: false, code: "binary_unavailable" });
  assert.deepEqual(await probe.remove(), { ok: true, removed: true });
});

test("the temporary probe never converts malformed Rust output into a capability pass", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rust-probe-malformed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const probe = new GoDaddyRustSidecarCapabilityProbe({
    workingDirectory: directory,
    verifyArtifact: async () => true,
    executor: { checkLockContention: async () => true, execute: async () => ({ ok: true, matrix_https: true }) }
  });
  assert.deepEqual(await probe.start(), { ok: false, code: "probe_execution_failed" });
});
