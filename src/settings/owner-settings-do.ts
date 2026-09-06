import { getValidatedDefaults, validateOwnerSettings, type SettingsValidationError } from "./catalog.ts";
import type { SettingsStorage } from "./storage.ts";
import type { CapabilityReceipt, OwnerSettings } from "./types.ts";
import { parseHistoricalOwnerSettings, parseOwnerSettings } from "./schema.ts";

const SETTINGS_DOCUMENT_KEY = "owner-settings:document";
const IDEMPOTENCY_LEDGER_KEY = "owner-settings:idempotency-ledger";
const AUDIT_KEY_PREFIX = "owner-settings:audit:";
const MAX_IDEMPOTENCY_ENTRIES = 64;
const IDEMPOTENCY_TTL_MILLISECONDS = 24 * 60 * 60_000;

export type SettingsDocument = Readonly<{
  schemaVersion: "3";
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
  document: unknown;
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
  defaultsIncompatibility?: SettingsValidationError | null;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

function isCurrentDocument(value: unknown): value is SettingsDocument {
  return isRecord(value) && value.schemaVersion === "3" && typeof value.revision === "number" && Number.isSafeInteger(value.revision) &&
    value.revision >= 1 && typeof value.defaultsVersion === "string" && typeof value.catalogVersion === "string" &&
    isIsoDate(value.createdAt) && isIsoDate(value.updatedAt) && value.actor === "owner" &&
    parseOwnerSettings(value.settings).ok;
}

/** Pure projection: historical documents/ledger entries are never rewritten by a read. */
export function readCompatibleSettingsDocument(value: unknown): SettingsDocument | undefined {
  if (isCurrentDocument(value)) return value;
  if (!isRecord(value) || (value.schemaVersion !== "1" && value.schemaVersion !== "2") ||
    typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
    typeof value.defaultsVersion !== "string" || typeof value.catalogVersion !== "string" ||
    !isIsoDate(value.createdAt) || !isRecord(value.settings)) return undefined;
  if (value.schemaVersion === "2" && (!isIsoDate(value.updatedAt) || value.actor !== "owner")) return undefined;
  if (value.schemaVersion === "1" && Object.keys(value.settings).sort().join(",") !== "claudeModelId,codexModelId,reasoningDepth,speedPreset") return undefined;
  const input = value.schemaVersion === "1" ? {
    codex: { modelId: value.settings.codexModelId, reasoningEffort: value.settings.reasoningDepth },
    critic: { provider: "claude_code", claude: { modelId: value.settings.claudeModelId, reasoningEffort: value.settings.reasoningDepth }, codex: null },
    speedPreset: value.settings.speedPreset
  } : value.settings;
  const settings = parseHistoricalOwnerSettings(input);
  if (!settings.ok) return undefined;
  return Object.freeze({
    schemaVersion: "3", revision: value.revision, defaultsVersion: value.defaultsVersion,
    catalogVersion: value.catalogVersion, settings: settings.value, createdAt: value.createdAt,
    updatedAt: isIsoDate(value.updatedAt) ? value.updatedAt : value.createdAt, actor: "owner"
  });
}

function safeActiveSessionSummary(value: ActiveSessionSummary): ActiveSessionSummary | undefined {
  const settings = parseHistoricalOwnerSettings(value.effectiveSettings);
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

function requestIdentitySettings(value: unknown): unknown {
  const current = parseOwnerSettings(value);
  if (current.ok) return current.value;
  const historical = parseHistoricalOwnerSettings(value);
  if (historical.ok && isRecord(value) && "claude" in value) {
    // Preserve the old canonical body order/hash, not its v3 projection.
    return { codex: historical.value.codex, claude: historical.value.critic.claude, speedPreset: historical.value.speedPreset };
  }
  if (isRecord(value) && Object.keys(value).sort().join(",") === "claudeModelId,codexModelId,reasoningDepth,speedPreset") {
    return { codexModelId: value.codexModelId, claudeModelId: value.claudeModelId,
      reasoningDepth: value.reasoningDepth, speedPreset: value.speedPreset };
  }
  return value;
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

    return this.#storage.transaction(async (storage) => {
      const existing = await storage.get<unknown>(SETTINGS_DOCUMENT_KEY);
      if (existing !== undefined) {
        if (isCurrentDocument(existing)) {
          return { ok: true, document: existing, etag: makeEtag(existing.revision), replayed: true };
        }
        const legacy = readCompatibleSettingsDocument(existing);
        if (legacy === undefined || legacy.revision === Number.MAX_SAFE_INTEGER) return { ok: false, code: "not_initialized" };
        const timestamp = now.toISOString();
        const document: SettingsDocument = Object.freeze({
          schemaVersion: "3",
          revision: legacy.revision + 1,
          defaultsVersion: legacy.defaultsVersion,
          catalogVersion: legacy.catalogVersion,
          settings: legacy.settings,
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
          catalogVersion: legacy.catalogVersion,
          requestHash: await hashValue({ action: "migrate", legacyRevision: legacy.revision, settings: legacy.settings }),
          result: "committed"
        });
        await storage.put(SETTINGS_DOCUMENT_KEY, document);
        await storage.put(`${AUDIT_KEY_PREFIX}${document.revision}`, audit);
        return { ok: true, document, etag: makeEtag(document.revision), replayed: false };
      }

      const defaults = getValidatedDefaults(receipt, now);
      if (!defaults.ok) return defaults;
      const timestamp = now.toISOString();
      const document: SettingsDocument = Object.freeze({
        schemaVersion: "3",
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
    const defaultSettings = parseHistoricalOwnerSettings(receipt.defaults);
    if (!defaultSettings.ok) return undefined;

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
      defaults: defaultSettings.value,
      defaultsIncompatibility: defaults.ok ? null : defaults.code,
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
    const bodyHash = await hashValue(input.action === "reset" ? { action: "reset" } :
      { action: input.action, settings: requestIdentitySettings(input.settings) });

    return this.#storage.transaction(async (storage) => {
      const previous = await storage.get<unknown>(SETTINGS_DOCUMENT_KEY);
      if (!isCurrentDocument(previous)) return { ok: false, code: "not_initialized" };

      const nowEpoch = now.getTime();
      const ledger = ((await storage.get<readonly IdempotencyRecord[]>(IDEMPOTENCY_LEDGER_KEY)) ?? [])
        .filter((entry) => Date.parse(entry.expiresAt) > nowEpoch)
        .slice(-MAX_IDEMPOTENCY_ENTRIES);
      const priorRequest = ledger.find((entry) => entry.key === idempotencyKey);
      if (priorRequest !== undefined) {
        const legacyResetHash = input.action === "reset" && isRecord(priorRequest.document)
          ? await hashValue({ action: "reset", settings: requestIdentitySettings(priorRequest.document.settings) })
          : undefined;
        if (priorRequest.bodyHash !== bodyHash && priorRequest.bodyHash !== legacyResetHash) {
          return { ok: false, code: "idempotency_conflict" };
        }
        const historicalDocument = readCompatibleSettingsDocument(priorRequest.document);
        if (historicalDocument === undefined) return { ok: false, code: "not_initialized" };
        return {
          ok: true,
          document: historicalDocument,
          etag: makeEtag(historicalDocument.revision),
          replayed: true
        };
      }

      // Replays are historical outcomes, not a new provider invocation. New
      // writes still require exact v3 structure and currently valid capabilities.
      const validated = validateOwnerSettings(input.settings, receipt, now);
      if (!validated.ok) return validated;

      if (ifMatch !== makeEtag(previous.revision)) {
        return { ok: false, code: "revision_conflict" };
      }
      if (previous.revision === Number.MAX_SAFE_INTEGER) return { ok: false, code: "revision_conflict" };

      const timestamp = now.toISOString();
      const document: SettingsDocument = Object.freeze({
        schemaVersion: "3",
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
