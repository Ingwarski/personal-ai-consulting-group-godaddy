import { decodeCapabilityReceipt } from "../settings/capability-receipt.ts";
import { OwnerSettingsDO, type SettingsWriteResult } from "../settings/owner-settings-do.ts";
import { DurableObjectKeyValueStorage } from "./durable-object-storage.ts";

type MutationBody = Readonly<{
  settings?: unknown;
  ifMatch?: unknown;
  idempotencyKey?: unknown;
}>;

const internalMarker = (request: Request): boolean =>
  request.headers.get("x-owner-settings-internal") === "v1";

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" }
});

async function requestBody(request: Request): Promise<MutationBody | undefined> {
  try {
    const parsed: unknown = await request.json();
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as MutationBody : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One non-public Durable Object instance owns revisioned settings. The Worker
 * validates Access and CSRF before it calls this class; the object separately
 * refuses any request without the private service-boundary marker and a fresh
 * typed receipt. OAuth data is neither accepted nor stored here.
 */
export class OwnerSettingsDurableObject {
  readonly #storage: DurableObjectKeyValueStorage;

  constructor(state: DurableObjectState) {
    this.#storage = new DurableObjectKeyValueStorage(state.storage);
  }

  async fetch(request: Request): Promise<Response> {
    if (!internalMarker(request)) return json({ error: "forbidden" }, 403);
    const now = new Date();
    const receipt = decodeCapabilityReceipt(request.headers.get("x-settings-capability-receipt"), now);
    if (receipt === undefined) return json({ error: "capability_receipt_unavailable" }, 503);

    const ownerSettings = new OwnerSettingsDO({
      storage: this.#storage,
      getCapabilityReceipt: () => receipt,
      now: () => now
    });
    const path = new URL(request.url).pathname;
    if (path === "/internal/initialize" && request.method === "POST") {
      return json(await ownerSettings.initialize());
    }
    if (path === "/internal/read" && request.method === "GET") {
      const read = await ownerSettings.read();
      return read === undefined ? json({ error: "not_initialized" }, 404) : json(read);
    }

    const body = await requestBody(request);
    if (body === undefined) return json({ error: "invalid_json" }, 400);
    const ifMatch = asOptionalString(body.ifMatch);
    const idempotencyKey = asOptionalString(body.idempotencyKey);
    let result: SettingsWriteResult | undefined;
    if (path === "/internal/save" && request.method === "PUT") {
      result = await ownerSettings.save(body.settings, ifMatch, idempotencyKey);
    }
    if (path === "/internal/reset" && request.method === "POST") {
      result = await ownerSettings.reset(ifMatch, idempotencyKey);
    }
    return result === undefined ? json({ error: "not_found" }, 404) : json(result);
  }
}
