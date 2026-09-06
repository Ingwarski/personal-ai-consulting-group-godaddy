import { parseOwnerSettings, type SettingsParseError } from "./schema.ts";
import type {
  CapabilityReceipt,
  OwnerSettings,
  ProviderModelCapability,
  ProviderSettings
} from "./types.ts";

export type SettingsValidationError =
  | SettingsParseError
  | "catalog_untrusted"
  | "catalog_time_invalid"
  | "catalog_stale"
  | "unknown_codex_model"
  | "unknown_claude_model"
  | "codex_model_unavailable"
  | "claude_model_unavailable"
  | "codex_catalog_unavailable"
  | "claude_catalog_unavailable"
  | "codex_reasoning_effort_unavailable"
  | "claude_reasoning_effort_unavailable";

export type SettingsValidationResult =
  | Readonly<{
      ok: true;
      value: OwnerSettings;
      codex: ProviderModelCapability;
      critic: ProviderModelCapability;
    }>
  | Readonly<{ ok: false; code: SettingsValidationError }>;

const asEpoch = (value: string): number | null => {
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? null : epoch;
};

const supportsSelectedEffort = (capability: ProviderModelCapability, settings: ProviderSettings): boolean => {
  if (settings.reasoningEffort === null) return true;
  const mapping = capability.reasoningMappings[settings.reasoningEffort];
  return capability.supportedReasoningEfforts.includes(settings.reasoningEffort) &&
    typeof mapping === "string" && mapping.length > 0;
};

export function validateCatalogTiming(receipt: Pick<CapabilityReceipt, "trusted" | "issuedAt" | "expiresAt">, now: Date): SettingsValidationError | null {
  if (!receipt.trusted) return "catalog_untrusted";

  const issuedAt = asEpoch(receipt.issuedAt);
  const expiresAt = asEpoch(receipt.expiresAt);
  if (issuedAt === null || expiresAt === null || issuedAt > expiresAt) {
    return "catalog_time_invalid";
  }

  if (expiresAt <= now.getTime() || issuedAt > now.getTime()) {
    return "catalog_stale";
  }

  return null;
}

export function validateOwnerSettings(
  input: unknown,
  receipt: CapabilityReceipt,
  now: Date
): SettingsValidationResult {
  const parsed = parseOwnerSettings(input);
  if (!parsed.ok) return parsed;

  const catalogProblem = validateCatalogTiming(receipt, now);
  if (catalogProblem !== null) return { ok: false, code: catalogProblem };

  // An inactive provider's status and expiry cannot block the selected route.
  for (const provider of parsed.value.critic.provider === "codex" ? ["codex"] as const : ["codex", "claude_code"] as const) {
    const providerReceipt = receipt.providerReceipts?.[provider];
    if (providerReceipt === undefined) continue;
    if (providerReceipt.status !== "ready") {
      return { ok: false, code: provider === "codex" ? "codex_catalog_unavailable" : "claude_catalog_unavailable" };
    }
    const providerProblem = validateCatalogTiming(providerReceipt, now);
    if (providerProblem !== null) return { ok: false, code: providerProblem };
  }

  const codex = receipt.codexModels.find((model) => model.productId === parsed.value.codex.modelId);
  if (codex === undefined) return { ok: false, code: "unknown_codex_model" };
  if (codex.availability !== "available") return { ok: false, code: "codex_model_unavailable" };

  if (!supportsSelectedEffort(codex, parsed.value.codex)) return { ok: false, code: "codex_reasoning_effort_unavailable" };
  const usesCodexCritic = parsed.value.critic.provider === "codex";
  const criticSettings = usesCodexCritic ? parsed.value.critic.codex : parsed.value.critic.claude;
  if (criticSettings === null) return { ok: false, code: "critic_settings_required" };
  const critic = (usesCodexCritic ? receipt.codexModels : receipt.claudeModels)
    .find((model) => model.productId === criticSettings.modelId);
  if (critic === undefined) return { ok: false, code: usesCodexCritic ? "unknown_codex_model" : "unknown_claude_model" };
  if (critic.availability !== "available") return { ok: false, code: usesCodexCritic ? "codex_model_unavailable" : "claude_model_unavailable" };
  if (!supportsSelectedEffort(critic, criticSettings)) {
    return { ok: false, code: usesCodexCritic ? "codex_reasoning_effort_unavailable" : "claude_reasoning_effort_unavailable" };
  }
  return { ok: true, value: parsed.value, codex, critic };
}

export function getValidatedDefaults(
  receipt: CapabilityReceipt,
  now: Date
): SettingsValidationResult {
  return validateOwnerSettings(receipt.defaults, receipt, now);
}
