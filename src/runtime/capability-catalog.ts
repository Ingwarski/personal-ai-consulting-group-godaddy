import { getValidatedDefaults } from "../settings/catalog.ts";
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
  | Readonly<{ ok: false; code: "codex_not_ready" | "claude_not_ready" | "private_boundary_failed" | "claude_paid_acceleration_forbidden" | "invalid_models" | "invalid_defaults" }>;

const allAvailable = (models: readonly ProviderModelCapability[]): boolean =>
  models.length > 0 && new Set(models.map((model) => model.productId)).size === models.length &&
  models.every((model) =>
    model.availability === "available" && model.productId.length > 0 && model.displayName.length > 0 && model.runtimeModelId.length > 0 &&
    model.supportedReasoningEfforts.every((effort) => typeof model.reasoningMappings[effort] === "string")
  );

const isReady = (readiness: ProviderReadiness): boolean => readiness === "ready";

/**
 * Builds a short-lived catalog only after the two isolated subscription
 * runtimes have reported their currently usable models. Initial defaults are
 * an explicit release-authority whole settings object, not a model-name
 * fallback or an automatic effort downgrade.
 */
export function createRuntimeCapabilityCatalog(input: Readonly<{
  codex: CodexAppServerProbe;
  claude: ClaudeRuntimeCatalogProbe;
  defaults: OwnerSettings;
  catalogVersion: string;
  issuedAt: Date;
  expiresAt: Date;
}>): RuntimeCapabilityCatalogResult {
  if (!isReady(input.codex.runtime.readiness) || input.codex.runtime.authMode !== "chatgpt_oauth") return { ok: false, code: "codex_not_ready" };
  if (!isReady(input.claude.runtime.readiness) || input.claude.runtime.authMode !== "claude_code_oauth") return { ok: false, code: "claude_not_ready" };
  if (!input.codex.runtime.privateSingleOwner || !input.claude.runtime.privateSingleOwner) return { ok: false, code: "private_boundary_failed" };
  if (input.claude.runtime.fastModeEnabled || input.claude.runtime.extraUsageEnabled) return { ok: false, code: "claude_paid_acceleration_forbidden" };
  if (!allAvailable(input.codex.models) || !allAvailable(input.claude.models) || input.catalogVersion.trim().length === 0 || input.expiresAt <= input.issuedAt) {
    return { ok: false, code: "invalid_models" };
  }
  const receipt: CapabilityReceipt = Object.freeze({
    catalogVersion: input.catalogVersion,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    trusted: true,
    codexModels: Object.freeze([...input.codex.models]),
    claudeModels: Object.freeze([...input.claude.models]),
    defaults: Object.freeze({ ...input.defaults })
  });
  if (!getValidatedDefaults(receipt, input.issuedAt).ok) return { ok: false, code: "invalid_defaults" };
  return { ok: true, receipt };
}
