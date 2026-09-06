import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectMatrixRelease, prepareMatrixRelease, verifyMatrixHttpIsolation, type MatrixReleaseExpectation } from "../src/godaddy/matrix-release-install.ts";

const SIDECAR = "personal-consultant-matrix-sidecar";
const SETUP = "personal-consultant-matrix-setup";
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const sidecar = Buffer.from("\x7fELFsidecar-test-not-an-executable");
const setup = Buffer.from("\x7fELFsetup-test-not-an-executable");
const evidence = Buffer.from("{\"test\":\"production-release-provenance-fixture\"}");

async function fixture(context: { after: (action: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "matrix-release-install-")));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const bundle = join(root, ".runtime-release", "matrix");
  await mkdir(bundle, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "public", "assets"), { recursive: true, mode: 0o700 });
  for (const [name, bytes] of [[SIDECAR, sidecar], [SETUP, setup], ["provenance.json", evidence]] as const) {
    await writeFile(join(bundle, name), bytes, { mode: 0o600 });
  }
  const manifest = {
    schemaVersion: 1, kind: "matrix-production-release", sourceCommit: "a".repeat(40), sidecarVersion: "0.1.0", protocolVersion: 1,
    builder: {
      image: `ghcr.io/example/locked-builder@sha256:${"b".repeat(64)}`, imageConfigDigest: `sha256:${"c".repeat(64)}`,
      platform: "linux/amd64", rustToolchain: "1.93.0-x86_64-unknown-linux-musl", target: "x86_64-unknown-linux-musl"
    },
    artifacts: [
      { path: SIDECAR, role: "sidecar", sha256: hash(sidecar), sizeBytes: sidecar.length },
      { path: SETUP, role: "setup", sha256: hash(setup), sizeBytes: setup.length },
      { path: "provenance.json", role: "evidence", sha256: hash(evidence), sizeBytes: evidence.length }
    ]
  };
  async function save(): Promise<MatrixReleaseExpectation> {
    const bytes = JSON.stringify(manifest);
    await writeFile(join(bundle, "release-manifest.json"), bytes, { mode: 0o600 });
    return { sourceCommit: "a".repeat(40), manifestSha256: hash(bytes) };
  }
  const expected = await save();
  return { root, bundle, manifest, save, expected,
    store: join(root, "public", "assets", ".personal-consultant-matrix-v1", "crypto-store"),
    spool: join(root, "public", "assets", ".personal-consultant-matrix-v1", "media-spool"),
    runtime: join(root, ".runtime", "matrix") };
}

test("explicit preparation installs both exact binaries privately and creates empty dedicated dirs", async (t) => {
  const f = await fixture(t);
  const result = await prepareMatrixRelease(f.root, f.expected);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.credentialReadiness, "requires_http_isolation");
  assert.equal(result.value.storeState, "empty");
  assert.equal(result.value.storeProvisioning, "empty");
  assert.equal(result.value.mediaSpoolState, "empty");
  assert.deepEqual(await readFile(result.value.sidecarPath), sidecar);
  assert.deepEqual(await readFile(result.value.setupPath), setup);
  assert.equal((await lstat(result.value.sidecarPath)).mode & 0o777, 0o500);
  assert.equal((await lstat(result.value.setupPath)).mode & 0o777, 0o500);
  assert.equal((await lstat(f.store)).mode & 0o777, 0o700);
  assert.equal((await lstat(f.spool)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(f.runtime)).sort(), [SETUP, SIDECAR].sort());
  assert.deepEqual(await inspectMatrixRelease(f.root, f.expected), result);
});

test("inspection is read-only and does not turn missing installation into a provisioning action", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await inspectMatrixRelease(f.root, f.expected), { ok: false, code: "matrix_release_unavailable" });
  assert.equal((await readdir(f.root)).includes(".runtime"), false);
  assert.deepEqual(await readdir(join(f.root, "public", "assets")), []);
});

