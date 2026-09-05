import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const clientPath = fileURLToPath(new URL("../src/settings/ui/client.js", import.meta.url));

test("settings browser client is valid JavaScript and carries only the full-object protected mutation flow", () => {
  execFileSync(process.execPath, ["--check", clientPath], { stdio: "pipe" });
  const source = readFileSync(clientPath, "utf8");

  assert.match(source, /fetch\(url, \{ method: url\.endsWith\("\/reset"\) \? "POST" : "PUT"/);
  assert.match(source, /"if-match": form\.dataset\.etag/);
  assert.match(source, /pendingMutation = \{ signature, key: idempotencyKey\(\) \}/);
  assert.match(source, /"idempotency-key": key/);
  assert.match(source, /"x-csrf-token": csrfToken/);
  assert.match(source, /credentials: "same-origin"/);
  assert.match(source, /response\.status === 409/);
  assert.match(source, /fetch\("\/api\/settings", \{ credentials: "same-origin" \}\)/);
  assert.match(source, /fetch\("\/api\/settings\/csrf"/);
  assert.match(source, /"x-owner-action-token": actionToken/);
  assert.match(source, /mode: "cors"/);
  assert.match(source, /setStatus\("success", "Набір сумісний\. Змін для збереження немає\.", "Набір сумісний"\)/);
  assert.doesNotMatch(source, /response\.status === 403[^}]+submit\(/s);
  assert.doesNotMatch(source, /oauth|password|api[_-]?key|fast mode|payg|credits/i);
});
