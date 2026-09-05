import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeDiscoveryFailure, createGoDaddyClaudeCodeProcess, type CommandRunner } from "../src/godaddy/claude-code-process.ts";
import { SafeConsiliumFailure } from "../src/consilium/failures.ts";
import { createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

const secretEnvironment = Object.freeze({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  CLAUDE_CODE_OAUTH_TOKEN: "a-test-only-subscription-token-that-never-leaves-this-test",
  DB_PASSWORD: "must-not-reach-the-child",
  SETTINGS_OWNER_PASSWORD: "must-not-reach-the-child"
});

const models = () => createCapabilityReceipt().claudeModels;
const authenticatedStatus = JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" });

test("does not create a Claude process without a locally injected subscription token", () => {
  assert.equal(createGoDaddyClaudeCodeProcess({ environment: {}, getModels: models }), undefined);
});

test("checks only Claude subscription auth in a disposable, scrubbed child environment", async () => {
  const calls: Parameters<CommandRunner>[0][] = [];
  const run: CommandRunner = async (input) => {
    calls.push(input);
    return { exitCode: 0, stdout: authenticatedStatus, stderr: "" };
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

test("probes exact current Claude models and exposes only the usable per-model efforts", async () => {
  const calls: Parameters<CommandRunner>[0][] = [];
  const run: CommandRunner = async (input) => {
    calls.push(input);
    if (input.arguments[0] === "auth") return { exitCode: 0, stdout: authenticatedStatus, stderr: "" };
    const effortIndex = input.arguments.indexOf("--effort");
    const effort = effortIndex === -1 ? null : input.arguments[effortIndex + 1];
    const model = input.arguments[input.arguments.indexOf("--model") + 1];
    if ((model === "claude-opus-5" || model === "claude-opus-4-8") && effort !== "xhigh") {
      return { exitCode: 0, stdout: JSON.stringify({ result: "READY", session_id: `${model}-${effort}` }), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "" };
  };
  const process = createGoDaddyClaudeCodeProcess({
    environment: secretEnvironment,
    getModels: models,
    run
  });
  if (process === undefined) throw new Error("Expected process.");
  assert.deepEqual(await process.discoverModels(), [
    {
      productId: "claude-opus-5",
      displayName: "Claude Opus 5",
      runtimeModelId: "claude-opus-5",
      availability: "available",
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
      reasoningMappings: { low: "low", medium: "medium", high: "high", max: "max" }
    },
    {
      productId: "claude-opus-4-8",
      displayName: "Claude Opus 4.8",
      runtimeModelId: "claude-opus-4-8",
      availability: "available",
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
      reasoningMappings: { low: "low", medium: "medium", high: "high", max: "max" }
    }
  ]);
  assert.equal(calls.some((call) => call.arguments.includes("claude-opus-5")), true);
  assert.equal(calls.some((call) => call.arguments.includes("claude-opus-4-8")), true);
  assert.equal(calls.some((call) => call.arguments.includes("opus")), false);
});

test("Claude readiness rejects unsuccessful, malformed and non-subscription status despite exit zero", async () => {
  for (const stdout of ['{"loggedIn":false}', '{}', 'not-json', 'null', '[]',
    JSON.stringify({ loggedIn: "true", authMethod: "oauth_token", apiProvider: "firstParty" }),
    JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }),
    JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "bedrock" })]) {
    let calls = 0;
    const runtime = createGoDaddyClaudeCodeProcess({ environment: secretEnvironment, getModels: models,
      run: async () => { calls++; return { exitCode: 0, stdout, stderr: "" }; } })!;
    assert.equal((await runtime.inspectSubscription()).readiness, "auth_required");
    await assert.rejects(runtime.discoverModels(), (error: unknown) => error instanceof ClaudeDiscoveryFailure && error.code === "claude_auth_rejected");
    assert.equal(calls, 2, "no generation after an invalid status response");
  }
});

test("Claude discovery reports only safe failure categories and stops repeated global failures", async () => {
  for (const [message, code] of [
    ['401 authentication_error invalid token SECRET-MARKER', 'claude_auth_rejected'],
    ['API Error: 403 SECRET-MARKER', 'claude_access_denied'],
    ['429 rate_limit_error SECRET-MARKER', 'claude_quota_blocked'],
    ["unknown option '--safe-mode' SECRET-MARKER", 'claude_cli_incompatible'],
    ['model not available SECRET-MARKER', 'claude_models_unavailable'],
    ['command failed SECRET-MARKER', 'claude_process_failed']
  ] as const) {
    let generations = 0;
    const runtime = createGoDaddyClaudeCodeProcess({ environment: secretEnvironment, getModels: models,
      run: async ({ arguments: args }) => {
        if (args[0] === 'auth') return { exitCode: 0, stdout: authenticatedStatus, stderr: '' };
        generations++;
        return { exitCode: 1, stdout: '', stderr: message };
      } })!;
    await assert.rejects(runtime.discoverModels(), (error: unknown) => {
      assert.ok(error instanceof ClaudeDiscoveryFailure);
      assert.equal(error.code, code);
      assert.doesNotMatch(String(error), /SECRET-MARKER/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(generations, ['claude_auth_rejected', 'claude_quota_blocked', 'claude_cli_incompatible'].includes(code) ? 1 : 6);
  }
});

test("Claude error envelopes are not successful model completions even with exit zero", async () => {
  const runtime = createGoDaddyClaudeCodeProcess({ environment: { ...secretEnvironment, CLAUDE_CODE_MODEL_CANDIDATES: 'claude-opus-5' }, getModels: models,
    run: async ({ arguments: args }) => args[0] === 'auth' ? { exitCode: 0, stdout: authenticatedStatus, stderr: '' } : {
      exitCode: 0, stdout: JSON.stringify({ is_error: true, subtype: 'error_during_execution', result: 'Failure', session_id: 'test-id' }), stderr: ''
    } })!;
  await assert.rejects(runtime.discoverModels(), (error: unknown) => error instanceof ClaudeDiscoveryFailure && error.code === 'claude_invalid_response');
  await assert.rejects(runtime.runCritique({ modelId: 'claude-opus-5', runtimeModelId: 'claude-opus-5', reasoningEffort: null, prompt: 'Test.' }), /claude_invalid_completion/);
});

test("Claude failure diagnostics retain only bounded numeric fields and fixed categories", () => {
  const failure = new ClaudeDiscoveryFailure('claude_process_failed', { exitCode: 1,
    stdout: JSON.stringify({ api_error_status: 403, terminal_reason: 'api_error', result: 'SECRET-MARKER insufficient_scope', session_id: 'PRIVATE-ID' }),
    stderr: '/private/SECRET-PATH' });
  assert.deepEqual(failure.diagnostic, { exit_code: 1, termination: 'exited', api_status: 403, json_object: true,
    stdout_present: true, stderr_present: true, terminal_reason: 'api_error', failure_hint: 'oauth_scope' });
  assert.doesNotMatch(JSON.stringify(failure), /SECRET|PRIVATE/);
  const untrusted = new ClaudeDiscoveryFailure('claude_process_failed', { exitCode: 100000,
    stdout: JSON.stringify({ api_error_status: 'SECRET', terminal_reason: 'SECRET' }), stderr: '' });
  assert.equal(untrusted.diagnostic?.exit_code, null);
  assert.equal(untrusted.diagnostic?.api_status, null);
  assert.equal(untrusted.diagnostic?.terminal_reason, 'other_or_absent');
  assert.doesNotMatch(JSON.stringify(untrusted), /SECRET/);
  const errorArray = new ClaudeDiscoveryFailure('claude_access_denied', { exitCode: 1,
    stdout: JSON.stringify({ api_error_status: 403, errors: ['Account is not a member of the organization SECRET-MARKER'], terminal_reason: 'api_error' }), stderr: '' });
  assert.equal(errorArray.diagnostic?.failure_hint, 'organization');
  assert.doesNotMatch(JSON.stringify(errorArray), /SECRET/);
});
