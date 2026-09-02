import { getValidatedDefaults, validateOwnerSettings, type SettingsValidationError } from "./catalog.ts";
import type { SettingsStorage } from "./storage.ts";
import type { CapabilityReceipt, OwnerSettings, ProviderModelCapability, ProviderReasoningEffort, ProviderSettings, SpeedPreset } from "./types.ts";
import { parseOwnerSettings } from "./schema.ts";

const SETTINGS_DOCUMENT_KEY = "owner-settings:document";
const IDEMPOTENCY_LEDGER_KEY = "owner-settings:idempotency-ledger";
const AUDIT_KEY_PREFIX = "owner-settings:audit:";
const MAX_IDEMPOTENCY_ENTRIES = 64;
const IDEMPOTENCY_TTL_MILLISECONDS = 24 * 60 * 60_000;

export type SettingsDocument = Readonly<{
  schemaVersion: "2";
  revision: number;
  defaultsVersion: string;
  catalogVersion: string;
  settings: OwnerSettings;
  createdAt: string;
  updatedAt: string;
  actor: "owner";
}>;

export type SettingsAuditRecord = Readonly<{
  revision: number;
  action: "save" | "reset" | "migrate";
  actor: "owner" | "system";
  at: string;
  beforeRevision: number;
  afterRevision: number;
  catalogVersion: string;
  requestHash: string;
  result: "committed";
}>;

type IdempotencyRecord = Readonly<{
  key: string;
  bodyHash: string;
  document: SettingsDocument;
  expiresAt: string;
}>;

export type ActiveSessionSummary = Readonly<{
  settingsRevision: number;
  catalogVersion: string;
  startedAt: string;
  effectiveSettings: OwnerSettings;
}>;

export type ActiveSessionSummaryState =
  | Readonly<{ status: "active"; value: ActiveSessionSummary }>
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "unavailable" }>;

export type SettingsReadModel = Readonly<{
  document: SettingsDocument;
  defaults: OwnerSettings;
  effectiveForNextSession: OwnerSettings | null;
  effectiveIncompatibility: SettingsValidationError | null;
  activeSessionSnapshot: ActiveSessionSummary | null;
  activeSessionStatus: ActiveSessionSummaryState["status"];
  etag: string;
}>;

export type SettingsWriteResult =
  | Readonly<{ ok: true; document: SettingsDocument; etag: string; replayed: boolean }>
  | Readonly<{
      ok: false;
      code:
        | SettingsValidationError
        | "not_initialized"
        | "invalid_if_match"
        | "revision_conflict"
        | "invalid_idempotency_key"
        | "idempotency_conflict";
    }>;

/**
 * The Settings HTTP gateway depends on this small contract rather than a
 * storage implementation.  It lets the same domain run in a local test and
 * behind the one Cloudflare Durable Object without changing write semantics.
 */
export interface OwnerSettingsService {
  initialize(): Promise<SettingsWriteResult>;
  read(): Promise<SettingsReadModel | undefined>;
  save(settings: unknown, ifMatch: string | undefined, idempotencyKey: string | undefined): Promise<SettingsWriteResult>;
  reset(ifMatch: string | undefined, idempotencyKey: string | undefined): Promise<SettingsWriteResult>;
}

export type OwnerSettingsDOOptions = Readonly<{
  storage: SettingsStorage;
  getCapabilityReceipt: () => CapabilityReceipt;
  getActiveSessionSummary?: () => Promise<ActiveSessionSummary | null>;
  now: () => Date;
}>;

const makeEtag = (revision: number): string => `"settings-${revision}"`;