test("preparation is idempotent, preserving binary inodes and existing encrypted data bytes/modes", async (t) => {
  const f = await fixture(t);
  assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
  const before = await lstat(join(f.runtime, SIDECAR));
  const state = join(f.store, "matrix-sdk-crypto.sqlite3");
  const bytes = Buffer.from("existing-encrypted-state-must-not-change");
  await writeFile(state, bytes, { mode: 0o600 });
  await writeFile(join(f.store, "device-binding.json"), "existing binding", { mode: 0o600 });
  const stateBefore = await lstat(state);
  const second = await prepareMatrixRelease(f.root, f.expected);
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.value.storeState, "contains_state");
    assert.equal(second.value.storeProvisioning, "bound");
  }
  assert.equal((await lstat(join(f.runtime, SIDECAR))).ino, before.ino);
  assert.deepEqual(await readFile(state), bytes);
  const stateAfter = await lstat(state);
  assert.equal(stateAfter.mode, stateBefore.mode);
  assert.equal(stateAfter.mtimeMs, stateBefore.mtimeMs);
  assert.equal(stateAfter.ctimeMs, stateBefore.ctimeMs);
});

test("both source binaries and evidence are verified before any dedicated runtime/state directory is created", async (t) => {
  for (const name of [SIDECAR, SETUP, "provenance.json", "release-manifest.json"]) {
    await t.test(name, async (child) => {
      const f = await fixture(child);
      await writeFile(join(f.bundle, name), "altered");
      assert.deepEqual(await prepareMatrixRelease(f.root, f.expected), { ok: false, code: "matrix_release_checksum_mismatch" });
      assert.equal((await readdir(f.root)).includes(".runtime"), false);
      assert.deepEqual(await readdir(join(f.root, "public", "assets")), []);
    });
  }
});

test("rejects verification-only, unpinned builder, foreign source, path escape and duplicate binary manifests", async (t) => {
  const changes: readonly [string, (m: Awaited<ReturnType<typeof fixture>>["manifest"]) => void][] = [
    ["verification-only", (m) => { m.kind = "matrix-verification-only"; }],
    ["image tag", (m) => { m.builder.image = "builder:latest"; }],
    ["source mismatch", (m) => { m.sourceCommit = "d".repeat(40); }],
    ["wrong target", (m) => { m.builder.target = "aarch64-unknown-linux-musl"; }],
    ["escape", (m) => { m.artifacts[2]!.path = "../provenance.json"; }],
    ["duplicate", (m) => { m.artifacts.push({ ...m.artifacts[0]! }); }],
    ["missing evidence", (m) => { m.artifacts.pop(); }]
  ];
  for (const [name, change] of changes) {
    await t.test(name, async (child) => {
      const f = await fixture(child);
      change(f.manifest);
      assert.deepEqual(await prepareMatrixRelease(f.root, await f.save()), { ok: false, code: "matrix_release_invalid" });
    });
  }
});

test("refuses an installed binary mismatch without overwriting either executable", async (t) => {
  const f = await fixture(t);
  assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
  const path = join(f.runtime, SIDECAR);
  await chmod(path, 0o700);
  await writeFile(path, "previous-live-binary");
  assert.deepEqual(await prepareMatrixRelease(f.root, f.expected), { ok: false, code: "matrix_release_conflict" });
  assert.equal(await readFile(path, "utf8"), "previous-live-binary");
  assert.deepEqual(await readFile(join(f.runtime, SETUP)), setup);
});

test("rejects unsafe existing directory permissions without chmod or any crypto mutation", async (t) => {
  const f = await fixture(t);
  assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
  await chmod(f.store, 0o755);
  assert.deepEqual(await prepareMatrixRelease(f.root, f.expected), { ok: false, code: "matrix_release_unsafe_path" });
  assert.equal((await lstat(f.store)).mode & 0o777, 0o755);
});

test("rejects group-readable existing crypto files without repairing or deleting them", async (t) => {
  const f = await fixture(t);
  assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
  const path = join(f.store, "state.sqlite3");
  await writeFile(path, "private-state", { mode: 0o600 });
  await chmod(path, 0o640);
  assert.deepEqual(await prepareMatrixRelease(f.root, f.expected), { ok: false, code: "matrix_release_unsafe_path" });
  assert.equal((await lstat(path)).mode & 0o777, 0o640);
  assert.equal(await readFile(path, "utf8"), "private-state");
});

test("rejects symlink and ancestor path escapes without traversing their targets", async (t) => {
  for (const location of ["source", "runtime", "crypto"]) {
    await t.test(location, async (child) => {
      const f = await fixture(child);
      const outside = join(f.root, "unrelated");
      await mkdir(outside, { mode: 0o700 });
      await writeFile(join(outside, "keep"), "preserve", { mode: 0o600 });
      if (location === "source") {
        await rm(join(f.bundle, SIDECAR));
        await symlink(join(outside, "keep"), join(f.bundle, SIDECAR));
      } else if (location === "runtime") await symlink(outside, join(f.root, ".runtime"));
      else {
        await mkdir(join(f.root, "public", "assets", ".personal-consultant-matrix-v1"), { mode: 0o700 });
        await symlink(outside, f.store);
      }
      assert.deepEqual(await prepareMatrixRelease(f.root, f.expected), { ok: false, code: "matrix_release_unsafe_path" });
      assert.deepEqual(await readdir(outside), ["keep"]);
      assert.equal(await readFile(join(outside, "keep"), "utf8"), "preserve");
    });
  }
});

