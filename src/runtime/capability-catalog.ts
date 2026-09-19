import { parseOwnerSettings } from "../settings/schema.ts";
import type { CapabilityReceipt, OwnerSettings, ProviderModelCapability } from "../settings/types.ts";
import type { CodexAppServerProbe } from "./codex-app-server.ts";
import type { ClaudeSubscriptionRuntime, ProviderReadiness } from "./provider-preflight.ts";

export type ClaudeRuntimeCatalogProbe = Readonly<{
  runtime: ClaudeSubscriptionRuntime;
  models: readonly ProviderModelCapability[];
  defaultModelId?: string;
}>;

export type RuntimeCapabilityCatalogResult =
  | Readonly<{ ok: true; receipt: CapabilityReceipt }>
  | Readonly<{ ok: false; code: "codex_not_ready" | "claude_not_ready" | "private_boundary_failed" | "claude_paid_acceleration_forbidden" | "invalid_models" | "invalid_defaults" |
      "claude_auth_rejected" | "claude_access_denied" | "claude_quota_blocked" | "claude_cli_incompatible" | "claude_process_failed" | "claude_invalid_response" | "claude_models_unavailable" |
      "catalog_storage_failed" | "catalog_refresh_failed" }>;

const allAvailable = (models: readonly ProviderModelCapability[]): boolean =>
  models.length > 0 && new Set(models.map((model) => model.productId)).size === models.length &&
  models.every((model) =>
    model.availability === "available" && model.productId.length > 0 && model.displayName.length > 0 && model.runtimeModelId.length > 0 &&
    model.supportedReasoningEfforts.every((effort) => typeof model.reasoningMappings[effort] === "string")
  );

const isReady = (readiness: ProviderReadiness): boolean => readiness === "ready";

/**
 * Builds a short-lived catalog from Codex and an explicitly requested Claude
 * refresh. The inactive Claude receipt keeps its original freshness. Defaults are
 * an explicit release-authority whole settings object, not a model-name
 * fallback or an automatic effort downgrade.
 */
export function createRuntimeCapabilityCatalog(input: Readonly<{
  codex: CodexAppServerProbe;
  claude?: ClaudeRuntimeCatalogProbe;
  previous?: CapabilityReceipt;
  verifiedCodexModelIds?: readonly string[];
  defaults: OwnerSettings;
  catalogVersion: string;
  issuedAt: Date;
  expiresAt: Date;
}>): RuntimeCapabilityCatalogResult {
  if (!isReady(input.codex.runtime.readiness) || input.codex.runtime.authMode !== "chatgpt_oauth") return { ok: false, code: "codex_not_ready" };
  if (input.claude !== undefined && (!isReady(input.claude.runtime.readiness) || input.claude.runtime.authMode !== "claude_code_oauth")) return { ok: false, code: "claude_not_ready" };
  if (!input.codex.runtime.privateSingleOwner || (input.claude !== undefined && !input.claude.runtime.privateSingleOwner)) return { ok: false, code: "private_boundary_failed" };
  if (input.claude?.runtime.fastModeEnabled || input.claude?.runtime.extraUsageEnabled) return { ok: false, code: "claude_paid_acceleration_forbidden" };
  if (!allAvailable(input.codex.models) || (input.claude !== undefined && !allAvailable(input.claude.models)) || input.catalogVersion.trim().length === 0 ||
    !Number.isFinite(input.issuedAt.getTime()) || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= input.issuedAt) {
    return { ok: false, code: "invalid_models" };
  }
  const defaults = parseOwnerSettings(input.defaults);
  if (!defaults.ok) return { ok: false, code: "invalid_defaults" };
  const fresh = Object.freeze({ schemaVersion: "1" as const, status: "ready" as const, catalogVersion: input.catalogVersion,
    issuedAt: input.issuedAt.toISOString(), expiresAt: input.expiresAt.toISOString(), trusted: true });
  const previousClaude = input.previous?.providerReceipts?.claude_code ?? (input.previous === undefined ? undefined : Object.freeze({
    schemaVersion: "1" as const, status: input.previous.claudeModels.some(model => model.availability === "available") ? "ready" as const : "unavailable" as const,
    catalogVersion: input.previous.catalogVersion, issuedAt: input.previous.issuedAt, expiresAt: input.previous.expiresAt, trusted: input.previous.trusted
  }));
  const receipt: CapabilityReceipt = Object.freeze({
    catalogVersion: input.catalogVersion,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    trusted: true,
    codexModels: Object.freeze(input.codex.models.map(model => Object.freeze({ ...model,
      availability: model.runtimeModelId === "gpt-6-astra" && (!input.verifiedCodexModelIds?.includes(model.productId) ||
        !model.supportedReasoningEfforts.includes("xhigh") || model.reasoningMappings.xhigh !== "xhigh") ? "unavailable" as const : model.availability }))),
    claudeModels: Object.freeze([...(input.claude?.models ?? input.previous?.claudeModels ?? [])]),
    providerReceipts: Object.freeze({ codex: fresh,
      claude_code: input.claude === undefined ? previousClaude ?? Object.freeze({ ...fresh, status: "unavailable" as const }) : fresh }),
    defaults: defaults.value
  });
  return { ok: true, receipt };
}