type LegacySettingsDocument = Readonly<{
  schemaVersion: "1";
  revision: number;
  defaultsVersion: string;
  catalogVersion: string;
  settings: Readonly<{
    codexModelId: string;
    claudeModelId: string;
    reasoningDepth: string;
    speedPreset: string;
  }>;
  createdAt: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const supportedLegacyEffort = (
  model: ProviderModelCapability | undefined,
  effort: string
): ProviderReasoningEffort | null =>
  model !== undefined && model.availability === "available" &&
    model.supportedReasoningEfforts.includes(effort) &&
    typeof model.reasoningMappings[effort] === "string"
    ? effort
    : null;

function parseLegacyDocument(value: unknown): LegacySettingsDocument | undefined {
  if (!isRecord(value) || value.schemaVersion !== "1" || typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) || value.revision < 1 ||
    typeof value.defaultsVersion !== "string" || typeof value.catalogVersion !== "string" ||
    !isIsoDate(value.createdAt) || !isRecord(value.settings)) return undefined;
  const settings = value.settings;
  if (typeof settings.codexModelId !== "string" || typeof settings.claudeModelId !== "string" ||
    typeof settings.reasoningDepth !== "string" || typeof settings.speedPreset !== "string") return undefined;
  return Object.freeze({
    schemaVersion: "1",
    revision: value.revision,
    defaultsVersion: value.defaultsVersion,
    catalogVersion: value.catalogVersion,
    settings: Object.freeze({
      codexModelId: settings.codexModelId,
      claudeModelId: settings.claudeModelId,
      reasoningDepth: settings.reasoningDepth,
      speedPreset: settings.speedPreset
    }),
    createdAt: value.createdAt
  });
}

function isCurrentDocument(value: unknown): value is SettingsDocument {
  return isRecord(value) && value.schemaVersion === "2" && typeof value.revision === "number" && Number.isSafeInteger(value.revision) &&
    value.revision >= 1 && typeof value.defaultsVersion === "string" && typeof value.catalogVersion === "string" &&
    isIsoDate(value.createdAt) && isIsoDate(value.updatedAt) && value.actor === "owner" &&
    parseOwnerSettings(value.settings).ok;
}

function migrateProviderSettings(
  legacyModelId: string,
  legacyEffort: string,
  models: readonly ProviderModelCapability[],
  fallback: ProviderSettings
): ProviderSettings {
  const selected = models.find((model) => model.productId === legacyModelId && model.availability === "available");
  const model = selected ?? models.find((candidate) => candidate.productId === fallback.modelId);
  if (model === undefined) return fallback;
  return Object.freeze({
    modelId: model.productId,
    reasoningEffort: supportedLegacyEffort(model, legacyEffort)
  });
}

function migrateLegacySettings(
  legacy: LegacySettingsDocument,
  defaults: OwnerSettings,
  receipt: CapabilityReceipt
): OwnerSettings {
  const speedPreset = ["швидко", "збалансовано", "ретельно"].includes(legacy.settings.speedPreset)
    ? legacy.settings.speedPreset as SpeedPreset
    : defaults.speedPreset;
  return Object.freeze({
    codex: migrateProviderSettings(legacy.settings.codexModelId, legacy.settings.reasoningDepth, receipt.codexModels, defaults.codex),
    claude: migrateProviderSettings(legacy.settings.claudeModelId, legacy.settings.reasoningDepth, receipt.claudeModels, defaults.claude),
    speedPreset
  });
}

function safeActiveSessionSummary(value: ActiveSessionSummary): ActiveSessionSummary | undefined {
  const settings = parseOwnerSettings(value.effectiveSettings);
  if (
    !settings.ok ||
    !Number.isSafeInteger(value.settingsRevision) ||
    value.settingsRevision < 1 ||
    value.catalogVersion.trim().length === 0 ||
    value.catalogVersion.length > 256 ||
    !Number.isFinite(Date.parse(value.startedAt))
  ) return undefined;
  return Object.freeze({
    settingsRevision: value.settingsRevision,
    catalogVersion: value.catalogVersion,
    startedAt: value.startedAt,
    effectiveSettings: Object.freeze({ ...settings.value })
  });
}

