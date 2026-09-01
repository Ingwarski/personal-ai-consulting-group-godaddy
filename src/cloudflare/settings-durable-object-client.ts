import type { OwnerSettingsService, SettingsReadModel, SettingsWriteResult } from "../settings/owner-settings-do.ts";
import { capabilityReceiptHeaderName, encodeCapabilityReceipt } from "../settings/capability-receipt.ts";
import type { CapabilityReceipt } from "../settings/types.ts";

export type InternalSettingsFetcher = Readonly<{
  fetch: (request: Request) => Promise<Response>;
}>;

const internalUrl = (path: string): string => `https://owner-settings.internal${path}`;

const jsonRequest = (path: string, method: string, receipt: CapabilityReceipt, body?: unknown): Request =>
  new Request(internalUrl(path), {
    method,
    headers: {
      "content-type": "application/json",
      "x-owner-settings-internal": "v1",
      [capabilityReceiptHeaderName()]: encodeCapabilityReceipt(receipt)
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error("Owner settings Durable Object is unavailable.");
  return response.json() as Promise<T>;
}

/** Trusted Worker-to-DO adapter. It never receives a browser-provided receipt. */
export class SettingsDurableObjectClient implements OwnerSettingsService {
  readonly #fetcher: InternalSettingsFetcher;
  readonly #receipt: CapabilityReceipt;

  constructor(input: Readonly<{ fetcher: InternalSettingsFetcher; receipt: CapabilityReceipt }>) {
    this.#fetcher = input.fetcher;
    this.#receipt = input.receipt;
  }

  async initialize(): Promise<SettingsWriteResult> {
    return readJson(await this.#fetcher.fetch(jsonRequest("/internal/initialize", "POST", this.#receipt)));
  }

  async read(): Promise<SettingsReadModel | undefined> {
    const response = await this.#fetcher.fetch(jsonRequest("/internal/read", "GET", this.#receipt));
    if (response.status === 404) return undefined;
    return readJson<SettingsReadModel>(response);
  }

  async save(settings: unknown, ifMatch: string | undefined, idempotencyKey: string | undefined): Promise<SettingsWriteResult> {
    return readJson(await this.#fetcher.fetch(jsonRequest("/internal/save", "PUT", this.#receipt, {
      settings,
      ifMatch,
      idempotencyKey
    })));
  }

  async reset(ifMatch: string | undefined, idempotencyKey: string | undefined): Promise<SettingsWriteResult> {
    return readJson(await this.#fetcher.fetch(jsonRequest("/internal/reset", "POST", this.#receipt, {
      ifMatch,
      idempotencyKey
    })));
  }
}
