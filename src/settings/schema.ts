import {
  SPEED_PRESETS,
  type OwnerSettings,
  type ProviderReasoningEffort,
  type ProviderSettings,
  type SpeedPreset
} from "./types.ts";

const SETTINGS_KEYS = [
  "codex",
  "critic",
  "speedPreset"
] as const;

export type SettingsParseError =
  | "not_an_object"
  | "unexpected_settings_shape"
  | "invalid_model_id"
  | "invalid_reasoning_effort"
  | "invalid_critic_provider"
  | "critic_settings_required"
  | "invalid_speed_preset";

export type SettingsParseResult =
  | Readonly<{ ok: true; value: OwnerSettings }>
  | Readonly<{ ok: false; code: SettingsParseError }>;

type ProviderSettingsParseResult =
  | Readonly<{ ok: true; value: ProviderSettings }>
  | Readonly<{ ok: false; code: SettingsParseError }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReasoningEffort = (value: unknown): value is ProviderReasoningEffort =>
  typeof value === "string" && /^[a-z][a-z0-9_-]{0,127}$/iu.test(value);

const isSpeedPreset = (value: string): value is SpeedPreset =>
  SPEED_PRESETS.includes(value as SpeedPreset);

export function parseProviderSettings(input: unknown): ProviderSettingsParseResult {
  if (!isRecord(input) || Object.keys(input).sort().join(",") !== "modelId,reasoningEffort") {
    return { ok: false, code: "unexpected_settings_shape" };
  }
  if (typeof input.modelId !== "string" || input.modelId.trim().length === 0 || input.modelId.length > 512) {
    return { ok: false, code: "invalid_model_id" };
  }
  if (input.reasoningEffort !== null && !isReasoningEffort(input.reasoningEffort)) {
    return { ok: false, code: "invalid_reasoning_effort" };
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort
    })
  });
}

export function parseOwnerSettings(input: unknown): SettingsParseResult {
  if (!isRecord(input)) {
    return { ok: false, code: "not_an_object" };
  }

  const keys = Object.keys(input).sort();
  const expectedKeys = [...SETTINGS_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return { ok: false, code: "unexpected_settings_shape" };
  }

  const codex = parseProviderSettings(input.codex);
  if (!codex.ok) return codex;
  if (!isRecord(input.critic) || Object.keys(input.critic).sort().join(",") !== "claude,codex,provider") {
    return { ok: false, code: "unexpected_settings_shape" };
  }
  if (input.critic.provider !== "claude_code" && input.critic.provider !== "codex") {
    return { ok: false, code: "invalid_critic_provider" };
  }
  const claude = input.critic.claude === null ? { ok: true as const, value: null } : parseProviderSettings(input.critic.claude);
  if (!claude.ok) return claude;
  const criticCodex = input.critic.codex === null ? { ok: true as const, value: null } : parseProviderSettings(input.critic.codex);
  if (!criticCodex.ok) return criticCodex;
  if ((input.critic.provider === "claude_code" && claude.value === null) ||
    (input.critic.provider === "codex" && criticCodex.value === null)) {
    return { ok: false, code: "critic_settings_required" };
  }

  if (typeof input.speedPreset !== "string" || !isSpeedPreset(input.speedPreset)) {
    return { ok: false, code: "invalid_speed_preset" };
  }

  return {
    ok: true,
    value: Object.freeze({
      codex: codex.value,
      critic: Object.freeze({ provider: input.critic.provider, claude: claude.value, codex: criticCodex.value }),
      speedPreset: input.speedPreset
    })
  };
}

/** Read-only compatibility projection. Never accepts legacy payloads for a new save. */
export function parseHistoricalOwnerSettings(input: unknown): SettingsParseResult {
  if (isRecord(input) && Object.keys(input).sort().join(",") === "claudeModelId,codexModelId,reasoningDepth,speedPreset") {
    return parseOwnerSettings({
      codex: { modelId: input.codexModelId, reasoningEffort: input.reasoningDepth },
      critic: { provider: "claude_code", claude: { modelId: input.claudeModelId, reasoningEffort: input.reasoningDepth }, codex: null },
      speedPreset: input.speedPreset
    });
  }
  if (!isRecord(input) || Object.keys(input).sort().join(",") !== "claude,codex,speedPreset") {
    return parseOwnerSettings(input);
  }
  return parseOwnerSettings({
    codex: input.codex,
    critic: { provider: "claude_code", claude: input.claude, codex: null },
    speedPreset: input.speedPreset
  });
}