async function hashValue(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isSafeIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

export class OwnerSettingsDO implements OwnerSettingsService {
  readonly #storage: SettingsStorage;
  readonly #getCapabilityReceipt: () => CapabilityReceipt;
  readonly #getActiveSessionSummary: (() => Promise<ActiveSessionSummary | null>) | undefined;
  readonly #now: () => Date;

  constructor(options: OwnerSettingsDOOptions) {
    this.#storage = options.storage;
    this.#getCapabilityReceipt = options.getCapabilityReceipt;
    this.#getActiveSessionSummary = options.getActiveSessionSummary;
    this.#now = options.now;
  }

  async initialize(): Promise<SettingsWriteResult> {
    const receipt = this.#getCapabilityReceipt();
    const now = this.#now();
    const defaults = getValidatedDefaults(receipt, now);
    if (!defaults.ok) return defaults;

    return this.#storage.transaction(async (storage) => {
      const existing = await storage.get<unknown>(SETTINGS_DOCUMENT_KEY);
      if (existing !== undefined) {
        if (isCurrentDocument(existing)) {
          return { ok: true, document: existing, etag: makeEtag(existing.revision), replayed: true };
        }
        const legacy = parseLegacyDocument(existing);
        if (legacy === undefined) return { ok: false, code: "not_initialized" };
        const migrated = migrateLegacySettings(legacy, defaults.value, receipt);
        const validated = validateOwnerSettings(migrated, receipt, now);
        if (!validated.ok) return validated;
        const timestamp = now.toISOString();
        const document: SettingsDocument = Object.freeze({
          schemaVersion: "2",
          revision: legacy.revision + 1,
          defaultsVersion: receipt.catalogVersion,
          catalogVersion: receipt.catalogVersion,
          settings: validated.value,
          createdAt: legacy.createdAt,
          updatedAt: timestamp,
          actor: "owner"
        });
        const audit: SettingsAuditRecord = Object.freeze({
          revision: document.revision,
          action: "migrate",
          actor: "system",
          at: timestamp,
          beforeRevision: legacy.revision,
          afterRevision: document.revision,
          catalogVersion: receipt.catalogVersion,
          requestHash: await hashValue({ action: "migrate", legacyRevision: legacy.revision, settings: validated.value }),
          result: "committed"
        });
        await storage.put(SETTINGS_DOCUMENT_KEY, document);
        await storage.put(`${AUDIT_KEY_PREFIX}${document.revision}`, audit);
        return { ok: true, document, etag: makeEtag(document.revision), replayed: false };
      }

      const timestamp = now.toISOString();
      const document: SettingsDocument = Object.freeze({
        schemaVersion: "2",
        revision: 1,
        defaultsVersion: receipt.catalogVersion,
        catalogVersion: receipt.catalogVersion,
        settings: defaults.value,
        createdAt: timestamp,
        updatedAt: timestamp,
        actor: "owner"
      });
      await storage.put(SETTINGS_DOCUMENT_KEY, document);
      return { ok: true, document, etag: makeEtag(document.revision), replayed: false };
    });
  }

  async read(): Promise<SettingsReadModel | undefined> {
    const stored = await this.#storage.get<unknown>(SETTINGS_DOCUMENT_KEY);
    if (!isCurrentDocument(stored)) return undefined;
    const document = stored;

    const receipt = this.#getCapabilityReceipt();
    const now = this.#now();
    const defaults = getValidatedDefaults(receipt, now);
    if (!defaults.ok) return undefined;

    const effective = validateOwnerSettings(document.settings, receipt, now);
    let activeSessionState: ActiveSessionSummaryState = Object.freeze({ status: "unavailable" });
    if (this.#getActiveSessionSummary !== undefined) {
      try {
        const summary = await this.#getActiveSessionSummary();
        activeSessionState = summary === null
          ? Object.freeze({ status: "none" })
          : (() => {
              const safe = safeActiveSessionSummary(summary);
              return safe === undefined
                ? Object.freeze({ status: "unavailable" as const })
                : Object.freeze({ status: "active" as const, value: safe });
            })();
      } catch {
        activeSessionState = Object.freeze({ status: "unavailable" });
      }
    }

    return Object.freeze({
      document,
      defaults: defaults.value,
      effectiveForNextSession: effective.ok ? effective.value : null,
      effectiveIncompatibility: effective.ok ? null : effective.code,
      activeSessionSnapshot: activeSessionState.status === "active" ? activeSessionState.value : null,
      activeSessionStatus: activeSessionState.status,
      etag: makeEtag(document.revision)
    });
  }

  async save(
    settings: unknown,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined
  ): Promise<SettingsWriteResult> {
    return this.#write({ action: "save", settings, ifMatch, idempotencyKey });
  }

  async reset(ifMatch: string | undefined, idempotencyKey: string | undefined): Promise<SettingsWriteResult> {
    const receipt = this.#getCapabilityReceipt();
    return this.#write({ action: "reset", settings: receipt.defaults, ifMatch, idempotencyKey });
  }

  async getAuditRecord(revision: number): Promise<SettingsAuditRecord | undefined> {
    return this.#storage.get<SettingsAuditRecord>(`${AUDIT_KEY_PREFIX}${revision}`);
  }

  async #write(input: Readonly<{
    action: "save" | "reset";
    settings: unknown;
    ifMatch: string | undefined;
    idempotencyKey: string | undefined;
  }>): Promise<SettingsWriteResult> {
    const ifMatch = input.ifMatch;
    const idempotencyKey = input.idempotencyKey;

    if (ifMatch === undefined || ifMatch.length === 0) {
      return { ok: false, code: "invalid_if_match" };
    }
    if (idempotencyKey === undefined || !isSafeIdempotencyKey(idempotencyKey)) {
      return { ok: false, code: "invalid_idempotency_key" };
    }

    const receipt = this.#getCapabilityReceipt();
    const now = this.#now();
    const validated = validateOwnerSettings(input.settings, receipt, now);
    if (!validated.ok) return validated;

    const bodyHash = await hashValue({ action: input.action, settings: validated.value });

    return this.#storage.transaction(async (storage) => {
      const previous = await storage.get<unknown>(SETTINGS_DOCUMENT_KEY);
      if (!isCurrentDocument(previous)) return { ok: false, code: "not_initialized" };

      const nowEpoch = now.getTime();
      const ledger = ((await storage.get<readonly IdempotencyRecord[]>(IDEMPOTENCY_LEDGER_KEY)) ?? [])
        .filter((entry) => Date.parse(entry.expiresAt) > nowEpoch)
        .slice(-MAX_IDEMPOTENCY_ENTRIES);
      const priorRequest = ledger.find((entry) => entry.key === idempotencyKey);
      if (priorRequest !== undefined) {
        if (priorRequest.bodyHash !== bodyHash) return { ok: false, code: "idempotency_conflict" };

        return {
          ok: true,
          document: priorRequest.document,
          etag: makeEtag(priorRequest.document.revision),
          replayed: true
        };
      }

      if (ifMatch !== makeEtag(previous.revision)) {
        return { ok: false, code: "revision_conflict" };
      }

      const timestamp = now.toISOString();
      const document: SettingsDocument = Object.freeze({
        schemaVersion: "2",
        revision: previous.revision + 1,
        defaultsVersion: receipt.catalogVersion,
        catalogVersion: receipt.catalogVersion,
        settings: validated.value,
        createdAt: previous.createdAt,
        updatedAt: timestamp,
        actor: "owner"
      });
      const audit: SettingsAuditRecord = Object.freeze({
        revision: document.revision,
        action: input.action,
        actor: "owner",
        at: timestamp,
        beforeRevision: previous.revision,
        afterRevision: document.revision,
        catalogVersion: receipt.catalogVersion,
        requestHash: bodyHash,
        result: "committed"
      });

      await storage.put(SETTINGS_DOCUMENT_KEY, document);
      await storage.put(`${AUDIT_KEY_PREFIX}${document.revision}`, audit);
      const record: IdempotencyRecord = Object.freeze({
        key: idempotencyKey,
        bodyHash,
        document,
        expiresAt: new Date(nowEpoch + IDEMPOTENCY_TTL_MILLISECONDS).toISOString()
      });
      await storage.put(IDEMPOTENCY_LEDGER_KEY, Object.freeze([...ledger, record].slice(-MAX_IDEMPOTENCY_ENTRIES)));

      return { ok: true, document, etag: makeEtag(document.revision), replayed: false };
    });
  }
}
