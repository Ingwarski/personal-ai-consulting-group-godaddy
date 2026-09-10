import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, realpath, rm, writeFile, symlink, link, utimes, chmod, readFile, rename } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { matrixPositiveControlResponse } from "../src/godaddy/matrix-positive-control.ts";
import { createGodaddyServer } from "../src/godaddy/server.mjs";
import { createGoDaddySettingsRuntime } from "../src/godaddy/settings-runtime.ts";

const path = `/assets/matrix-isolation-positive-${"a".repeat(32)}.txt`;
const marker = `matrix-isolation-positive:${"b".repeat(32)}`;
const request = (suffix = path, method = "GET") => new Request(`https://preview.test${suffix}`, { method });
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "matrix-positive-control-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "public", "assets"), { recursive: true, mode: 0o700 });
  return { root, target: join(root, "public", path) };
}

test("actual HTTP server serves only the fresh harmless public control, not arbitrary assets", async t => {
  const f = await fixture(t); await writeFile(f.target, marker, { mode: 0o644 });
  const server = createGodaddyServer({ environment: { RUNTIME_MODE: "development" }, nodeVersion: "v22.23.2",
    settingsRuntime: { configured: false, handle: (r: Request) => matrixPositiveControlResponse(r, f.root), close: async () => {} } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(origin + path);
  assert.equal(response.status, 200); assert.equal(await response.text(), marker);
  assert.equal(response.headers.get("x-matrix-control-result"), "ok");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type")!, /text\/plain/);
  for (const privatePath of ["/assets/.personal-consultant-matrix-v1/crypto-store/device-binding.json",
    "/public" + path, "/assets/other.txt", "/runtime/matrix/personal-consultant-matrix-setup"]) {
    assert.equal((await fetch(origin + privatePath)).status, 404);
  }
  assert.equal(await readFile(f.target, "utf8"), marker);
});

test("control freshness tolerates only the filesystem sub-millisecond precision difference", async t => {
  const f = await fixture(t); await writeFile(f.target, marker, { mode: 0o644 });
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  await utimes(f.target, now / 1_000, (now + 0.5) / 1_000);
  const fresh = await matrixPositiveControlResponse(request(), f.root);
  assert.equal(fresh?.status, 200);
  assert.equal(fresh?.headers.get("x-matrix-control-result"), "ok");
  await utimes(f.target, now / 1_000, (now + 2_000) / 1_000);
  const future = await matrixPositiveControlResponse(request(), f.root);
  assert.equal(future?.status, 404);
  assert.equal(future?.headers.get("x-matrix-control-result"), "expired_file");
});

test("control reader rejects missing, stale, malformed, oversized, linked and unsafe files", async t => {
  for (const kind of ["missing", "stale", "body", "large", "symlink", "hardlink", "permissions"] as const) {
    const f = await fixture(t);
    if (kind !== "missing") await writeFile(f.target, kind === "body" ? '{"access_token":"MUST_NOT_LEAK"}'
      : kind === "large" ? "x".repeat(129) : marker, { mode: 0o644 });
    // Filesystem sub-millisecond mtime can be ahead of integer Date.now().
    // Keep non-expiry fixtures unambiguously in the past; test stale separately.
    if (kind !== "missing") { const past = new Date(Date.now() - 1_000); await utimes(f.target, past, past); }
    if (kind === "stale") await utimes(f.target, new Date(0), new Date(0));
    if (kind === "permissions") await chmod(f.target, 0o666);
    if (kind === "symlink") { await rm(f.target); await writeFile(join(f.root, "secret"), marker); await symlink(join(f.root, "secret"), f.target); }
    if (kind === "hardlink") await link(f.target, join(f.root, "linked"));
    const response = await matrixPositiveControlResponse(request(), f.root);
    assert.equal(response?.status, 404, kind); assert.doesNotMatch(await response!.text(), /MUST_NOT_LEAK|matrix-isolation-positive:/);
    const expected = { missing: "missing_file", stale: "expired_file", body: "invalid_marker",
      large: "unsafe_file", symlink: "unsafe_file", hardlink: "unsafe_file", permissions: "unsafe_file" };
    assert.equal(response?.headers.get("x-matrix-control-result"), expected[kind]);
  }
});

test("safe marker diagnostics distinguish missing or unsafe ancestors without revealing paths", async t => {
  const f = await fixture(t);
  await rm(join(f.root, "public", "assets"), { recursive: true });
  assert.equal((await matrixPositiveControlResponse(request(), f.root))?.headers.get("x-matrix-control-result"), "missing_directory");
  await mkdir(join(f.root, "public", "assets"), { mode: 0o700 });
  await chmod(join(f.root, "public", "assets"), 0o777);
  const response = await matrixPositiveControlResponse(request(), f.root);
  assert.equal(response?.headers.get("x-matrix-control-result"), "unsafe_directory");
  assert.equal(await response!.text(), "Not found.");
});

test("ENOENT after an ancestor is replaced cannot be classified as missing_file", async t => {
  const f = await fixture(t); const originalOpen = fs.open;
  let changed = false;
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === f.target && !changed) {
      changed = true;
      await rename(join(f.root, "public", "assets"), join(f.root, "original-assets"));
      await mkdir(join(f.root, "public", "assets"), { mode: 0o700 });
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    const response = await matrixPositiveControlResponse(request(), f.root);
    assert.equal(changed, true); assert.equal(response?.status, 404);
    assert.equal(response?.headers.get("x-matrix-control-result"), "unsafe_directory");
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("control route rejects state-bearing requests and does not configure stateless Preview or open a pool", async () => {
  const runtime = createGoDaddySettingsRuntime({ RUNTIME_MODE: "development" }, {
    createPool: () => { assert.fail("read-only verifier must not create a pool"); }
  });
  for (const req of [request(path + "?token=forbidden"), request(path, "POST")]) {
    assert.equal((await runtime.handle(req))?.status, 400);
  }
  assert.equal((await runtime.handle(request()))?.status, 404);
  assert.equal(await runtime.handle(request("/assets/other.txt")), undefined);
  assert.equal(runtime.configured, false); await runtime.close();
});
