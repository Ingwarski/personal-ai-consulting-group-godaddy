import type { SpeedPolicy, SpeedPolicyCatalog, SpeedPolicyNumericValue, SpeedPreset } from "./types.ts";

const invariants = Object.freeze({
  criticRequired: true,
  a2aRequired: true,
  matrixE2eeRequired: true,
  verbatimVisibilityRequired: true,
  safetyPrivacyRequired: true,
  externalPermissionRequired: true
} as const);

const unresolved = Object.freeze({ status: "unresolved", reason: "production_approval_required" } as const);
const resolved = (value: number): SpeedPolicyNumericValue => Object.freeze({ status: "resolved", value });
const CATALOG_VERSION = "speed-policy-awaiting-production-approval-v1";

const policies: Readonly<Record<SpeedPreset, SpeedPolicy>> = Object.freeze({
  швидко: Object.freeze({
    catalogVersion: CATALOG_VERSION,
    preset: "швидко",
    consultationCadence: "minimum",
    maxOptionalSpecialists: resolved(0),
    concurrency: unresolved,
    critiqueRevisionCycles: resolved(1),
    internalBudgetMilliseconds: unresolved,
    invariants,
    paidAcceleration: "forbidden"
  }),
  збалансовано: Object.freeze({
    catalogVersion: CATALOG_VERSION,
    preset: "збалансовано",
    consultationCadence: "standard",
    maxOptionalSpecialists: unresolved,
    concurrency: unresolved,
    critiqueRevisionCycles: unresolved,
    internalBudgetMilliseconds: unresolved,
    invariants,
    paidAcceleration: "forbidden"
  }),
  ретельно: Object.freeze({
    catalogVersion: CATALOG_VERSION,
    preset: "ретельно",
    consultationCadence: "expanded",
    maxOptionalSpecialists: resolved(3),
    concurrency: unresolved,
    critiqueRevisionCycles: unresolved,
    internalBudgetMilliseconds: unresolved,
    invariants,
    paidAcceleration: "forbidden"
  })
});

export const UNAPPROVED_SPEED_POLICY_CATALOG: SpeedPolicyCatalog = Object.freeze({
  version: CATALOG_VERSION,
  policies
});

export function resolveSpeedPolicy(
  preset: SpeedPreset,
  catalog: SpeedPolicyCatalog = UNAPPROVED_SPEED_POLICY_CATALOG
): SpeedPolicy {
  return catalog.policies[preset];
}
