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

test("a capability catalog accepts explicit whole defaults and both requested subscription runtime reports", async () => {
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
      supportedReasoningEfforts: ["low", "medium", "high"] as const,
      reasoningMappings: { low: "low", medium: "medium", high: "high" }
    }]
  };
  const result = createRuntimeCapabilityCatalog({
    codex,
    claude,
    defaults: {
      codex: { modelId: "runtime-codex", reasoningEffort: "high" },
      critic: { provider: "claude_code", claude: { modelId: "runtime-claude", reasoningEffort: "high" }, codex: null },
      speedPreset: source.defaults.speedPreset
    },
    catalogVersion: "runtime-catalog-1",
    issuedAt: activeNow,
    expiresAt: new Date("2026-08-16T12:05:00.000Z")
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.receipt.defaults.codex.modelId, "runtime-codex");
});

test("catalog issuance blocks paid Claude acceleration and never selects a replacement default", async () => {
  const codex = await readyCodex();
  const source = createCapabilityReceipt();
  const base = {
    codex,
    claude: {
      runtime: { authMode: "claude_code_oauth" as const, readiness: "ready" as const, privateSingleOwner: true, availableModelIds: ["runtime-claude"], fastModeEnabled: true, extraUsageEnabled: false },
      models: [{ productId: "runtime-claude", displayName: "Runtime Claude", runtimeModelId: "runtime-claude", availability: "available" as const, supportedReasoningEfforts: ["low", "medium", "high"] as const, reasoningMappings: { low: "low", medium: "medium", high: "high" } }]
    },
    defaults: {
      codex: { modelId: "runtime-codex", reasoningEffort: "high" as const },
      critic: { provider: "claude_code" as const, claude: { modelId: "runtime-claude", reasoningEffort: "high" as const }, codex: null },
      speedPreset: source.defaults.speedPreset
    },
    catalogVersion: "runtime-catalog-1", issuedAt: activeNow, expiresAt: new Date("2026-08-16T12:05:00.000Z")
  };
  assert.deepEqual(createRuntimeCapabilityCatalog(base), { ok: false, code: "claude_paid_acceleration_forbidden" });
  const unavailableDefaults = createRuntimeCapabilityCatalog({ ...base, claude: { ...base.claude, runtime: { ...base.claude.runtime, fastModeEnabled: false } }, defaults: { ...base.defaults, codex: { ...base.defaults.codex, modelId: "not-selected" } } });
  assert.equal(unavailableDefaults.ok, true);
  if (unavailableDefaults.ok) assert.equal(unavailableDefaults.receipt.defaults.codex.modelId, "not-selected");
});

test("Codex-only issuance preserves independent historical Claude freshness, including old envelopes", async () => {
  const codex = await readyCodex();
  const previous = createCapabilityReceipt({ issuedAt: "2026-08-14T00:00:00.000Z", expiresAt: "2026-08-15T00:00:00.000Z" });
  const input = { codex, previous, defaults: previous.defaults, catalogVersion: "fresh-codex", issuedAt: activeNow,
    expiresAt: new Date("2026-08-17T00:00:00.000Z") };
  const result = createRuntimeCapabilityCatalog(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.receipt.claudeModels, previous.claudeModels);
  assert.equal(result.receipt.providerReceipts?.claude_code.expiresAt, previous.expiresAt);
  assert.equal(result.receipt.providerReceipts?.codex.expiresAt, input.expiresAt.toISOString());
  const unavailable = { ...result.receipt.providerReceipts!.claude_code, status: "unavailable" as const, trusted: false };
  const next = createRuntimeCapabilityCatalog({ ...input, previous: { ...result.receipt,
    providerReceipts: { ...result.receipt.providerReceipts!, claude_code: unavailable } } });
  assert.equal(next.ok, true);
  if (next.ok) assert.deepEqual(next.receipt.providerReceipts?.claude_code, unavailable);
});

test("Astra needs exact runtime identity plus xhigh verification, not a product-name or model-default guess", async () => {
  const baseCodex = await readyCodex();
  const astra = { ...baseCodex.models[0]!, productId: "astra-product", runtimeModelId: "gpt-6-astra",
    supportedReasoningEfforts: ["high", "xhigh"], reasoningMappings: { high: "high", xhigh: "xhigh" } };
  const codex = { ...baseCodex, models: [...baseCodex.models, astra] };
  const input = { codex, defaults: createCapabilityReceipt().defaults, catalogVersion: "astra-catalog", issuedAt: activeNow,
    expiresAt: new Date("2026-08-17T00:00:00.000Z") };
  for (const verifiedCodexModelIds of [undefined, ["gpt-6-astra"], ["astra-product"]]) {
    const result = createRuntimeCapabilityCatalog({ ...input, ...(verifiedCodexModelIds === undefined ? {} : { verifiedCodexModelIds }) });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.receipt.codexModels[1]?.availability, verifiedCodexModelIds?.includes("astra-product") ? "available" : "unavailable");
  }
  const unsupported = createRuntimeCapabilityCatalog({ ...input, verifiedCodexModelIds: ["astra-product"], codex: { ...codex,
    models: [{ ...astra, supportedReasoningEfforts: ["high"], reasoningMappings: { high: "high" } }] } });
  assert.equal(unsupported.ok, true);
  if (unsupported.ok) assert.equal(unsupported.receipt.codexModels[0]?.availability, "unavailable");
  assert.deepEqual(createRuntimeCapabilityCatalog({ ...input, issuedAt: new Date("invalid") }), { ok: false, code: "invalid_models" });
});
