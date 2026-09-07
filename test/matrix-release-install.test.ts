import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectMatrixRelease, prepareMatrixRelease, verifyMatrixHttpIsolation, type MatrixReleaseExpectation, type MatrixIsolationDiagnostics } from "../src/godaddy/matrix-release-install.ts";
import { runMatrixBrowserChecks } from "../src/godaddy/matrix-browser-isolation.ts";
import { matrixPositiveControlResponse } from "../src/godaddy/matrix-positive-control.ts";
import { createGodaddyServer } from "../src/godaddy/server.mjs";

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
  assert.equal(urls.filter((url) => url.includes("/crypto-store/private-path-check-")).length, 0);
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
  assert.equal(urls.some((url) => url.includes("/crypto-store/private-path-check-")), false);
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

test("authenticated browser proof retains exact files, checks Published control twice and cleans owned probes", async (t) => {
  const f = await fixture(t); await prepareMatrixRelease(f.root, f.expected);
  let controls = 0;
  const anonymous: typeof fetch = async input => {
    if (String(input).includes("/assets/matrix-isolation-positive-")) {
      controls++; return (await matrixPositiveControlResponse(new Request(String(input)), f.root))!;
    }
    return new Response("Denied", { status: String(input).includes(".preview.") ? 401 : 404 });
  };
  let challenges = 0;
  const result = await verifyMatrixHttpIsolation(f.root, f.expected, anonymous, {}, async challenge => {
    challenges++;
    assert.ok(challenge.paths.filter(path => path.includes("/crypto-store/") || path.includes("/media-spool/"))
      .every(path => !path.split("/").at(-1)!.startsWith(".")));
    assert.equal((await readdir(f.store)).length, 1); assert.equal((await readdir(f.spool)).length, 1);
    return runMatrixBrowserChecks(challenge, async path => String(path) === challenge.positivePath
      ? (await matrixPositiveControlResponse(new Request("https://preview.test" + path), f.root))!
      : new Response("Not found", { status: 404 }));
  });
  assert.deepEqual(result, { ok: true, checkedPaths: 12, credentialReadiness: "http_isolation_verified", evidenceKind: "browser_assisted_http_isolation",
    controlVisibility: "published_control_visible_in_preview" });
  assert.equal(controls, 2);
  assert.equal(challenges, 1); assert.deepEqual(await readdir(f.store), []); assert.deepEqual(await readdir(f.spool), []);
  assert.deepEqual(await readdir(join(f.root, "public", "assets")), [".personal-consultant-matrix-v1"]);
});

test("browser fallback cannot override Published denial failure, Preview leakage, redirects or server errors", async (t) => {
  for (const [published, preview, body] of [[200, 401, "login"], [404, 500, "error"], [404, 302, "redirect"],
    [404, 404, "\u007fELF"], [404, 404, '{"device_id":"private"}']] as const) {
    const f = await fixture(t); await prepareMatrixRelease(f.root, f.expected); let called = false;
    const result = await verifyMatrixHttpIsolation(f.root, f.expected, async input => new Response(String(input).includes(".preview.") ? body : "not found",
      { status: String(input).includes(".preview.") ? preview : published }), {}, async () => { called = true; return {}; });
    assert.equal(result.ok, false); assert.equal(called, false); assert.deepEqual(await readdir(f.store), []);
  }
});

test("real HTTP with separate Published and stateless Preview roots verifies exact private paths without shared-file assumptions", async t => {
  const published = await fixture(t); const preview = await fixture(t);
  await prepareMatrixRelease(published.root, published.expected);
  const serve = async (root: string) => {
    const server = createGodaddyServer({ environment: { RUNTIME_MODE: "development" }, nodeVersion: "v22.23.2",
      settingsRuntime: { configured: false, handle: (request: Request) => matrixPositiveControlResponse(request, root), close: async () => {} } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve())); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  const publishedOrigin = await serve(published.root); const previewOrigin = await serve(preview.root);
  let controls = 0; let previewReads = 0;
  const result = await verifyMatrixHttpIsolation(published.root, published.expected, async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname.includes(".preview.")) return new Response("GoDaddy login boundary fixture", { status: 401 });
    if (url.pathname.includes("matrix-isolation-positive-")) controls++;
    return fetch(publishedOrigin + url.pathname, init);
  }, {}, challenge => runMatrixBrowserChecks(challenge, async (input, init) => {
    previewReads++; return fetch(previewOrigin + input, init);
  }));
  assert.deepEqual(result, { ok: true, checkedPaths: 12, credentialReadiness: "http_isolation_verified",
    evidenceKind: "browser_assisted_http_isolation", controlVisibility: "published_control_not_visible_in_preview" });
  assert.equal(controls, 2); assert.equal(previewReads, 7);
  assert.deepEqual(await readdir(published.store), []); assert.deepEqual(await readdir(published.spool), []);
  assert.deepEqual(await readdir(join(published.root, "public", "assets")), [".personal-consultant-matrix-v1"]);
  assert.deepEqual(await readdir(join(preview.root, "public", "assets")), []);
});

