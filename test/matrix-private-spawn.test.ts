import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withMatrixPrivateUmask } from "../src/godaddy/matrix-private-spawn.ts";

test("a real child creates private SDK-style files and host umask is restored", async t => {
  const root = await mkdtemp(join(tmpdir(), "matrix-umask-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.umask();
  const result = withMatrixPrivateUmask(() => spawnSync(process.execPath,
    ["-e", "require('node:fs').writeFileSync(process.argv[1], 'synthetic', {mode:0o666})", join(root, "media.sqlite3")],
    { env: {}, encoding: "utf8" }));
  assert.equal(result.status, 0); assert.equal(process.umask(), previous);
  assert.equal((await lstat(join(root, "media.sqlite3"))).mode & 0o077, 0);
  assert.throws(() => withMatrixPrivateUmask(() => { throw Error("synthetic spawn failed"); }), /synthetic/);
  assert.equal(process.umask(), previous);
});
