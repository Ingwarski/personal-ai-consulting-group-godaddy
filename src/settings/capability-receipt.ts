import { validateCatalogTiming } from "./catalog.ts";
import { parseHistoricalOwnerSettings } from "./schema.ts";
import { SPEED_PRESETS, type CapabilityReceipt, type ModelAvailability, type ProviderCapabilityReceipt, type ProviderModelCapability, type ProviderReasoningEffort } from "./types.ts";

const RECEIPT_HEADER = "x-settings-capability-receipt";
const MAX_RECEIPT_BYTES = 16_384;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown, maximum = 512): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;

const asEffort = (value: unknown): ProviderReasoningEffort | undefined =>
  typeof value === "string" && /^[a-z][a-z0-9_-]{0,127}$/iu.test(value)
    ? value
    : undefined;

function parseModel(value: unknown): ProviderModelCapability | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !nonEmptyString(value.productId) ||
    !nonEmptyString(value.displayName) ||
    !nonEmptyString(value.runtimeModelId) ||
    (value.availability !== "available" && value.availability !== "unavailable") ||
    !Array.isArray(value.supportedReasoningEfforts) ||
    !isRecord(value.reasoningMappings)
  ) return undefined;

  const efforts = value.supportedReasoningEfforts.map(asEffort);
  if (efforts.some((effort) => effort === undefined) || new Set(efforts).size !== efforts.length) return undefined;

  const mappings: Record<ProviderReasoningEffort, string> = {};
  for (const effort of efforts as ProviderReasoningEffort[]) {
    const mapping = value.reasoningMappings[effort];
    if (!nonEmptyString(mapping)) return undefined;
    mappings[effort] = mapping;
  }
  if (Object.keys(value.reasoningMappings).length !== efforts.length) return undefined;

  const defaultReasoningEffort = value.defaultReasoningEffort === undefined
    ? undefined
    : asEffort(value.defaultReasoningEffort);
  if (value.defaultReasoningEffort !== undefined &&
    (defaultReasoningEffort === undefined || !efforts.includes(defaultReasoningEffort))) return undefined;

  return Object.freeze({
    productId: value.productId,
    displayName: value.displayName,
    runtimeModelId: value.runtimeModelId,
    availability: value.availability as ModelAvailability,
    supportedReasoningEfforts: Object.freeze(efforts as ProviderReasoningEffort[]),
    reasoningMappings: Object.freeze(mappings),
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort })
  });
}

/**
 * Receipts originate only from the isolated subscription-runtime catalog
 * service. This parser deliberately has no default model and no recovery
 * value: malformed, untrusted or stale input remains unavailable.
 */
function parseProviderReceipt(value: unknown): ProviderCapabilityReceipt | undefined {
  if (!isRecord(value) || value.schemaVersion !== "1" ||
    (value.status !== "ready" && value.status !== "unavailable") ||
    !nonEmptyString(value.catalogVersion) || !nonEmptyString(value.issuedAt) || !nonEmptyString(value.expiresAt) ||
    typeof value.trusted !== "boolean" || !Number.isFinite(Date.parse(value.issuedAt)) ||
    !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.issuedAt) > Date.parse(value.expiresAt)) return undefined;
  return Object.freeze({ schemaVersion: "1", status: value.status, catalogVersion: value.catalogVersion,
    issuedAt: value.issuedAt, expiresAt: value.expiresAt, trusted: value.trusted });
}

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
  const defaults = parseHistoricalOwnerSettings(value.defaults);
  if (!defaults.ok || !SPEED_PRESETS.includes(defaults.value.speedPreset)) return undefined;
  let providerReceipts: CapabilityReceipt["providerReceipts"];
  if (value.providerReceipts !== undefined) {
    if (!isRecord(value.providerReceipts) || Object.keys(value.providerReceipts).sort().join(",") !== "claude_code,codex") return undefined;
    const codex = parseProviderReceipt(value.providerReceipts.codex);
    const claude_code = parseProviderReceipt(value.providerReceipts.claude_code);
    if (codex === undefined || claude_code === undefined) return undefined;
    providerReceipts = Object.freeze({ codex, claude_code });
  }

  const receipt: CapabilityReceipt = Object.freeze({
    catalogVersion: value.catalogVersion,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    trusted: true,
    codexModels: Object.freeze(parsedCodexModels),
    claudeModels: Object.freeze(parsedClaudeModels),
    defaults: defaults.value,
    ...(providerReceipts === undefined ? {} : { providerReceipts })
  });
  // Catalog authenticity/freshness is independent from the default route.
  // A historical Claude default remains visible even when only Codex is ready.
  return validateCatalogTiming(receipt, now) === null ? receipt : undefined;
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
