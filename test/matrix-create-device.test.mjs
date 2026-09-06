import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("manual Matrix device handoff passes its credential-free Python regression suite", () => {
  const result = spawnSync(process.env.PYTHON ?? "python3", ["test/matrix-create-device.test.py", "-q"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran [1-9][0-9]* tests/u);
});
