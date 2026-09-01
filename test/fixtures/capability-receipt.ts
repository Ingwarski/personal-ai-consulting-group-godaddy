import type { CapabilityReceipt, SpeedPolicy, SpeedPolicyCatalog, SpeedPreset } from "../../src/settings/types.ts";

const NOW = "2026-08-16T00:00:00.000Z";
const EXPIRY = "2026-08-17T00:00:00.000Z";

export function createCapabilityReceipt(
  overrides: Partial<CapabilityReceipt> = {}
): CapabilityReceipt {
  return {
    catalogVersion: "catalog-2026-08-16-r1",
    issuedAt: NOW,
    expiresAt: EXPIRY,
    trusted: true,
    codexModels: [
      {
        productId: "codex-current-primary",
        displayName: "Codex primary",
        runtimeModelId: "codex-runtime-primary",
        availability: "available",
        supportedReasoningDepths: ["low", "medium", "high", "xhigh"],
        reasoningMappings: {
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh"
        }
      }
    ],
    claudeModels: [
      {
        productId: "claude-current-critic",
        displayName: "Claude critic",
        runtimeModelId: "claude-runtime-critic",
        availability: "available",
        supportedReasoningDepths: ["low", "medium", "high"],
        reasoningMappings: {
          low: "low",
          medium: "medium",
          high: "high"
        }
      }
    ],
    defaults: {
      codexModelId: "codex-current-primary",
      claudeModelId: "claude-current-critic",
      reasoningDepth: "high",
      speedPreset: "збалансовано"
    },
    ...overrides
  };
}

export const activeNow = new Date("2026-08-16T12:00:00.000Z");

export function createResolvedTestSpeedPolicyCatalog(): SpeedPolicyCatalog {
  const invariants = Object.freeze({
    claudeCriticRequired: true,
    a2aRequired: true,
    matrixE2eeRequired: true,
    verbatimVisibilityRequired: true,
    safetyPrivacyRequired: true,
    externalPermissionRequired: true
  } as const);
  const resolved = (value: number) => Object.freeze({ status: "resolved" as const, value });
  const makePolicy = (preset: SpeedPreset, cadence: SpeedPolicy["consultationCadence"], optional: number): SpeedPolicy => Object.freeze({
    catalogVersion: "test-speed-policy-v1",
    preset,
    consultationCadence: cadence,
    maxOptionalSpecialists: resolved(optional),
    concurrency: resolved(2),
    critiqueRevisionCycles: resolved(1),
    internalBudgetMilliseconds: resolved(60_000),
    invariants,
    paidAcceleration: "forbidden"
  });
  return Object.freeze({
    version: "test-speed-policy-v1",
    policies: Object.freeze({
      швидко: makePolicy("швидко", "minimum", 0),
      збалансовано: makePolicy("збалансовано", "standard", 1),
      ретельно: makePolicy("ретельно", "expanded", 3)
    })
  });
}
