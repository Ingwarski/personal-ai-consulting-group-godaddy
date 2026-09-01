import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeCapabilityCatalog } from "../src/runtime/capability-catalog.ts";
import { probeCodexAppServer } from "../src/runtime/codex-app-server.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

async function readyCodex() {
  return probeCodexAppServer({
    request: async (method) => {
      if (method === "account/read") return { account: { type: "chatgpt", planType: "subscription" } };
      if (method === "model/list") return { data: [{
        id: "runtime-codex", model: "runtime-codex", displayName: "Runtime Codex", hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }]
      }] };
      return { rateLimits: { rateLimitReachedType: null } };
    }
  }, { privateSingleOwner: true });
}

test("a capability catalog requires explicit whole defaults and both live subscription runtime reports", async () => {
  const codex = await readyCodex();
  const source = createCapabilityReceipt();
  const claude = {
    runtime: {
      authMode: "claude_code_oauth" as const,
      readiness: "ready" as const,
      privateSingleOwner: true,
      availableModelIds: ["runtime-claude"],
      fastModeEnabled: false,
      extraUsageEnabled: false
    },
    models: [{
      productId: "runtime-claude", displayName: "Runtime Claude", runtimeModelId: "runtime-claude", availability: "available" as const,
      supportedReasoningDepths: ["low", "medium", "high"] as const,
      reasoningMappings: { low: "low", medium: "medium", high: "high" }
    }]
  };
  const result = createRuntimeCapabilityCatalog({
    codex,
    claude,
    defaults: { codexModelId: "runtime-codex", claudeModelId: "runtime-claude", reasoningDepth: "high", speedPreset: source.defaults.speedPreset },
    catalogVersion: "runtime-catalog-1",
    issuedAt: activeNow,
    expiresAt: new Date("2026-08-16T12:05:00.000Z")
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.receipt.defaults.codexModelId, "runtime-codex");
});

test("catalog issuance blocks paid Claude acceleration and never selects a replacement default", async () => {
  const codex = await readyCodex();
  const source = createCapabilityReceipt();
  const base = {
    codex,
    claude: {
      runtime: { authMode: "claude_code_oauth" as const, readiness: "ready" as const, privateSingleOwner: true, availableModelIds: ["runtime-claude"], fastModeEnabled: true, extraUsageEnabled: false },
      models: [{ productId: "runtime-claude", displayName: "Runtime Claude", runtimeModelId: "runtime-claude", availability: "available" as const, supportedReasoningDepths: ["low", "medium", "high"] as const, reasoningMappings: { low: "low", medium: "medium", high: "high" } }]
    },
    defaults: { codexModelId: "runtime-codex", claudeModelId: "runtime-claude", reasoningDepth: "high" as const, speedPreset: source.defaults.speedPreset },
    catalogVersion: "runtime-catalog-1", issuedAt: activeNow, expiresAt: new Date("2026-08-16T12:05:00.000Z")
  };
  assert.deepEqual(createRuntimeCapabilityCatalog(base), { ok: false, code: "claude_paid_acceleration_forbidden" });
  assert.deepEqual(createRuntimeCapabilityCatalog({ ...base, claude: { ...base.claude, runtime: { ...base.claude.runtime, fastModeEnabled: false } }, defaults: { ...base.defaults, codexModelId: "not-selected" } }), { ok: false, code: "invalid_defaults" });
});