test("rejects wrong owner and noncanonical caller roots with safe content-free errors", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await prepareMatrixRelease(`${f.root}/../escape`, f.expected), { ok: false, code: "matrix_release_invalid" });
  assert.deepEqual(await prepareMatrixRelease(f.root, f.expected, { expectedOwnerUid: process.getuid!() + 1 }), { ok: false, code: "matrix_release_unsafe_path" });
});

test("rejects multiply-linked source binaries and installed executables", async (t) => {
  for (const installed of [false, true]) {
    await t.test(installed ? "installed" : "source", async (child) => {
      const f = await fixture(child);
      if (installed) assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
      await link(join(installed ? f.runtime : f.bundle, SIDECAR), join(f.root, "another-name"));
      assert.deepEqual(await prepareMatrixRelease(f.root, f.expected), { ok: false, code: "matrix_release_unsafe_path" });
      assert.deepEqual(await readFile(join(f.root, "another-name")), sidecar);
    });
  }
});

test("live isolation proof checks 12 fixed host paths without credentials/redirects and removes its exact canaries", async (t) => {
  const f = await fixture(t);
  assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
  const urls: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    assert.match(new URL(url).hostname, /^wy2v0putg6\.(?:preview\.)?c35\.airoapp\.ai$/u);
    assert.equal((await readdir(f.store)).length, 1);
    assert.equal((await readdir(f.spool)).length, 1);
    return new Response("Not found", { status: 404 });
  };
  assert.deepEqual(await verifyMatrixHttpIsolation(f.root, f.expected, fakeFetch), {
    ok: true, checkedPaths: 12, credentialReadiness: "http_isolation_verified"
  });
  assert.equal(new Set(urls).size, 12);
  assert.deepEqual(await readdir(f.store), []);
  assert.deepEqual(await readdir(f.spool), []);
});

test("isolation proof resumes through the existing binding without touching crypto contents or inserting files", async (t) => {
  const f = await fixture(t);
  assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
  const bindingPath = join(f.store, "device-binding.json");
  const binding = Buffer.from(JSON.stringify({ device_id: "EXISTING_DEVICE", store_fingerprint: "b".repeat(64) }));
  const cryptoPath = join(f.store, "matrix-sdk-crypto.sqlite3");
  const crypto = Buffer.from("existing encrypted database: preserve byte for byte");
  await writeFile(bindingPath, binding, { mode: 0o600 });
  await writeFile(cryptoPath, crypto, { mode: 0o600 });
  const before = [await lstat(bindingPath), await lstat(cryptoPath)];
  const urls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    urls.push(String(input));
    assert.deepEqual((await readdir(f.store)).sort(), ["device-binding.json", "matrix-sdk-crypto.sqlite3"]);
    assert.equal((await readdir(f.spool)).length, 1);
    return new Response("Not found", { status: 404 });
  };
  assert.deepEqual(await verifyMatrixHttpIsolation(f.root, f.expected, fakeFetch), {
    ok: true, checkedPaths: 12, credentialReadiness: "http_isolation_verified"
  });
  assert.equal(urls.filter((url) => url.endsWith("/crypto-store/device-binding.json")).length, 4);
  assert.equal(urls.filter((url) => url.includes("/crypto-store/.private-path-check-")).length, 0);
  const after = [await lstat(bindingPath), await lstat(cryptoPath)];
  for (let index = 0; index < before.length; index += 1) {
    assert.equal(after[index]!.ino, before[index]!.ino);
    assert.equal(after[index]!.mode, before[index]!.mode);
    assert.equal(after[index]!.mtimeMs, before[index]!.mtimeMs);
    assert.equal(after[index]!.ctimeMs, before[index]!.ctimeMs);
    assert.equal(after[index]!.atimeMs, before[index]!.atimeMs);
  }
  assert.deepEqual(await readFile(bindingPath), binding);
  assert.deepEqual(await readFile(cryptoPath), crypto);
  assert.deepEqual(await readdir(f.spool), []);
});

