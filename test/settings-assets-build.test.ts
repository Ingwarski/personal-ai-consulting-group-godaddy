import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the protected static-asset build emits the canonical owner workspace assets", () => {
  execFileSync("npm", ["run", "build:settings-assets"], { cwd: repositoryRoot, stdio: "pipe" });

  const pairs = [
    ["src/settings/ui/styles.css", "dist/assets/settings.css"],
    ["src/settings/ui/client.js", "dist/assets/settings.js"],
    ["src/consultation/ui/client.js", "dist/assets/consultation.js"],
    ["src/instructions/ui/client.js", "dist/assets/instructions.js"]
  ];
  for (const [source, output] of pairs) {
    assert.equal(
      readFileSync(resolve(repositoryRoot, source), "utf8"),
      readFileSync(resolve(repositoryRoot, output), "utf8")
    );
  }
});
