import { FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES } from "./environment.ts";
import { validateOwnerSettings } from "../settings/catalog.ts";
import type { CapabilityReceipt, OwnerSettings } from "../settings/types.ts";

export type ProviderReadiness = "ready" | "auth_required" | "quota_blocked" | "unavailable";

export type CodexSubscriptionRuntime = Readonly<{
  authMode: "chatgpt_oauth" | "other";
  readiness: ProviderReadiness;
  privateSingleOwner: boolean;
  availableModelIds: readonly string[];
}>;

export type ClaudeSubscriptionRuntime = Readonly<{
  authMode: "claude_code_oauth" | "other";
  readiness: ProviderReadiness;
  privateSingleOwner: boolean;
  availableModelIds: readonly string[];
  fastModeEnabled: boolean;
  extraUsageEnabled: boolean;
}>;

export type SubscriptionPreflightInput = Readonly<{
  environment: Record<string, unknown>;
  settings: OwnerSettings;
  capabilityReceipt: CapabilityReceipt;
  codex: CodexSubscriptionRuntime;
  claude?: ClaudeSubscriptionRuntime;
  now: Date;
}>;

export type SubscriptionPreflightResult =
  | Readonly<{ ok: true; catalogVersion: string }>
  | Readonly<{
      ok: false;
      code:
        | "forbidden_environment"
        | "settings_incompatible"
        | "codex_auth_required"
        | "claude_auth_required"
        | "codex_quota_blocked"
        | "claude_quota_blocked"
        | "codex_unavailable"
        | "claude_unavailable"
        | "private_boundary_failed"
        | "codex_auth_mode_invalid"
        | "claude_auth_mode_invalid"
        | "claude_paid_acceleration_forbidden"
        | "codex_model_not_available"
        | "claude_model_not_available";
    }>;

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const readinessFailure = (
  prefix: "codex" | "claude",
  readiness: ProviderReadiness
): SubscriptionPreflightResult | null => {
  if (readiness === "ready") return null;
  if (readiness === "auth_required") return { ok: false, code: `${prefix}_auth_required` };
  if (readiness === "quota_blocked") return { ok: false, code: `${prefix}_quota_blocked` };
  return { ok: false, code: `${prefix}_unavailable` };
};

export function preflightSubscriptionRuntimes(
  input: SubscriptionPreflightInput
): SubscriptionPreflightResult {
  if (FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES.some((name) => hasOwn(input.environment, name))) {
    return { ok: false, code: "forbidden_environment" };
  }

  const settings = validateOwnerSettings(input.settings, input.capabilityReceipt, input.now);
  if (!settings.ok) return { ok: false, code: "settings_incompatible" };
  const selected = input.settings.critic;
  if (!input.codex.privateSingleOwner) {
    return { ok: false, code: "private_boundary_failed" };
  }
  if (input.codex.authMode !== "chatgpt_oauth") return { ok: false, code: "codex_auth_mode_invalid" };

  const codexFailure = readinessFailure("codex", input.codex.readiness);
  if (codexFailure !== null) return codexFailure;
  if (!input.codex.availableModelIds.includes(input.settings.codex.modelId)) {
    return { ok: false, code: "codex_model_not_available" };
  }
  if (selected.provider === "codex") {
    if (selected.codex === null || !input.codex.availableModelIds.includes(selected.codex.modelId)) return { ok: false, code: "codex_model_not_available" };
    return { ok: true, catalogVersion: input.capabilityReceipt.catalogVersion };
  }
  if (input.claude === undefined) return { ok: false, code: "claude_unavailable" };
  if (!input.claude.privateSingleOwner) return { ok: false, code: "private_boundary_failed" };
  if (input.claude.authMode !== "claude_code_oauth") return { ok: false, code: "claude_auth_mode_invalid" };
  if (input.claude.fastModeEnabled || input.claude.extraUsageEnabled) return { ok: false, code: "claude_paid_acceleration_forbidden" };
  const claudeFailure = readinessFailure("claude", input.claude.readiness);
  if (claudeFailure !== null) return claudeFailure;
  if (selected.claude === null || !input.claude.availableModelIds.includes(selected.claude.modelId)) {
    return { ok: false, code: "claude_model_not_available" };
  }

  return { ok: true, catalogVersion: input.capabilityReceipt.catalogVersion };
}