test("nonempty unknown crypto state is neither guessed fresh nor repaired", async (t) => {
  const f = await fixture(t);
  assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
  await writeFile(join(f.store, "crypto.sqlite3"), "existing", { mode: 0o600 });
  const fakeFetch: typeof fetch = async () => { assert.fail("must not contact hosts"); };
  assert.deepEqual(await inspectMatrixRelease(f.root, f.expected), { ok: false, code: "matrix_release_unrecognized_state" });
  assert.deepEqual(await verifyMatrixHttpIsolation(f.root, f.expected, fakeFetch), { ok: false, code: "matrix_release_unrecognized_state" });
  assert.deepEqual(await readdir(f.store), ["crypto.sqlite3"]);
  assert.deepEqual(await readdir(f.spool), []);
});

test("partial fresh provisioning is classified only from its private intent marker and HTTP-probed without crypto writes", async (t) => {
  const f = await fixture(t);
  assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
  const intentPath = join(f.store, "provisioning-intent.json");
  const intent = Buffer.from(JSON.stringify({ bot_mxid: "@fixture:matrix.org", device_id: "EXISTING_DEVICE", nonce: "a".repeat(32) }));
  const cryptoPath = join(f.store, "matrix-sdk-state.sqlite3");
  const crypto = Buffer.from("partial encrypted database must survive retry");
  await writeFile(intentPath, intent, { mode: 0o600 });
  await writeFile(cryptoPath, crypto, { mode: 0o600 });
  const before = [await lstat(intentPath), await lstat(cryptoPath)];
  const inspection = await inspectMatrixRelease(f.root, f.expected);
  assert.equal(inspection.ok, true);
  if (inspection.ok) assert.equal(inspection.value.storeProvisioning, "incomplete");
  const urls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    urls.push(String(input));
    assert.deepEqual((await readdir(f.store)).sort(), ["matrix-sdk-state.sqlite3", "provisioning-intent.json"]);
    return new Response("Not found", { status: 404 });
  };
  assert.deepEqual(await verifyMatrixHttpIsolation(f.root, f.expected, fakeFetch), {
    ok: true, checkedPaths: 12, credentialReadiness: "http_isolation_verified"
  });
  assert.equal(urls.filter((url) => url.endsWith("/crypto-store/provisioning-intent.json")).length, 4);
  assert.equal(urls.some((url) => url.includes("/crypto-store/.private-path-check-")), false);
  const after = [await lstat(intentPath), await lstat(cryptoPath)];
  for (let index = 0; index < before.length; index += 1) {
    assert.equal(after[index]!.ino, before[index]!.ino);
    assert.equal(after[index]!.mode, before[index]!.mode);
    assert.equal(after[index]!.mtimeMs, before[index]!.mtimeMs);
    assert.equal(after[index]!.ctimeMs, before[index]!.ctimeMs);
    assert.equal(after[index]!.atimeMs, before[index]!.atimeMs);
  }
  assert.deepEqual(await readFile(intentPath), intent);
  assert.deepEqual(await readFile(cryptoPath), crypto);
  assert.deepEqual(await readdir(f.spool), []);
  // This metadata classification never certifies the intent's contents. Rust must do so.
  await writeFile(intentPath, "not valid JSON", { mode: 0o600 });
  const malformedContent = await inspectMatrixRelease(f.root, f.expected);
  assert.equal(malformedContent.ok, true);
  if (malformedContent.ok) assert.equal(malformedContent.value.storeProvisioning, "incomplete");
});

test("bound marker takes precedence over an unfinished intent; unsafe markers never authorize recovery", async (t) => {
  const f = await fixture(t);
  assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
  await writeFile(join(f.store, "provisioning-intent.json"), "intent", { mode: 0o600 });
  await writeFile(join(f.store, "device-binding.json"), "binding", { mode: 0o600 });
  const inspection = await inspectMatrixRelease(f.root, f.expected);
  assert.equal(inspection.ok, true);
  if (inspection.ok) assert.equal(inspection.value.storeProvisioning, "bound");
  await rm(join(f.store, "device-binding.json"));
  await chmod(join(f.store, "provisioning-intent.json"), 0o640);
  assert.deepEqual(await inspectMatrixRelease(f.root, f.expected), { ok: false, code: "matrix_release_unsafe_path" });
  assert.equal((await lstat(join(f.store, "provisioning-intent.json"))).mode & 0o777, 0o640);
});

