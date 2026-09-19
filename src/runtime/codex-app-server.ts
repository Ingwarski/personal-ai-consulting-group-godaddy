import type { ProviderReadiness } from "./provider-preflight.ts";
import type { ProviderModelCapability, ProviderReasoningEffort } from "../settings/types.ts";

export interface CodexAppServerTransport {
  request(method: string, params: unknown): Promise<unknown>;
}

export type CodexAppServerProbe = Readonly<{
  runtime: Readonly<{
    authMode: "chatgpt_oauth" | "other";
    readiness: ProviderReadiness;
    privateSingleOwner: boolean;
    availableModelIds: readonly string[];
  }>;
  models: readonly ProviderModelCapability[];
  defaultModelId?: string;
  planType?: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown, maximum = 512): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;

const allowedEffort = (value: unknown): ProviderReasoningEffort | undefined =>
  typeof value === "string" && /^[a-z][a-z0-9_-]{0,127}$/iu.test(value)
    ? value
    : undefined;

function unavailable(privateSingleOwner: boolean): CodexAppServerProbe {
  return Object.freeze({
    runtime: Object.freeze({ authMode: "other", readiness: "unavailable", privateSingleOwner, availableModelIds: Object.freeze([]) }),
    models: Object.freeze([])
  });
}

function parseModels(value: unknown): Readonly<{ models: readonly ProviderModelCapability[]; defaultModelId?: string }> | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  const models: ProviderModelCapability[] = [];
  let defaultModelId: string | undefined;
  for (const item of value.data) {
    if (!isRecord(item)) return undefined;
    // Astra was explicitly requested by the owner; other hidden models stay
    // private. Issuance separately requires a successful Astra execution probe.
    if (item.hidden === true && item.model !== "gpt-6-astra") continue;
    if (!nonEmptyString(item.id) || !nonEmptyString(item.model) ||
      !nonEmptyString(item.displayName) || !Array.isArray(item.supportedReasoningEfforts)) return undefined;
    // App Server owns this provider-specific capability list. Preserve it
    // exactly instead of projecting it onto a shared cross-provider scale.
    const efforts: ProviderReasoningEffort[] = [];
    for (const effort of item.supportedReasoningEfforts) {
      if (!isRecord(effort) || !nonEmptyString(effort.reasoningEffort)) return undefined;
      const parsedEffort = allowedEffort(effort.reasoningEffort);
      if (parsedEffort === undefined) return undefined;
      efforts.push(parsedEffort);
    }
    if (new Set(efforts).size !== efforts.length) return undefined;
    const mappings: Record<ProviderReasoningEffort, string> = {};
    for (const effort of efforts) mappings[effort] = effort;
    const defaultReasoningEffort = item.defaultReasoningEffort === undefined
      ? undefined
      : allowedEffort(item.defaultReasoningEffort);
    if (item.defaultReasoningEffort !== undefined &&
      (defaultReasoningEffort === undefined || !efforts.includes(defaultReasoningEffort))) return undefined;
    models.push(Object.freeze({
      productId: item.id,
      displayName: item.displayName,
      runtimeModelId: item.model,
      availability: "available",
      supportedReasoningEfforts: Object.freeze(efforts),
      reasoningMappings: Object.freeze(mappings),
      ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort })
    }));
    if (item.isDefault === true) {
      if (defaultModelId !== undefined) return undefined;
      defaultModelId = item.id;
    }
  }
  if (models.length === 0 || new Set(models.map((model) => model.productId)).size !== models.length) return undefined;
  return Object.freeze({ models: Object.freeze(models), ...(defaultModelId === undefined ? {} : { defaultModelId }) });
}

function parseRateLimitState(value: unknown): "ready" | "quota_blocked" | undefined {
  if (!isRecord(value) || !isRecord(value.rateLimits)) return undefined;
  return value.rateLimits.rateLimitReachedType === null || value.rateLimits.rateLimitReachedType === undefined
    ? "ready"
    : "quota_blocked";
}

/**
 * Uses the documented Codex app-server API rather than model aliases in code.
 * It intentionally accepts only Codex-managed ChatGPT OAuth, never externally
 * supplied tokens, API keys or cloud-provider credentials.
 */
export async function probeCodexAppServer(
  transport: CodexAppServerTransport,
  input: Readonly<{ privateSingleOwner: boolean }>
): Promise<CodexAppServerProbe> {
  try {
    const accountResult = await transport.request("account/read", { refreshToken: false });
    if (!isRecord(accountResult) || !isRecord(accountResult.account)) {
      return Object.freeze({
        runtime: Object.freeze({ authMode: "other", readiness: "auth_required", privateSingleOwner: input.privateSingleOwner, availableModelIds: Object.freeze([]) }),
        models: Object.freeze([])
      });
    }
    if (accountResult.account.type !== "chatgpt") {
      return Object.freeze({
        runtime: Object.freeze({ authMode: "other", readiness: "auth_required", privateSingleOwner: input.privateSingleOwner, availableModelIds: Object.freeze([]) }),
        models: Object.freeze([])
      });
    }
    const [modelResult, limitResult] = await Promise.all([
      readAllModels(transport),
      transport.request("account/rateLimits/read", {})
    ]);
    const parsedModels = parseModels(modelResult);
    const readiness = parseRateLimitState(limitResult);
    if (parsedModels === undefined || readiness === undefined) return unavailable(input.privateSingleOwner);
    return Object.freeze({
      runtime: Object.freeze({
        authMode: "chatgpt_oauth",
        readiness,
        privateSingleOwner: input.privateSingleOwner,
        availableModelIds: Object.freeze(parsedModels.models.map((model) => model.productId))
      }),
      models: parsedModels.models,
      ...(parsedModels.defaultModelId === undefined ? {} : { defaultModelId: parsedModels.defaultModelId }),
      ...(nonEmptyString(accountResult.account.planType) ? { planType: accountResult.account.planType } : {})
    });
  } catch {
    return unavailable(input.privateSingleOwner);
  }
}

async function readAllModels(transport: CodexAppServerTransport): Promise<unknown> {
  const data: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await transport.request("model/list", { limit: 100, includeHidden: true, ...(cursor === undefined ? {} : { cursor }) });
    if (!isRecord(result) || !Array.isArray(result.data)) throw new Error("Invalid model catalog.");
    data.push(...result.data);
    if (data.length > 2_000) throw new Error("Model catalog limit exceeded.");
    if (result.nextCursor === null || result.nextCursor === undefined) return { data };
    if (!nonEmptyString(result.nextCursor) || cursors.has(result.nextCursor)) throw new Error("Invalid model cursor.");
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("Model catalog page limit exceeded.");
}
