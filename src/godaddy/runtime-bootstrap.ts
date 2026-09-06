import { createRuntimeCapabilityCatalog, type RuntimeCapabilityCatalogResult } from "../runtime/capability-catalog.ts";
import { ClaudeDiscoveryFailure, createGoDaddyClaudeCodeProcess, type GoDaddyClaudeCodeProcess } from "./claude-code-process.ts";
import { createGoDaddyCodexAppServer, type CodexDeviceAuthorization, type GoDaddyCodexAppServer } from "./codex-app-server-process.ts";
import { MySqlKeyValueStorage, type MySqlPool } from "./mysql-storage.ts";
import { createRuntimeCredentialVault } from "./runtime-credential-vault.ts";
import { parseHistoricalOwnerSettings } from "../settings/schema.ts";
import type { CodexAppServerThreadClient } from "../runtime/codex-thread-client.ts";
import type { ClaudeCodeSubscriptionProcess } from "../runtime/claude-code-critic.ts";
import { parseCapabilityReceipt } from "../settings/capability-receipt.ts";
import type { CapabilityReceipt, CriticProvider, OwnerSettings, ProviderModelCapability } from "../settings/types.ts";

const CATALOG_STORAGE_KEY = "current";
const CATALOG_NAMESPACE = "runtime-capability-v1";
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
  const credentialStorage = new MySqlKeyValueStorage({ executor: options.pool, namespace: "runtime-credentials-v1" });
  const vault = createRuntimeCredentialVault({ storage: credentialStorage, rootSecret: options.environment.SETTINGS_CSRF_HMAC_KEY });
  let catalog = options.initialCatalog;
  const codex = options.codex ?? (vault === undefined ? undefined : createGoDaddyCodexAppServer({ environment: options.environment, vault }));
  const claude = options.claude ?? createGoDaddyClaudeCodeProcess({
    environment: options.environment,
    getModels: () => catalog?.claudeModels ?? []
  });
  let pendingMutation: Promise<unknown> = Promise.resolve();
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

  return Object.freeze({
    loadCatalog,
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
        }
        return result;
      });
    },
    async close(): Promise<void> {
      await codex?.close();
    }
  });
}

export const runtimeCapabilityStorageNamespace = (): string => CATALOG_NAMESPACE;
