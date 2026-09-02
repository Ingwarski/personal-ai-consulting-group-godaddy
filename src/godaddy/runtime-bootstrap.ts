import { createRuntimeCapabilityCatalog, type RuntimeCapabilityCatalogResult } from "../runtime/capability-catalog.ts";
import { createGoDaddyClaudeCodeProcess, type GoDaddyClaudeCodeProcess } from "./claude-code-process.ts";
import { createGoDaddyCodexAppServer, type CodexDeviceAuthorization, type GoDaddyCodexAppServer } from "./codex-app-server-process.ts";
import { MySqlKeyValueStorage, type MySqlPool } from "./mysql-storage.ts";
import { createRuntimeCredentialVault } from "./runtime-credential-vault.ts";
import { parseCapabilityReceipt } from "../settings/capability-receipt.ts";
import type { CapabilityReceipt, OwnerSettings, ProviderModelCapability } from "../settings/types.ts";

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
  claude: "ready" | "auth_required" | "quota_blocked" | "unavailable";
}>;

export type RuntimeBootstrap = Readonly<{
  loadCatalog: () => Promise<CapabilityReceipt | undefined>;
  status: () => Promise<RuntimeBootstrapStatus>;
  startCodexDeviceAuthorization: () => Promise<CodexDeviceAuthorization | undefined>;
  resetCodexAuthorization: () => Promise<boolean>;
  refreshCatalog: () => Promise<RuntimeCapabilityCatalogResult>;
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

function chooseDefaults(codexModels: readonly ProviderModelCapability[], claudeModels: readonly ProviderModelCapability[], codexDefault?: string): OwnerSettings | undefined {
  const codex = codexModels.find((model) => model.productId === codexDefault) ?? codexModels[0];
  const claude = PREFERRED_CLAUDE_DEFAULT_MODEL_IDS
    .map((modelId) => claudeModels.find((model) => model.productId === modelId))
    .find((model): model is ProviderModelCapability => model !== undefined) ?? claudeModels[0];
  if (codex === undefined || claude === undefined) return undefined;
  return Object.freeze({
    codex: Object.freeze({ modelId: codex.productId, reasoningEffort: null }),
    claude: Object.freeze({ modelId: claude.productId, reasoningEffort: null }),
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

  const loadCatalog = async (): Promise<CapabilityReceipt | undefined> => {
    const current = catalog === undefined ? undefined : parseCapabilityReceipt(catalog, now());
    if (current !== undefined) return current;
    try {
      const stored = await runtimeStorage.get<unknown>(CATALOG_STORAGE_KEY);
      const parsed = parseCapabilityReceipt(stored, now());
      if (parsed !== undefined) catalog = parsed;
      return parsed;
    } catch {
      return undefined;
    }
  };

  return Object.freeze({
    loadCatalog,
    async status(): Promise<RuntimeBootstrapStatus> {
      const [codexProbe, claudeStatus] = await Promise.all([
        codex?.inspectSubscription() ?? Promise.resolve(undefined),
        claude?.inspectSubscription() ?? Promise.resolve(undefined)
      ]);
      return Object.freeze({
        codex: codexProbe?.runtime.readiness ?? "unavailable",
        ...(codexProbe?.planType === undefined ? {} : { codexPlanType: codexProbe.planType }),
        claude: claudeStatus?.readiness ?? "unavailable"
      });
    },
    async startCodexDeviceAuthorization(): Promise<CodexDeviceAuthorization | undefined> {
      return codex?.startDeviceAuthorization();
    },
    async resetCodexAuthorization(): Promise<boolean> {
      if (codex === undefined) return false;
      try {
        await runtimeStorage.delete(CATALOG_STORAGE_KEY);
        catalog = undefined;
      } catch {
        return false;
      }
      return codex.resetAuthorization();
    },
    async refreshCatalog(): Promise<RuntimeCapabilityCatalogResult> {
      if (codex === undefined || claude === undefined) return { ok: false, code: "private_boundary_failed" };
      const [codexProbe, claudeStatus] = await Promise.all([codex.inspectSubscription(), claude.inspectSubscription()]);
      if (codexProbe.runtime.readiness !== "ready" || codexProbe.runtime.authMode !== "chatgpt_oauth") return { ok: false, code: "codex_not_ready" };
      if (claudeStatus.readiness !== "ready" || claudeStatus.authMode !== "claude_code_oauth") return { ok: false, code: "claude_not_ready" };
      if (!codexProbe.runtime.privateSingleOwner || !claudeStatus.privateSingleOwner) return { ok: false, code: "private_boundary_failed" };
      if (claudeStatus.fastModeEnabled || claudeStatus.extraUsageEnabled) return { ok: false, code: "claude_paid_acceleration_forbidden" };
      const claudeModels = await claude.discoverModels();
      const defaults = chooseDefaults(codexProbe.models, claudeModels, codexProbe.defaultModelId);
      if (defaults === undefined) return { ok: false, code: "invalid_defaults" };
      const issuedAt = now();
      const result = createRuntimeCapabilityCatalog({
        codex: codexProbe,
        claude: Object.freeze({
          runtime: Object.freeze({ ...claudeStatus, availableModelIds: claudeModels.map((model) => model.productId) }),
          models: claudeModels,
          defaultModelId: defaults.claude.modelId
        }),
        defaults,
        catalogVersion: `runtime-${issuedAt.getTime()}`,
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60_000)
      });
      if (result.ok) {
        await runtimeStorage.put(CATALOG_STORAGE_KEY, result.receipt);
        catalog = result.receipt;
      }
      return result;
    },
    async close(): Promise<void> {
      await codex?.close();
    }
  });
}

export const runtimeCapabilityStorageNamespace = (): string => CATALOG_NAMESPACE;
