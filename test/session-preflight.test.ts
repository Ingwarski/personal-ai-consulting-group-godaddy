import assert from "node:assert/strict";
import test from "node:test";

import type { ClaudeCodeSubscriptionProcess, ClaudeCodeSubscriptionStatus } from "../src/runtime/claude-code-critic.ts";
import { preflightSessionSubscriptions } from "../src/runtime/session-preflight.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

const runtimeResponses: Record<string, unknown> = {
  "account/read": { account: { type: "chatgpt", planType: "subscription" } },
  "model/list": {
    data: [{
      id: "codex-current-primary",
      model: "codex-runtime-primary",
      displayName: "Current Codex",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }]
    }]
  },
  "account/rateLimits/read": { rateLimits: { rateLimitReachedType: null } }
};

function snapshot() {
  const receipt = createCapabilityReceipt();
  const resolved = resolveEffectiveSessionSnapshot({
    sessionId: "preflight-session",
    settingsRevision: 2,
    settings: receipt.defaults,
    capabilityReceipt: receipt
  }, activeNow);
  if (!resolved.ok) throw new Error("Expected test snapshot.");
  return { receipt, snapshot: resolved.value };
}

function readyClaude(overrides: Partial<ClaudeCodeSubscriptionStatus> = {}): ClaudeCodeSubscriptionProcess {
  const receipt = createCapabilityReceipt();
  return {
    inspectSubscription: async () => ({
      processRef: "claude-critic-process-01",
      authMode: "claude_code_oauth",
      readiness: "ready",
      privateSingleOwner: true,
      bareMode: false,
      fastModeEnabled: false,
      extraUsageEnabled: false,
      models: receipt.claudeModels,
      ...overrides
    }),
    runCritique: async () => ({ turnRef: "unused", body: "unused" })
  };
}

test("permits a new session only when both live subscription runtimes exactly match the immutable snapshot", async () => {
  const values = snapshot();
  const result = await preflightSessionSubscriptions({
    environment: { RUNTIME_MODE: "test" },
    snapshot: values.snapshot,
    capabilityReceipt: values.receipt,
    codexTransport: { request: async (method) => runtimeResponses[method] },
    claudeProcess: readyClaude(),
    privateSingleOwner: true,
    now: activeNow
  });
  assert.equal(result.ok, true);
});

test("fails before launch for catalog drift, forbidden credentials, Claude Fast Mode and a runtime effort downgrade", async () => {
  const values = snapshot();
  const catalogMismatch = await preflightSessionSubscriptions({
    environment: { RUNTIME_MODE: "test" },
    snapshot: { ...values.snapshot, catalogVersion: "old-catalog" },
    capabilityReceipt: values.receipt,
    codexTransport: { request: async (method) => runtimeResponses[method] },
    claudeProcess: readyClaude(),
    privateSingleOwner: true,
    now: activeNow
  });
  assert.deepEqual(catalogMismatch, { ok: false, code: "catalog_version_mismatch" });

  const forbidden = await preflightSessionSubscriptions({
    environment: { RUNTIME_MODE: "test", ANTHROPIC_API_KEY: "not-used" },
    snapshot: values.snapshot,
    capabilityReceipt: values.receipt,
    codexTransport: { request: async (method) => runtimeResponses[method] },
    claudeProcess: readyClaude(),
    privateSingleOwner: true,
    now: activeNow
  });
  assert.deepEqual(forbidden, { ok: false, code: "forbidden_environment" });

  const fast = await preflightSessionSubscriptions({
    environment: { RUNTIME_MODE: "test" },
    snapshot: values.snapshot,
    capabilityReceipt: values.receipt,
    codexTransport: { request: async (method) => runtimeResponses[method] },
    claudeProcess: readyClaude({ fastModeEnabled: true }),
    privateSingleOwner: true,
    now: activeNow
  });
  assert.deepEqual(fast, { ok: false, code: "claude_paid_acceleration_forbidden" });

  const runtimeDowngrade = await preflightSessionSubscriptions({
    environment: { RUNTIME_MODE: "test" },
    snapshot: values.snapshot,
    capabilityReceipt: values.receipt,
    codexTransport: { request: async (method) => runtimeResponses[method] },
    claudeProcess: readyClaude({
      models: [{
        ...values.receipt.claudeModels[0]!,
        supportedReasoningDepths: ["low", "medium"],
        reasoningMappings: { low: "low", medium: "medium" }
      }]
    }),
    privateSingleOwner: true,
    now: activeNow
  });
  assert.deepEqual(runtimeDowngrade, { ok: false, code: "claude_effort_unavailable" });
});
