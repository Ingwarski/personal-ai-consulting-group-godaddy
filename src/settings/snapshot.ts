import { validateOwnerSettings, type SettingsValidationError } from "./catalog.ts";
import { resolveSpeedPolicy } from "./speed-policy.ts";
import type { CapabilityReceipt, EffectiveSessionSnapshot, SpeedPolicyCatalog } from "./types.ts";

export type SnapshotResolutionInput = Readonly<{
  sessionId: string;
  settingsRevision: number;
  settings: unknown;
  capabilityReceipt: CapabilityReceipt;
  speedPolicyCatalog?: SpeedPolicyCatalog;
}>;

export type SnapshotResolutionResult =
  | Readonly<{ ok: true; value: EffectiveSessionSnapshot }>
  | Readonly<{ ok: false; code: SettingsValidationError | "invalid_session_id" | "invalid_settings_revision" }>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const nested = Reflect.get(value, key);
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export function resolveEffectiveSessionSnapshot(
  input: SnapshotResolutionInput,
  now: Date
): SnapshotResolutionResult {
  if (input.sessionId.length === 0) return { ok: false, code: "invalid_session_id" };
  if (!Number.isSafeInteger(input.settingsRevision) || input.settingsRevision < 1) {
    return { ok: false, code: "invalid_settings_revision" };
  }

  const validated = validateOwnerSettings(input.settings, input.capabilityReceipt, now);
  if (!validated.ok) return validated;

  return {
    ok: true,
    value: deepFreeze({
      sessionId: input.sessionId,
      settingsRevision: input.settingsRevision,
      catalogVersion: input.capabilityReceipt.catalogVersion,
      resolvedAt: now.toISOString(),
      settings: { ...validated.value },
      speedPolicy: resolveSpeedPolicy(validated.value.speedPreset, input.speedPolicyCatalog)
    })
  };
}
