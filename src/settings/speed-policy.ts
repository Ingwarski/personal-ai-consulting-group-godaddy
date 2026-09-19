import type { SpeedPolicy, SpeedPolicyCatalog, SpeedPolicyNumericValue, SpeedPreset } from "./types.ts";

const invariants = Object.freeze({
  criticRequired: true,
  a2aRequired: true,
  encryptedArchiveRequired: true,
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

// Bounded application policy. The nine-minute provider budget leaves time to
// stop cleanly and persist an interrupted session. Existing snapshots are
// never rewritten.
const MVP_CATALOG_VERSION = "speed-policy-browser-consultation-v1";
const mvpPolicy = (preset: SpeedPreset, maximumSpecialists: number): SpeedPolicy => Object.freeze({
  ...policies[preset], catalogVersion: MVP_CATALOG_VERSION,
  maxOptionalSpecialists: resolved(maximumSpecialists - 2),
  concurrency: resolved(maximumSpecialists),
  critiqueRevisionCycles: resolved(1),
  internalBudgetMilliseconds: resolved(540_000)
});

export const MVP_SPEED_POLICY_CATALOG: SpeedPolicyCatalog = Object.freeze({
  version: MVP_CATALOG_VERSION,
  policies: Object.freeze({
    швидко: mvpPolicy("швидко", 2),
    збалансовано: mvpPolicy("збалансовано", 3),
    ретельно: mvpPolicy("ретельно", 5)
  })
});

export function resolveSpeedPolicy(
  preset: SpeedPreset,
  catalog: SpeedPolicyCatalog = MVP_SPEED_POLICY_CATALOG
): SpeedPolicy {
  return catalog.policies[preset];
}
