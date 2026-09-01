import {
  REASONING_DEPTHS,
  SPEED_PRESETS,
  type OwnerSettings,
  type ReasoningDepth,
  type SpeedPreset
} from "./types.ts";

const SETTINGS_KEYS = [
  "codexModelId",
  "claudeModelId",
  "reasoningDepth",
  "speedPreset"
] as const;

export type SettingsParseError =
  | "not_an_object"
  | "unexpected_settings_shape"
  | "invalid_model_id"
  | "invalid_reasoning_depth"
  | "invalid_speed_preset";

export type SettingsParseResult =
  | Readonly<{ ok: true; value: OwnerSettings }>
  | Readonly<{ ok: false; code: SettingsParseError }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReasoningDepth = (value: string): value is ReasoningDepth =>
  REASONING_DEPTHS.includes(value as ReasoningDepth);

const isSpeedPreset = (value: string): value is SpeedPreset =>
  SPEED_PRESETS.includes(value as SpeedPreset);

export function parseOwnerSettings(input: unknown): SettingsParseResult {
  if (!isRecord(input)) {
    return { ok: false, code: "not_an_object" };
  }

  const keys = Object.keys(input).sort();
  const expectedKeys = [...SETTINGS_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return { ok: false, code: "unexpected_settings_shape" };
  }

  const { codexModelId, claudeModelId, reasoningDepth, speedPreset } = input;
  if (
    typeof codexModelId !== "string" ||
    codexModelId.length === 0 ||
    typeof claudeModelId !== "string" ||
    claudeModelId.length === 0
  ) {
    return { ok: false, code: "invalid_model_id" };
  }

  if (typeof reasoningDepth !== "string" || !isReasoningDepth(reasoningDepth)) {
    return { ok: false, code: "invalid_reasoning_depth" };
  }

  if (typeof speedPreset !== "string" || !isSpeedPreset(speedPreset)) {
    return { ok: false, code: "invalid_speed_preset" };
  }

  return {
    ok: true,
    value: Object.freeze({ codexModelId, claudeModelId, reasoningDepth, speedPreset })
  };
}