test("safe Preview missing_file cannot waive an invalid Published positive control before or after browser proof", async t => {
  for (const when of ["before", "after"] as const) for (const kind of ["404", "header", "body", "oversized", "network"] as const) {
    const f = await fixture(t); await prepareMatrixRelease(f.root, f.expected);
    let controls = 0; let called = false;
    const result = await verifyMatrixHttpIsolation(f.root, f.expected, async (input, init) => {
      if (String(input).includes("/assets/matrix-isolation-positive-")) {
        assert.equal(init?.credentials, "omit"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
        controls++;
        const actual = (await matrixPositiveControlResponse(new Request(String(input)), f.root))!;
        if (controls === (when === "before" ? 1 : 2)) {
          if (kind === "network") throw new Error("test network failure");
          return new Response(kind === "header" ? await actual.text() : kind === "oversized" ? "x".repeat(129) : "wrong",
            { status: kind === "404" ? 404 : 200, headers: kind === "header" ? {} : { "x-matrix-control-result": "ok" } });
        }
        return actual;
      }
      return new Response("Not found", { status: String(input).includes(".preview.") ? 401 : 404 });
    }, {}, challenge => {
      called = true;
      return runMatrixBrowserChecks(challenge, async path => new Response("Not found.", { status: 404,
        headers: String(path) === challenge.positivePath ? { "x-matrix-control-result": "missing_file" } : {} }));
    });
    assert.equal(result.ok, false, `${when}/${kind}`); assert.equal(called, when === "after");
    assert.deepEqual(await readdir(f.store), []); assert.deepEqual(await readdir(f.spool), []);
    assert.deepEqual(await readdir(join(f.root, "public", "assets")), [".personal-consultant-matrix-v1"]);
  }
});

test("owner diagnostics identify a failed probe without returning URL, canary, response or network error text", async (t) => {
  const f = await fixture(t); await prepareMatrixRelease(f.root, f.expected);
  const observations: MatrixIsolationDiagnostics[] = [];
  const result = await verifyMatrixHttpIsolation(f.root, f.expected, async input => {
    const url = String(input);
    if (!url.includes(".preview.")) return new Response("not found", { status: 404 });
    if (url.endsWith(SIDECAR)) throw new Error("PRIVATE_NETWORK_DETAIL");
    return new Response("PRIVATE_RESPONSE_DETAIL", { status: 503 });
  }, {}, () => { assert.fail("503 cannot enter browser fallback"); }, value => { observations.push(value); });
  assert.equal(result.ok, false);
  const last = observations.at(-1)!;
  assert.equal(last.stage, "anonymous_http"); assert.equal(last.probes.length, 12);
  assert.deepEqual(last.probes[6], { environment: "preview", target: "store_assets", status: 503, denied: false });
  assert.deepEqual(last.probes[10], { environment: "preview", target: "sidecar", status: null, denied: false });
  assert.deepEqual(last.probes[0], { environment: "published", target: "store_assets", status: 404, denied: true });
  assert.doesNotMatch(JSON.stringify(observations), /PRIVATE_|https:|private-path-check|matrix-private-path-canary|airoapp/);
  assert.deepEqual(await readdir(f.store), []); assert.deepEqual(await readdir(f.spool), []);
});

test("browser abort, mismatched challenge and tampered retained canary never grant readiness", async (t) => {
  for (const kind of ["abort", "nonce", "canary"] as const) {
    const f = await fixture(t); await prepareMatrixRelease(f.root, f.expected);
    let called = false;
    const result = await verifyMatrixHttpIsolation(f.root, f.expected, async input =>
      (await matrixPositiveControlResponse(new Request(String(input)), f.root))
        ?? new Response("denied", { status: String(input).includes(".preview.") ? 401 : 404 }), {}, async challenge => {
      called = true;
      if (kind === "abort") return undefined;
      const report = await runMatrixBrowserChecks(challenge, async path =>
        (await matrixPositiveControlResponse(new Request("https://preview.test" + path), f.root)) ?? new Response("not found", { status: 404 }));
      if (kind === "nonce") return { ...report, nonce: "stale" };
      await writeFile(join(f.store, (await readdir(f.store))[0]!), "changed"); return report;
    });
    assert.equal(called, true); assert.equal(result.ok, false); assert.deepEqual(await readdir(f.store), []); assert.deepEqual(await readdir(f.spool), []);
  }
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
