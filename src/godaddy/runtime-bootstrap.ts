import { createHash } from "node:crypto";
import { createRuntimeCapabilityCatalog, type RuntimeCapabilityCatalogResult } from "../runtime/capability-catalog.ts";
import { ClaudeDiscoveryFailure, createGoDaddyClaudeCodeProcess, type GoDaddyClaudeCodeProcess } from "./claude-code-process.ts";
import { createGoDaddyCodexAppServer, type CodexDeviceAuthorization, type GoDaddyCodexAppServer } from "./codex-app-server-process.ts";
import { MySqlKeyValueStorage, type MySqlPool } from "./mysql-storage.ts";
import { createRuntimeCredentialVault } from "./runtime-credential-vault.ts";
import { parseHistoricalOwnerSettings } from "../settings/schema.ts";
import type { CodexAppServerThreadClient } from "../runtime/codex-thread-client.ts";
import type { ClaudeCodeSubscriptionProcess } from "../runtime/claude-code-critic.ts";
import { parseCapabilityReceipt } from "../settings/capability-receipt.ts";
import { validateCatalogTiming, validateOwnerSettings } from "../settings/catalog.ts";
import { FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES } from "../runtime/environment.ts";
import type { CapabilityReceipt, CriticProvider, OwnerSettings, ProviderModelCapability, ProviderSettings } from "../settings/types.ts";

const CATALOG_STORAGE_KEY = "current";
const CATALOG_NAMESPACE = "runtime-capability-v1";
const SELECTION_LEASE_NAMESPACE = "runtime-selection-capability-v1";
const PREFERRED_CLAUDE_DEFAULT_MODEL_IDS = Object.freeze([
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet"
]);

export type RuntimeBootstrapStatus = Readonly<{
  codex: "ready" | "auth_required" | "quota_blocked" | "unavailable";
  codexPlanType?: string;
  claude: "ready" | "auth_required" | "quota_blocked" | "unavailable" | "not_checked";
}>;

export type RuntimeBootstrap = Readonly<{
  loadCatalog: () => Promise<CapabilityReceipt | undefined>;
  status: (provider?: CriticProvider) => Promise<RuntimeBootstrapStatus>;
  startCodexDeviceAuthorization: () => Promise<CodexDeviceAuthorization | undefined>;
  resetCodexAuthorization: () => Promise<boolean>;
  refreshCatalog: (provider?: CriticProvider) => Promise<RuntimeCapabilityCatalogResult>;
  ensureCatalogForSettings?: (settings: OwnerSettings, expectedCatalogVersion?: string) => Promise<CapabilityReceipt | undefined>;
  getCodexThreadClient?: () => Promise<CodexAppServerThreadClient | undefined>;
  getClaudeProcess?: () => ClaudeCodeSubscriptionProcess | undefined;
  close: () => Promise<void>;
}>;

export type RuntimeBootstrapOptions = Readonly<{
  environment: Record<string, unknown>;
  pool: MySqlPool;
  now?: () => Date;
  initialCatalog?: CapabilityReceipt;
  codex?: GoDaddyCodexAppServer;
  claude?: GoDaddyClaudeCodeProcess;
}>;

function chooseDefaults(codexModels: readonly ProviderModelCapability[], claudeModels: readonly ProviderModelCapability[], provider: CriticProvider, codexDefault?: string): OwnerSettings | undefined {
  const codex = codexModels.find(model => model.productId === codexDefault) ?? codexModels[0];
  if (codex === undefined) return undefined;
  const claude = PREFERRED_CLAUDE_DEFAULT_MODEL_IDS.map(id => claudeModels.find(model => model.productId === id)).find(Boolean) ?? claudeModels[0];
  return Object.freeze({
    codex: Object.freeze({ modelId: codex.productId, reasoningEffort: null }),
    critic: Object.freeze({ provider,
      claude: claude === undefined ? null : Object.freeze({ modelId: claude.productId, reasoningEffort: null }),
      codex: Object.freeze({ modelId: codexModels.find(model => model.runtimeModelId === "gpt-6-astra")?.productId ?? "gpt-6-astra", reasoningEffort: "xhigh" })
    }),
    speedPreset: "збалансовано"
  });
}

