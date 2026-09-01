export const REASONING_DEPTHS = ["low", "medium", "high", "xhigh"] as const;
export const SPEED_PRESETS = ["швидко", "збалансовано", "ретельно"] as const;

export type ReasoningDepth = (typeof REASONING_DEPTHS)[number];
export type SpeedPreset = (typeof SPEED_PRESETS)[number];
export type ModelAvailability = "available" | "unavailable";

export type OwnerSettings = Readonly<{
  codexModelId: string;
  claudeModelId: string;
  reasoningDepth: ReasoningDepth;
  speedPreset: SpeedPreset;
}>;

export type ProviderModelCapability = Readonly<{
  productId: string;
  displayName: string;
  runtimeModelId: string;
  availability: ModelAvailability;
  supportedReasoningDepths: readonly ReasoningDepth[];
  reasoningMappings: Readonly<Partial<Record<ReasoningDepth, string>>>;
}>;

export type CapabilityReceipt = Readonly<{
  catalogVersion: string;
  issuedAt: string;
  expiresAt: string;
  trusted: boolean;
  codexModels: readonly ProviderModelCapability[];
  claudeModels: readonly ProviderModelCapability[];
  defaults: OwnerSettings;
}>;

export type SpeedPolicy = Readonly<{
  catalogVersion: string;
  preset: SpeedPreset;
  consultationCadence: "minimum" | "standard" | "expanded";
  maxOptionalSpecialists: SpeedPolicyNumericValue;
  concurrency: SpeedPolicyNumericValue;
  critiqueRevisionCycles: SpeedPolicyNumericValue;
  internalBudgetMilliseconds: SpeedPolicyNumericValue;
  invariants: Readonly<{
    claudeCriticRequired: true;
    a2aRequired: true;
    matrixE2eeRequired: true;
    verbatimVisibilityRequired: true;
    safetyPrivacyRequired: true;
    externalPermissionRequired: true;
  }>;
  paidAcceleration: "forbidden";
}>;

export type SpeedPolicyNumericValue =
  | Readonly<{ status: "resolved"; value: number }>
  | Readonly<{ status: "unresolved"; reason: "production_approval_required" }>;

export type SpeedPolicyCatalog = Readonly<{
  version: string;
  policies: Readonly<Record<SpeedPreset, SpeedPolicy>>;
}>;

export type EffectiveSessionSnapshot = Readonly<{
  sessionId: string;
  settingsRevision: number;
  catalogVersion: string;
  resolvedAt: string;
  settings: OwnerSettings;
  speedPolicy: SpeedPolicy;
}>;
