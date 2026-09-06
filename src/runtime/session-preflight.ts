import { preflightSubscriptionRuntimes } from "./provider-preflight.ts";
import { probeCodexAppServer, type CodexAppServerProbe, type CodexAppServerTransport } from "./codex-app-server.ts";
import type { ClaudeCodeSubscriptionProcess, ClaudeCodeSubscriptionStatus } from "./claude-code-critic.ts";
import type { CapabilityReceipt, EffectiveSessionSnapshot, ProviderModelCapability, ProviderReasoningEffort, ProviderSettings } from "../settings/types.ts";
import { parseHistoricalOwnerSettings } from "../settings/schema.ts";

export type SessionSubscriptionPreflightFailureCode =
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
        | "claude_model_not_available"
        | "catalog_version_mismatch"
        | "codex_effort_unavailable"
        | "claude_effort_unavailable"
        | "claude_status_unavailable";

export type SessionSubscriptionPreflightResult =
  | Readonly<{ ok: true; codex: CodexAppServerProbe; critic: Readonly<{ provider: "codex" }> | Readonly<{ provider: "claude_code"; status: ClaudeCodeSubscriptionStatus }> }>
  | Readonly<{ ok: false; code: SessionSubscriptionPreflightFailureCode }>;

const supportsSelectedEffort = (models: readonly ProviderModelCapability[], productId: string, reasoningEffort: ProviderReasoningEffort | null): boolean => {
  const model = models.find((candidate) => candidate.productId === productId);
  return model !== undefined &&
    model.availability === "available" &&
    (reasoningEffort === null ||
      (model.supportedReasoningEfforts.includes(reasoningEffort) &&
        typeof model.reasoningMappings[reasoningEffort] === "string"));
};

const currentModelMatches = (recorded: readonly ProviderModelCapability[], current: readonly ProviderModelCapability[], selected: ProviderSettings): boolean => {
  const expected = recorded.find((model) => model.productId === selected.modelId);
  const actual = current.find((model) => model.productId === selected.modelId);
  return expected !== undefined && actual !== undefined && expected.runtimeModelId === actual.runtimeModelId;
};

/**
 * The sole content-free gate immediately before a new consilium session. A
 * current runtime report must agree with the frozen settings snapshot; neither
 * provider may downgrade effort, replace a model, consume paid acceleration or
 * fall back to an API/cloud credential path.
 */
export async function preflightSessionSubscriptions(input: Readonly<{
  environment: Record<string, unknown>;
  snapshot: EffectiveSessionSnapshot;
  capabilityReceipt: CapabilityReceipt;
  codexTransport: CodexAppServerTransport;
  claudeProcess?: ClaudeCodeSubscriptionProcess;
  privateSingleOwner: boolean;
  now: Date;
}>): Promise<SessionSubscriptionPreflightResult> {
  const compatible = parseHistoricalOwnerSettings(input.snapshot.settings);
  if (!compatible.ok) return { ok: false, code: "settings_incompatible" };
  const settings = compatible.value;
  if (input.snapshot.catalogVersion !== input.capabilityReceipt.catalogVersion) {
    return { ok: false, code: "catalog_version_mismatch" };
  }
  const codex = await probeCodexAppServer(input.codexTransport, { privateSingleOwner: input.privateSingleOwner });
  let claude: ClaudeCodeSubscriptionStatus | undefined;
  const selected = settings.critic;
  if (selected.provider === "claude_code") {
    if (input.claudeProcess === undefined) return { ok: false, code: "claude_unavailable" };
    try {
      claude = await input.claudeProcess.inspectSubscription();
    } catch {
      return { ok: false, code: "claude_status_unavailable" };
    }
  }
  const base = preflightSubscriptionRuntimes({
    environment: input.environment,
    settings: settings,
    capabilityReceipt: input.capabilityReceipt,
    codex: codex.runtime,
    ...(claude === undefined ? {} : { claude: {
      authMode: claude.authMode,
      readiness: claude.readiness,
      privateSingleOwner: claude.privateSingleOwner,
      availableModelIds: Object.freeze(claude.models.map((model) => model.productId)),
      fastModeEnabled: claude.fastModeEnabled,
      extraUsageEnabled: claude.extraUsageEnabled
    } }),
    now: input.now
  });
  if (!base.ok) return base;
  if (!currentModelMatches(input.capabilityReceipt.codexModels, codex.models, settings.codex)) return { ok: false, code: "codex_model_not_available" };
  if (claude?.bareMode) return { ok: false, code: "claude_auth_mode_invalid" };
  if (!supportsSelectedEffort(codex.models, settings.codex.modelId, settings.codex.reasoningEffort)) {
    return { ok: false, code: "codex_effort_unavailable" };
  }
  if (selected.provider === "codex") {
    if (selected.codex !== null && !currentModelMatches(input.capabilityReceipt.codexModels, codex.models, selected.codex)) return { ok: false, code: "codex_model_not_available" };
    if (selected.codex === null || !supportsSelectedEffort(codex.models, selected.codex.modelId, selected.codex.reasoningEffort)) return { ok: false, code: "codex_effort_unavailable" };
    return { ok: true, codex, critic: { provider: "codex" } };
  }
  if (claude !== undefined && selected.claude !== null && !currentModelMatches(input.capabilityReceipt.claudeModels, claude.models, selected.claude)) return { ok: false, code: "claude_model_not_available" };
  if (claude === undefined || selected.claude === null || !supportsSelectedEffort(claude.models, selected.claude.modelId, selected.claude.reasoningEffort)) {
    return { ok: false, code: "claude_effort_unavailable" };
  }
  return { ok: true, codex, critic: { provider: "claude_code", status: claude } };
}