test("a nonempty media spool fails closed without probes or new files", async (t) => {
  const f = await fixture(t);
  assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
  await writeFile(join(f.spool, "pending-private-media"), "existing media", { mode: 0o600 });
  const fakeFetch: typeof fetch = async () => { assert.fail("must not contact hosts"); };
  assert.deepEqual(await verifyMatrixHttpIsolation(f.root, f.expected, fakeFetch), { ok: false, code: "isolation_probe_requires_empty_state" });
  assert.deepEqual(await readdir(f.store), []);
  assert.deepEqual(await readdir(f.spool), ["pending-private-media"]);
  assert.equal(await readFile(join(f.spool, "pending-private-media"), "utf8"), "existing media");
});

test("resume proof rejects binding replacement during checks without deleting or overwriting it", async (t) => {
  const f = await fixture(t);
  assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
  const bindingPath = join(f.store, "device-binding.json");
  await writeFile(bindingPath, "original", { mode: 0o600 });
  let replaced = false;
  const fakeFetch: typeof fetch = async () => {
    if (!replaced) {
      replaced = true;
      await rename(bindingPath, join(f.store, "original-binding-preserved"));
      await writeFile(bindingPath, "replacement", { mode: 0o600 });
    }
    return new Response("Not found", { status: 404 });
  };
  assert.deepEqual(await verifyMatrixHttpIsolation(f.root, f.expected, fakeFetch), { ok: false, code: "matrix_http_isolation_failed" });
  assert.equal(await readFile(bindingPath, "utf8"), "replacement");
  assert.equal(await readFile(join(f.store, "original-binding-preserved"), "utf8"), "original");
  assert.deepEqual(await readdir(f.spool), []);
});

test("HTTP 200, redirects, oversized denial bodies, ELF data and network failures all fail closed and clean canaries", async (t) => {
  const cases: readonly [string, typeof fetch][] = [
    ["200", async () => new Response("login", { status: 200 })],
    ["redirect", async () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.invalid" } })],
    ["oversized", async () => new Response("x".repeat(65 * 1024), { status: 404 })],
    ["ELF", async () => new Response(new Uint8Array(sidecar), { status: 404 })],
    ["binding disclosure", async () => new Response('{"device_id":"MUST_NOT_DISCLOSE","store_fingerprint":"value"}', { status: 404 })],
    ["intent disclosure", async () => new Response('{"bot_mxid":"MUST_NOT_DISCLOSE","nonce":"value"}', { status: 404 })],
    ["network", async () => { throw new Error("secret upstream response must not be returned"); }]
  ];
  for (const [name, fake] of cases) {
    await t.test(name, async (child) => {
      const f = await fixture(child);
      assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
      assert.deepEqual(await verifyMatrixHttpIsolation(f.root, f.expected, fake), { ok: false, code: "matrix_http_isolation_failed" });
      assert.deepEqual(await readdir(f.store), []);
      assert.deepEqual(await readdir(f.spool), []);
    });
  }
});

test("a misleading 404 containing the actual harmless canary is rejected", async (t) => {
  const f = await fixture(t);
  assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
  const fakeFetch: typeof fetch = async () => new Response(new Uint8Array(await readFile(join(f.store, (await readdir(f.store))[0]!))), { status: 404 });
  assert.deepEqual(await verifyMatrixHttpIsolation(f.root, f.expected, fakeFetch), { ok: false, code: "matrix_http_isolation_failed" });
  assert.deepEqual(await readdir(f.store), []);
  assert.deepEqual(await readdir(f.spool), []);
});

test("canary cleanup refuses to delete a replacement inode and reports the failure", async (t) => {
  const f = await fixture(t);
  assert.equal((await prepareMatrixRelease(f.root, f.expected)).ok, true);
  let replaced: string | undefined;
  let changing = false;
  const fakeFetch: typeof fetch = async () => {
    if (!changing) {
      changing = true;
      const name = (await readdir(f.store))[0]!;
      replaced = join(f.store, name);
      await rename(replaced, join(f.store, "relocated-original-canary"));
      await writeFile(replaced, "replacement-must-not-be-deleted", { mode: 0o600 });
    }
    return new Response("Not found", { status: 404 });
  };
  assert.deepEqual(await verifyMatrixHttpIsolation(f.root, f.expected, fakeFetch), { ok: false, code: "matrix_http_isolation_cleanup_failed" });
  assert.equal(await readFile(replaced!, "utf8"), "replacement-must-not-be-deleted");
  assert.deepEqual(await readdir(f.spool), []);
});
