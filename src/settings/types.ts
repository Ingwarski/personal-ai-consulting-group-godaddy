export const SPEED_PRESETS = ["швидко", "збалансовано", "ретельно"] as const;

export type SpeedPreset = (typeof SPEED_PRESETS)[number];
export type ModelAvailability = "available" | "unavailable";
export type ProviderReasoningEffort = string;
export type CriticProvider = "claude_code" | "codex";

export type ProviderSettings = Readonly<{
  modelId: string;
  /**
   * Null means this provider chooses the documented default for the selected
   * model. It is deliberately independent for Codex and Claude.
   */
  reasoningEffort: ProviderReasoningEffort | null;
}>;

export type OwnerSettings = Readonly<{
  codex: ProviderSettings;
  critic: Readonly<{
    provider: CriticProvider;
    claude: ProviderSettings | null;
    codex: ProviderSettings | null;
  }>;
  speedPreset: SpeedPreset;
}>;

export type ProviderCapabilityReceipt = Readonly<{
  schemaVersion: "1";
  status: "ready" | "unavailable";
  catalogVersion: string;
  issuedAt: string;
  expiresAt: string;
  trusted: boolean;
}>;

export type ProviderModelCapability = Readonly<{
  productId: string;
  displayName: string;
  runtimeModelId: string;
  availability: ModelAvailability;
  supportedReasoningEfforts: readonly ProviderReasoningEffort[];
  reasoningMappings: Readonly<Record<ProviderReasoningEffort, string>>;
  defaultReasoningEffort?: ProviderReasoningEffort;
}>;

export type CapabilityReceipt = Readonly<{
  catalogVersion: string;
  issuedAt: string;
  expiresAt: string;
  trusted: boolean;
  codexModels: readonly ProviderModelCapability[];
  claudeModels: readonly ProviderModelCapability[];
  defaults: OwnerSettings;
  /** Older envelopes are accepted as one receipt; new receipts isolate provider freshness. */
  providerReceipts?: Readonly<{
    codex: ProviderCapabilityReceipt;
    claude_code: ProviderCapabilityReceipt;
  }>;
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
    criticRequired: true;
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
