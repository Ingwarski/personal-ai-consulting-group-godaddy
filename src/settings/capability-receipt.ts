import { validateOwnerSettings } from "./catalog.ts";
import { REASONING_DEPTHS, SPEED_PRESETS, type CapabilityReceipt, type ModelAvailability, type ProviderModelCapability, type ReasoningDepth } from "./types.ts";

const RECEIPT_HEADER = "x-settings-capability-receipt";
const MAX_RECEIPT_BYTES = 16_384;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown, maximum = 512): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;

const asDepth = (value: unknown): ReasoningDepth | undefined =>
  typeof value === "string" && REASONING_DEPTHS.includes(value as ReasoningDepth)
    ? value as ReasoningDepth
    : undefined;

function parseModel(value: unknown): ProviderModelCapability | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !nonEmptyString(value.productId) ||
    !nonEmptyString(value.displayName) ||
    !nonEmptyString(value.runtimeModelId) ||
    (value.availability !== "available" && value.availability !== "unavailable") ||
    !Array.isArray(value.supportedReasoningDepths) ||
    !isRecord(value.reasoningMappings)
  ) return undefined;

  const depths = value.supportedReasoningDepths.map(asDepth);
  if (depths.some((depth) => depth === undefined) || new Set(depths).size !== depths.length) return undefined;

  const mappings: Partial<Record<ReasoningDepth, string>> = {};
  for (const depth of REASONING_DEPTHS) {
    const mapping = value.reasoningMappings[depth];
    if (mapping !== undefined && !nonEmptyString(mapping)) return undefined;
    if (typeof mapping === "string") mappings[depth] = mapping;
  }

  return Object.freeze({
    productId: value.productId,
    displayName: value.displayName,
    runtimeModelId: value.runtimeModelId,
    availability: value.availability as ModelAvailability,
    supportedReasoningDepths: Object.freeze(depths as ReasoningDepth[]),
    reasoningMappings: Object.freeze(mappings)
  });
}

/**
 * Receipts originate only from the isolated subscription-runtime catalog
 * service. This parser deliberately has no default model and no recovery
 * value: malformed, untrusted or stale input remains unavailable.
 */
export function parseCapabilityReceipt(value: unknown, now: Date): CapabilityReceipt | undefined {
  if (!isRecord(value) || value.trusted !== true || !nonEmptyString(value.catalogVersion) ||
    !nonEmptyString(value.issuedAt) || !nonEmptyString(value.expiresAt) ||
    !Array.isArray(value.codexModels) || !Array.isArray(value.claudeModels) || !isRecord(value.defaults)) {
    return undefined;
  }
  const codexModels = value.codexModels.map(parseModel);
  const claudeModels = value.claudeModels.map(parseModel);
  if (codexModels.some((model) => model === undefined) || claudeModels.some((model) => model === undefined)) return undefined;
  const parsedCodexModels = codexModels as ProviderModelCapability[];
  const parsedClaudeModels = claudeModels as ProviderModelCapability[];
  if (new Set(parsedCodexModels.map((model) => model.productId)).size !== parsedCodexModels.length ||
    new Set(parsedClaudeModels.map((model) => model.productId)).size !== parsedClaudeModels.length) return undefined;
  if (Object.keys(value.defaults).sort().join(",") !== "claudeModelId,codexModelId,reasoningDepth,speedPreset" ||
    !nonEmptyString(value.defaults.codexModelId) || !nonEmptyString(value.defaults.claudeModelId) ||
    asDepth(value.defaults.reasoningDepth) === undefined ||
    typeof value.defaults.speedPreset !== "string" || !SPEED_PRESETS.includes(value.defaults.speedPreset as typeof SPEED_PRESETS[number])) return undefined;

  const receipt: CapabilityReceipt = Object.freeze({
    catalogVersion: value.catalogVersion,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    trusted: true,
    codexModels: Object.freeze(parsedCodexModels),
    claudeModels: Object.freeze(parsedClaudeModels),
    defaults: Object.freeze({
      codexModelId: value.defaults.codexModelId,
      claudeModelId: value.defaults.claudeModelId,
      reasoningDepth: value.defaults.reasoningDepth as ReasoningDepth,
      speedPreset: value.defaults.speedPreset as typeof SPEED_PRESETS[number]
    })
  });
  return validateOwnerSettings(receipt.defaults, receipt, now).ok ? receipt : undefined;
}

const base64Url = (value: Uint8Array): string =>
  btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export function encodeCapabilityReceipt(receipt: CapabilityReceipt): string {
  const encoded = new TextEncoder().encode(JSON.stringify(receipt));
  if (encoded.byteLength > MAX_RECEIPT_BYTES) throw new Error("Capability receipt is too large for the internal boundary.");
  return base64Url(encoded);
}

export function decodeCapabilityReceipt(header: string | null, now: Date): CapabilityReceipt | undefined {
  if (header === null || header.length === 0 || header.length > MAX_RECEIPT_BYTES * 2 || !/^[A-Za-z0-9_-]+$/.test(header)) return undefined;
  const padded = header.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(header.length / 4) * 4, "=");
  try {
    const raw = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (raw.byteLength > MAX_RECEIPT_BYTES) return undefined;
    return parseCapabilityReceipt(JSON.parse(new TextDecoder().decode(raw)), now);
  } catch {
    return undefined;
  }
}

export const capabilityReceiptHeaderName = (): string => RECEIPT_HEADER;