/**
 * Performs an explicit owner-operated capability refresh.  It records only
 * provider-confirmed models and never accepts an operator-provided model list
 * as fact.  The receipt expires, so an unavailable/changed subscription must
 * be rechecked rather than silently reused.
 */
export function createRuntimeBootstrap(options: RuntimeBootstrapOptions): RuntimeBootstrap {
  const now = options.now ?? (() => new Date());
  const runtimeStorage = new MySqlKeyValueStorage({ executor: options.pool, namespace: CATALOG_NAMESPACE });
  const selectionLeaseStorage = new MySqlKeyValueStorage({ executor: options.pool, namespace: SELECTION_LEASE_NAMESPACE });
  const credentialStorage = new MySqlKeyValueStorage({ executor: options.pool, namespace: "runtime-credentials-v1" });
  const vault = createRuntimeCredentialVault({ storage: credentialStorage, rootSecret: options.environment.RUNTIME_CREDENTIAL_ENCRYPTION_KEY });
  let catalog = options.initialCatalog;
  const codex = options.codex ?? (vault === undefined ? undefined : createGoDaddyCodexAppServer({ environment: options.environment, vault }));
  const claude = options.claude ?? createGoDaddyClaudeCodeProcess({
    environment: options.environment,
    getModels: () => catalog?.claudeModels ?? []
  });
  let pendingMutation: Promise<unknown> = Promise.resolve();
  let closing = false;
  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pendingMutation.then(operation, operation);
    pendingMutation = result.then(() => undefined, () => undefined);
    return result;
  };
  // Retain authentic historical receipts as historical evidence during a
  // partial refresh; never present their expired envelope as currently ready.
  const historicalReceipt = (value: unknown): CapabilityReceipt | undefined => {
    if (typeof value !== "object" || value === null || !("issuedAt" in value) || typeof value.issuedAt !== "string") return undefined;
    const issuedAt = new Date(value.issuedAt);
    return Number.isFinite(issuedAt.getTime()) ? parseCapabilityReceipt(value, issuedAt) : undefined;
  };

  const loadCatalog = async (): Promise<CapabilityReceipt | undefined> => {
    const current = catalog === undefined ? undefined : parseCapabilityReceipt(catalog, now());
    if (current !== undefined) return current;
    try {
      const stored = await runtimeStorage.get<unknown>(CATALOG_STORAGE_KEY);
      const parsed = parseCapabilityReceipt(stored, now());
      const history = parsed ?? historicalReceipt(stored);
      if (history !== undefined) catalog = history;
      return parsed;
    } catch {
      return undefined;
    }
  };

  const revalidations = new Map<string, Promise<CapabilityReceipt | undefined>>();
  const failedRevalidations = new Map<string, number>();
  const selectionLeases = new Map<string, CapabilityReceipt>();
  const freshForSelection = (receipt: CapabilityReceipt, settings: OwnerSettings): boolean =>
    validateCatalogTiming(receipt, now()) === null &&
    (settings.critic.provider === "codex" ? ["codex"] as const : ["codex", "claude_code"] as const).every(provider => {
      const entry = receipt.providerReceipts?.[provider];
      return entry === undefined || (entry.status === "ready" && validateCatalogTiming(entry, now()) === null);
    });
  const selectedModel = (models: readonly ProviderModelCapability[], selection: ProviderSettings): ProviderModelCapability | undefined =>
    models.find(model => model.productId === selection.modelId && model.availability === "available"
      && (selection.reasoningEffort === null || (model.supportedReasoningEfforts.includes(selection.reasoningEffort)
        && model.reasoningMappings[selection.reasoningEffort] === selection.reasoningEffort)));

  const selectionLeaseKey = (settings: OwnerSettings, catalogVersion: string): string =>
    `selection-${createHash("sha256").update(JSON.stringify({ catalogVersion, settings })).digest("hex")}`;

  const loadSelectionLease = async (settings: OwnerSettings, catalogVersion: string): Promise<Readonly<{
    fresh?: CapabilityReceipt;
    historical?: CapabilityReceipt;
  }>> => {
    const key = selectionLeaseKey(settings, catalogVersion);
    const cached = selectionLeases.get(key);
    if (cached !== undefined) {
      const fresh = parseCapabilityReceipt(cached, now());
      if (fresh !== undefined && freshForSelection(fresh, settings) && validateOwnerSettings(settings, fresh, now()).ok) {
        return { fresh, historical: fresh };
      }
    }
    try {
      const stored = await selectionLeaseStorage.get<unknown>(key);
      const historical = historicalReceipt(stored);
      if (historical?.catalogVersion !== catalogVersion) return {};
      const fresh = parseCapabilityReceipt(stored, now());
      if (fresh === undefined || !freshForSelection(fresh, settings) || !validateOwnerSettings(settings, fresh, now()).ok) {
        return { historical };
      }
      selectionLeases.set(key, fresh);
      return { fresh, historical };
    } catch {
      return {};
    }
  };

  const persistSelectionLease = async (settings: OwnerSettings, receipt: CapabilityReceipt): Promise<boolean> => {
    const key = selectionLeaseKey(settings, receipt.catalogVersion);
    try {
      await selectionLeaseStorage.put(key, receipt);
      selectionLeases.set(key, receipt);
      return true;
    } catch {
      return false;
    }
  };

  // Unattended Browser reception includes content-free capability revalidation,
  // not authentication, a new provider, default selection or a catalog sweep.
  // Only the already-saved models/efforts may receive a harmless probe.
  const revalidateSelection = async (settings: OwnerSettings, expectedCatalogVersion?: string): Promise<CapabilityReceipt | undefined> => {
    if (closing) return undefined;
    const current = await loadCatalog();
    if (current !== undefined && (expectedCatalogVersion === undefined || current.catalogVersion === expectedCatalogVersion)
      && freshForSelection(current, settings) && validateOwnerSettings(settings, current, now()).ok) {
      return await persistSelectionLease(settings, current) ? current : undefined;
    }
    const requestedVersion = expectedCatalogVersion ?? historicalReceipt(catalog)?.catalogVersion;
    if (requestedVersion === undefined) return undefined;
    const savedLease = await loadSelectionLease(settings, requestedVersion);
    if (savedLease.fresh !== undefined) return savedLease.fresh;
    const globalHistory = historicalReceipt(catalog);
    const previous = savedLease.historical ?? (globalHistory?.catalogVersion === requestedVersion ? globalHistory : undefined);
    if (previous === undefined || codex === undefined
      || FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES.some(name => Object.hasOwn(options.environment, name))) return undefined;
    const selections = settings.critic.provider === "codex" && settings.critic.codex !== null
      ? [settings.codex, settings.critic.codex] : [settings.codex];
    const oldCodex = selections.map(selection => selectedModel(previous.codexModels, selection));
    if (oldCodex.some(model => model === undefined)) return undefined;
    const codexProbe = await codex.inspectSubscription();
    if (codexProbe.runtime.readiness !== "ready" || codexProbe.runtime.authMode !== "chatgpt_oauth"
      || !codexProbe.runtime.privateSingleOwner) return undefined;
    const currentCodex = selections.map(selection => selectedModel(codexProbe.models, selection));
    if (currentCodex.some((model, index) => model === undefined || model.runtimeModelId !== oldCodex[index]!.runtimeModelId)) return undefined;
    const verifiedCodexModelIds: string[] = [];
    for (const [index, model] of currentCodex.entries()) {
      if (model!.runtimeModelId !== "gpt-6-astra" || verifiedCodexModelIds.includes(model!.productId)) continue;
      if (selections[index]!.reasoningEffort !== "xhigh") return undefined;
      if (!await codex.verifyModelSelection?.(model!.runtimeModelId, "xhigh")) return undefined;
      verifiedCodexModelIds.push(model!.productId);
    }
    let claudeProbe: Parameters<typeof createRuntimeCapabilityCatalog>[0]["claude"];
    if (settings.critic.provider === "claude_code") {
      const selection = settings.critic.claude;
      if (claude === undefined || selection === null) return undefined;
      const model = selectedModel(previous.claudeModels, selection);
      if (model === undefined) return undefined;
      const status = await claude.inspectSubscription();
      if (status.readiness !== "ready" || status.authMode !== "claude_code_oauth" || !status.privateSingleOwner
        || status.bareMode || status.fastModeEnabled || status.extraUsageEnabled) return undefined;
      const completion = await claude.runCritique({ modelId: model.productId, runtimeModelId: model.runtimeModelId,
        reasoningEffort: selection.reasoningEffort, prompt: "Reply with the single word READY. Do not use tools." });
      if (typeof completion.body !== "string" || completion.body.trim().length === 0) return undefined;
      // This probe proves only the selected model/effort, not every historical
      // Claude candidate. Full discovery remains an explicit owner action.
      const efforts = selection.reasoningEffort === null ? [] : [selection.reasoningEffort];
      const capability: ProviderModelCapability = { ...model, supportedReasoningEfforts: efforts,
        reasoningMappings: Object.fromEntries(efforts.map(effort => [effort, effort])) };
      claudeProbe = { runtime: { ...status, availableModelIds: [model.productId] }, models: [capability] };
    }
    const issuedAt = now();
    const result = createRuntimeCapabilityCatalog({ codex: codexProbe,
      ...(claudeProbe === undefined ? {} : { claude: claudeProbe }), previous, verifiedCodexModelIds,
      defaults: previous.defaults, catalogVersion: requestedVersion,
      issuedAt, expiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60_000) });
    if (closing || !result.ok || !validateOwnerSettings(settings, result.receipt, now()).ok) return undefined;
    return await persistSelectionLease(settings, result.receipt) ? result.receipt : undefined;
  };

  return Object.freeze({
    loadCatalog,
    ensureCatalogForSettings(settings: OwnerSettings, expectedCatalogVersion?: string): Promise<CapabilityReceipt | undefined> {
      if (closing) return Promise.resolve(undefined);
      const parsed = parseHistoricalOwnerSettings(settings);
      if (!parsed.ok || (expectedCatalogVersion !== undefined && (expectedCatalogVersion.trim().length === 0 || expectedCatalogVersion.length > 512))) {
        return Promise.resolve(undefined);
      }
      const key = JSON.stringify({ settings: parsed.value, expectedCatalogVersion });
      const pending = revalidations.get(key);
      if (pending !== undefined) return pending;
      if ((failedRevalidations.get(key) ?? 0) > now().getTime()) return Promise.resolve(undefined);
      const operation = serializeMutation(() => revalidateSelection(parsed.value, expectedCatalogVersion)).catch(() => undefined).then(result => {
        if (result === undefined) {
          // Bound repeated failed probes without acknowledging stale evidence.
          if (failedRevalidations.size >= 16) failedRevalidations.delete(failedRevalidations.keys().next().value!);
          failedRevalidations.set(key, now().getTime() + 30_000);
        } else failedRevalidations.delete(key);
        return result;
      }).finally(() => { if (revalidations.get(key) === operation) revalidations.delete(key); });
      revalidations.set(key, operation);
      return operation;
    },
    getCodexThreadClient: async () => codex?.getThreadClient?.(),
    getClaudeProcess: () => claude,
    async status(provider: CriticProvider = "codex"): Promise<RuntimeBootstrapStatus> {
      const [codexProbe, claudeStatus] = await Promise.all([
        Promise.resolve().then(() => codex?.inspectSubscription()).catch(() => undefined),
        provider === "claude_code" ? Promise.resolve().then(() => claude?.inspectSubscription()).catch(() => undefined) : Promise.resolve(undefined)
      ]);
      return Object.freeze({
        codex: codexProbe?.runtime.readiness ?? "unavailable",
        ...(codexProbe?.planType === undefined ? {} : { codexPlanType: codexProbe.planType }),
        claude: claudeStatus?.readiness ?? (provider === "claude_code" ? "unavailable" : "not_checked")
      });
    },
    async startCodexDeviceAuthorization(): Promise<CodexDeviceAuthorization | undefined> {
      return codex?.startDeviceAuthorization();
    },
    async resetCodexAuthorization(): Promise<boolean> {
      return serializeMutation(async () => {
        if (codex === undefined) return false;
        try {
          await runtimeStorage.delete(CATALOG_STORAGE_KEY);
          catalog = undefined;
        } catch {
          return false;
        }
        return codex.resetAuthorization();
      });
    },
    async refreshCatalog(provider: CriticProvider = "codex"): Promise<RuntimeCapabilityCatalogResult> {
      return serializeMutation(async (): Promise<RuntimeCapabilityCatalogResult> => {
        if (provider !== "codex" && provider !== "claude_code") return { ok: false, code: "private_boundary_failed" };
        if (codex === undefined) return { ok: false, code: "codex_not_ready" };
        let codexProbe: Awaited<ReturnType<GoDaddyCodexAppServer["inspectSubscription"]>>;
        try { codexProbe = await codex.inspectSubscription(); }
        catch { return { ok: false, code: "catalog_refresh_failed" }; }
        if (codexProbe.runtime.readiness !== "ready" || codexProbe.runtime.authMode !== "chatgpt_oauth") return { ok: false, code: "codex_not_ready" };
        if (!codexProbe.runtime.privateSingleOwner) return { ok: false, code: "private_boundary_failed" };
        await loadCatalog();
        const previous = historicalReceipt(catalog);
        let claudeProbe: Parameters<typeof createRuntimeCapabilityCatalog>[0]["claude"];
        if (provider === "claude_code") {
          if (claude === undefined) return { ok: false, code: "claude_not_ready" };
          let status: Awaited<ReturnType<GoDaddyClaudeCodeProcess["inspectSubscription"]>>;
          try { status = await claude.inspectSubscription(); }
          catch { return { ok: false, code: "catalog_refresh_failed" }; }
          if (status.readiness !== "ready" || status.authMode !== "claude_code_oauth") return { ok: false, code: "claude_not_ready" };
          if (!status.privateSingleOwner) return { ok: false, code: "private_boundary_failed" };
          if (status.fastModeEnabled || status.extraUsageEnabled) return { ok: false, code: "claude_paid_acceleration_forbidden" };
          try {
            const models = await claude.discoverModels();
            if (models.length === 0) return { ok: false, code: "claude_models_unavailable" };
            claudeProbe = { runtime: { ...status, availableModelIds: models.map(model => model.productId) }, models };
          } catch (error) {
            return { ok: false, code: error instanceof ClaudeDiscoveryFailure ? error.code : "catalog_refresh_failed" };
          }
        }
        const parsedDefaults = parseHistoricalOwnerSettings(previous?.defaults);
        const defaults = parsedDefaults.ok ? parsedDefaults.value : chooseDefaults(codexProbe.models, claudeProbe?.models ?? [], provider, codexProbe.defaultModelId);
        if (defaults === undefined) return { ok: false, code: "invalid_defaults" };
        const verifiedCodexModelIds: string[] = [];
        const astra = codexProbe.models.find(model => model.runtimeModelId === "gpt-6-astra" && model.supportedReasoningEfforts.includes("xhigh") && model.reasoningMappings.xhigh === "xhigh");
        if (astra !== undefined) {
          try {
            if (await codex.verifyModelSelection?.(astra.runtimeModelId, "xhigh")) verifiedCodexModelIds.push(astra.productId);
          } catch {
            // An unavailable exact Astra/xhigh probe invalidates that selection,
            // not other models already confirmed by this Codex runtime.
          }
        }
        const issuedAt = now();
        const result = createRuntimeCapabilityCatalog({
          codex: codexProbe, ...(claudeProbe === undefined ? {} : { claude: claudeProbe }),
          ...(previous === undefined ? {} : { previous }), verifiedCodexModelIds, defaults,
          catalogVersion: `runtime-${issuedAt.getTime()}`,
          issuedAt, expiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60_000)
        });
        if (result.ok) {
          try { await runtimeStorage.put(CATALOG_STORAGE_KEY, result.receipt); }
          catch { return { ok: false, code: "catalog_storage_failed" }; }
          catalog = result.receipt;
          failedRevalidations.clear();
        }
        return result;
      });
    },
    async close(): Promise<void> {
      closing = true;
      await pendingMutation;
      await codex?.close();
    }
  });
}

export const runtimeCapabilityStorageNamespace = (): string => CATALOG_NAMESPACE;
