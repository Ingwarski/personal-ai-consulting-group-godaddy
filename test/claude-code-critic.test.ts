import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeCodeCriticRuntime, type ClaudeCodeSubscriptionProcess, type ClaudeCodeSubscriptionStatus } from "../src/runtime/claude-code-critic.ts";
import type { ConsiliumEvidence } from "../src/consilium/router.ts";
import { createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

const evidence: readonly ConsiliumEvidence[] = [
  { fromRole: "Фінансовий консультант", body: "Повна фінансова позиція." },
  { fromRole: "Стратег", body: "Повна стратегічна позиція." }
];

function readyStatus(overrides: Partial<ClaudeCodeSubscriptionStatus> = {}): ClaudeCodeSubscriptionStatus {
  const receipt = createCapabilityReceipt();
  return {
    processRef: "claude-critic-process-01",
    authMode: "claude_code_oauth",
    readiness: "ready",
    privateSingleOwner: true,
    bareMode: false,
    fastModeEnabled: false,
    extraUsageEnabled: false,
    models: receipt.claudeModels,
    ...overrides
  };
}

test("runs the Claude critic only through one ready subscription process and emits its full completion", async () => {
  const calls: string[] = [];
  const process: ClaudeCodeSubscriptionProcess = {
    inspectSubscription: async () => readyStatus(),
    runCritique: async (input) => {
      calls.push(`${input.modelId}:${input.reasoningEffort}`);
      assert.match(input.prompt, /Повна фінансова позиція/);
      return { turnRef: "claude-turn-critic-0001", body: "Повна незалежна критика." };
    }
  };
  const critic = new ClaudeCodeCriticRuntime({
    registration: { agentId: "critic", role: "Критик", provider: "claude_code", runtimeSessionRef: "claude-critic-process-01" },
    process,
    headAgentId: "head",
    modelId: "claude-current-critic",
    reasoningEffort: "high"
  });
  const emitted: unknown[] = [];
  await critic.run({ phase: "critique", sessionGeneration: 1, task: "Дай рішення.", assignment: "Дайте критичну репліку.", evidence }, async (message) => { emitted.push(message); });
  assert.deepEqual(calls, ["claude-current-critic:high"]);
  assert.deepEqual(emitted, [{
    messageId: "pc-claude-400d461a0496045535f7ea2e469db4716b47f6ad9dbb73643b9ddcbfdda492ea",
    kind: "critique",
    toAgentId: "head",
    body: "Повна незалежна критика."
  }]);
});

test("fails closed before content leaves the process for Fast Mode, wrong auth, bare mode or effort downgrade", async () => {
  const blocked: ClaudeCodeSubscriptionProcess = {
    inspectSubscription: async () => readyStatus({ fastModeEnabled: true }),
    runCritique: async () => { throw new Error("Must not execute."); }
  };
  const critic = new ClaudeCodeCriticRuntime({
    registration: { agentId: "critic", role: "Критик", provider: "claude_code", runtimeSessionRef: "claude-critic-process-01" },
    process: blocked,
    headAgentId: "head",
    modelId: "claude-current-critic",
    reasoningEffort: "high"
  });
  await assert.rejects(
    critic.run({ phase: "critique", sessionGeneration: 1, task: "Дай рішення.", assignment: "Дайте критичну репліку.", evidence }, async () => {}),
    { name: "SafeConsiliumFailure", message: "claude_paid_acceleration_forbidden" }
  );

  const noXhigh: ClaudeCodeSubscriptionProcess = {
    inspectSubscription: async () => readyStatus(),
    runCritique: async () => { throw new Error("Must not execute."); }
  };
  const highCritic = new ClaudeCodeCriticRuntime({
    registration: { agentId: "critic", role: "Критик", provider: "claude_code", runtimeSessionRef: "claude-critic-process-01" },
    process: noXhigh,
    headAgentId: "head",
    modelId: "claude-current-critic",
    reasoningEffort: "xhigh"
  });
  await assert.rejects(
    highCritic.run({ phase: "critique", sessionGeneration: 1, task: "Дай рішення.", assignment: "Дайте критичну репліку.", evidence }, async () => {}),
    { name: "SafeConsiliumFailure", message: "claude_effort_unavailable" }
  );
});
