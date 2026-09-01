import { parseOwnerSettings, type SettingsParseError } from "./schema.ts";
import type {
  CapabilityReceipt,
  OwnerSettings,
  ProviderModelCapability,
  ReasoningDepth
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
  | "incompatible_reasoning_depth";

export type SettingsValidationResult =
  | Readonly<{
      ok: true;
      value: OwnerSettings;
      codex: ProviderModelCapability;
      claude: ProviderModelCapability;
    }>
  | Readonly<{ ok: false; code: SettingsValidationError }>;

const asEpoch = (value: string): number | null => {
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? null : epoch;
};

const supportsDepth = (capability: ProviderModelCapability, depth: ReasoningDepth): boolean =>
  capability.supportedReasoningDepths.includes(depth) &&
  typeof capability.reasoningMappings[depth] === "string" &&
  capability.reasoningMappings[depth].length > 0;

function validateCatalogTiming(receipt: CapabilityReceipt, now: Date): SettingsValidationError | null {
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

  const codex = receipt.codexModels.find((model) => model.productId === parsed.value.codexModelId);
  if (codex === undefined) return { ok: false, code: "unknown_codex_model" };
  if (codex.availability !== "available") return { ok: false, code: "codex_model_unavailable" };

  const claude = receipt.claudeModels.find((model) => model.productId === parsed.value.claudeModelId);
  if (claude === undefined) return { ok: false, code: "unknown_claude_model" };
  if (claude.availability !== "available") return { ok: false, code: "claude_model_unavailable" };

  if (!supportsDepth(codex, parsed.value.reasoningDepth) || !supportsDepth(claude, parsed.value.reasoningDepth)) {
    return { ok: false, code: "incompatible_reasoning_depth" };
  }

  return { ok: true, value: parsed.value, codex, claude };
}

export function getValidatedDefaults(
  receipt: CapabilityReceipt,
  now: Date
): SettingsValidationResult {
  return validateOwnerSettings(receipt.defaults, receipt, now);
}
