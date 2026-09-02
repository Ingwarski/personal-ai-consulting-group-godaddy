import type { ProviderReadiness } from "./provider-preflight.ts";
import { REASONING_DEPTHS, type ProviderModelCapability, type ReasoningDepth } from "../settings/types.ts";

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

const allowedEffort = (value: unknown): ReasoningDepth | undefined =>
  typeof value === "string" && REASONING_DEPTHS.includes(value as ReasoningDepth)
    ? value as ReasoningDepth
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
    if (item.hidden === true) continue;
    if (!nonEmptyString(item.id) || !nonEmptyString(item.model) ||
      !nonEmptyString(item.displayName) || !Array.isArray(item.supportedReasoningEfforts)) return undefined;
    // Codex advertises reasoning efforts as open strings.  This application
    // intentionally supports only its own approved subset, so additional
    // provider capabilities must not invalidate a compatible model.
    const depths: ReasoningDepth[] = [];
    for (const effort of item.supportedReasoningEfforts) {
      if (!isRecord(effort) || !nonEmptyString(effort.reasoningEffort)) return undefined;
      const depth = allowedEffort(effort.reasoningEffort);
      if (depth !== undefined) depths.push(depth);
    }
    if (new Set(depths).size !== depths.length) return undefined;
    if (depths.length === 0) continue;
    const mappings: Partial<Record<ReasoningDepth, string>> = {};
    for (const depth of depths) mappings[depth] = depth;
    models.push(Object.freeze({
      productId: item.id,
      displayName: item.displayName,
      runtimeModelId: item.model,
      availability: "available",
      supportedReasoningDepths: Object.freeze(depths),
      reasoningMappings: Object.freeze(mappings)
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
      transport.request("model/list", { limit: 100, includeHidden: false }),
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
