import assert from "node:assert/strict";
import test from "node:test";

import { createGoDaddyClaudeCodeProcess, type CommandRunner } from "../src/godaddy/claude-code-process.ts";
import { SafeConsiliumFailure } from "../src/consilium/failures.ts";
import { createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

const secretEnvironment = Object.freeze({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  CLAUDE_CODE_OAUTH_TOKEN: "a-test-only-subscription-token-that-never-leaves-this-test",
  DB_PASSWORD: "must-not-reach-the-child",
  SETTINGS_OWNER_PASSWORD: "must-not-reach-the-child"
});

const models = () => createCapabilityReceipt().claudeModels;

test("does not create a Claude process without a locally injected subscription token", () => {
  assert.equal(createGoDaddyClaudeCodeProcess({ environment: {}, getModels: models }), undefined);
});

test("checks only Claude subscription auth in a disposable, scrubbed child environment", async () => {
  const calls: Parameters<CommandRunner>[0][] = [];
  const run: CommandRunner = async (input) => {
    calls.push(input);
    return { exitCode: 0, stdout: '{"loggedIn":true}', stderr: "" };
  };
  const process = createGoDaddyClaudeCodeProcess({
    environment: secretEnvironment,
    getModels: models,
    executable: "/runtime/node_modules/.bin/claude",
    processRef: "claude-runtime-01",
    run
  });
  assert.notEqual(process, undefined);
  if (process === undefined) throw new Error("Expected process.");
  const status = await process.inspectSubscription();
  assert.equal(status.processRef, "claude-runtime-01");
  assert.equal(status.authMode, "claude_code_oauth");
  assert.equal(status.readiness, "ready");
  assert.equal(status.fastModeEnabled, false);
  assert.equal(status.extraUsageEnabled, false);
  assert.deepEqual(status.models, createCapabilityReceipt().claudeModels);
  const first = calls[0];
  assert.deepEqual(first?.arguments, ["auth", "status", "--json"]);
  assert.equal(first?.environment.CLAUDE_CODE_OAUTH_TOKEN, secretEnvironment.CLAUDE_CODE_OAUTH_TOKEN);
  assert.equal(first?.environment.CLAUDE_CODE_DISABLE_FAST_MODE, "1");
  assert.equal(first?.environment.DB_PASSWORD, undefined);
  assert.equal(first?.environment.SETTINGS_OWNER_PASSWORD, undefined);
  assert.equal(first?.environment.ANTHROPIC_API_KEY, undefined);
  assert.match(first?.cwd ?? "", /^\/private\/var\/folders\/|^\/var\/folders\/|^\/tmp\//u);
});

test("runs a critic with subscription OAuth only, no tools and no persistent conversation", async () => {
  const calls: Parameters<CommandRunner>[0][] = [];
  const run: CommandRunner = async (input) => {
    calls.push(input);
    return {
      exitCode: 0,
      stdout: JSON.stringify({ result: "Повна критична відповідь.", session_id: "claude-turn-01" }),
      stderr: ""
    };
  };
  const process = createGoDaddyClaudeCodeProcess({
    environment: secretEnvironment,
    getModels: models,
    processRef: "claude-runtime-01",
    run
  });
  if (process === undefined) throw new Error("Expected process.");
  const completed = await process.runCritique({
    modelId: "claude-current-critic",
    runtimeModelId: "sonnet",
    reasoningEffort: "high",
    prompt: "Перевірте припущення."
  });
  assert.deepEqual(completed, { turnRef: "claude-turn-01", body: "Повна критична відповідь." });
  assert.deepEqual(calls[0]?.arguments, [
    "--print",
    "--output-format", "json",
    "--no-session-persistence",
    "--safe-mode",
    "--restricted",
    "--tools", "",
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--model", "sonnet",
    "--effort", "high",
    "Перевірте припущення."
  ]);
  assert.equal(calls[0]?.environment.CLAUDE_CODE_OAUTH_TOKEN, secretEnvironment.CLAUDE_CODE_OAUTH_TOKEN);
  assert.equal(calls[0]?.environment.DB_PASSWORD, undefined);
});

test("fails closed for a rejected authentication check or malformed completion", async () => {
  const rejected = createGoDaddyClaudeCodeProcess({
    environment: secretEnvironment,
    getModels: models,
    run: async () => ({ exitCode: 1, stdout: "", stderr: "" })
  });
  if (rejected === undefined) throw new Error("Expected process.");
  const status = await rejected.inspectSubscription();
  assert.equal(status.authMode, "other");
  assert.equal(status.readiness, "auth_required");

  const malformed = createGoDaddyClaudeCodeProcess({
    environment: secretEnvironment,
    getModels: models,
    run: async () => ({ exitCode: 0, stdout: "not-json", stderr: "" })
  });
  if (malformed === undefined) throw new Error("Expected process.");
  await assert.rejects(
    malformed.runCritique({ modelId: "claude-current-critic", runtimeModelId: "sonnet", reasoningEffort: "low", prompt: "Перевірте." }),
    (error: unknown) => error instanceof SafeConsiliumFailure && error.message === "claude_invalid_completion"
  );
});
