import { CloudflareAccessJwtValidator, createCloudflareAccessJwksProvider } from "./access/cloudflare-access-jwt.ts";
import { createCsrfTokenService, importCsrfHmacKey } from "./access/csrf.ts";
import { parseSettingsAccessConfiguration } from "./access/settings-access-config.ts";
import { SettingsDurableObjectClient, type InternalSettingsFetcher } from "./cloudflare/settings-durable-object-client.ts";
import { secureResponse, securityHeaders } from "./http/security-headers.ts";
import { parseRuntimeEnvironment } from "./runtime/environment.ts";
import { parseCapabilityReceipt } from "./settings/capability-receipt.ts";
import { createVerifiedSettingsGateway } from "./settings/gateway.ts";

type AssetBinding = Readonly<{
  fetch: (request: Request) => Promise<Response>;
}>;

type DurableObjectNamespaceBinding = Readonly<{
  idFromName: (name: string) => DurableObjectId;
  get: (id: DurableObjectId) => InternalSettingsFetcher;
}>;

type WorkerBindings = Record<string, unknown> & Readonly<{
  ASSETS?: AssetBinding;
  OWNER_SETTINGS?: DurableObjectNamespaceBinding;
  CAPABILITY_CATALOG?: AssetBinding;
  SETTINGS_CSRF_HMAC_KEY?: string;
}>;

export type WorkerDependencies = Readonly<{
  createJwksProvider?: (issuer: string) => ReturnType<typeof createCloudflareAccessJwksProvider>;
  now?: () => Date;
}>;

const protectedPath = (pathname: string): boolean =>
  pathname === "/settings" ||
    pathname === "/api/settings" ||
    pathname === "/api/settings/reset" ||
    pathname === "/api/settings/csrf" ||
    pathname === "/assets/settings.css" ||
    pathname === "/assets/settings.js";

const privateResponse = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: securityHeaders({ "content-type": "text/plain; charset=utf-8" })
  });

const isAssetBinding = (value: unknown): value is AssetBinding =>
  typeof value === "object" && value !== null && typeof (value as AssetBinding).fetch === "function";

const isDurableObjectNamespace = (value: unknown): value is DurableObjectNamespaceBinding =>
  typeof value === "object" && value !== null &&
  typeof (value as DurableObjectNamespaceBinding).idFromName === "function" &&
  typeof (value as DurableObjectNamespaceBinding).get === "function";

async function freshCapabilityReceipt(binding: AssetBinding, now: Date) {
  try {
    const response = await binding.fetch(new Request("https://capability-catalog.internal/v1/settings-capability-receipt", {
      headers: { accept: "application/json" }
    }));
    if (!response.ok) return undefined;
    return parseCapabilityReceipt(await response.json(), now);
  } catch {
    return undefined;
  }
}

export function createWorker(dependencies: WorkerDependencies = {}) {
  const createJwksProvider = dependencies.createJwksProvider ?? createCloudflareAccessJwksProvider;
  const now = dependencies.now ?? (() => new Date());

  return {
    async fetch(request: Request, environment: WorkerBindings): Promise<Response> {
      const parsedEnvironment = parseRuntimeEnvironment(environment);
      if (!parsedEnvironment.ok) return privateResponse("Runtime configuration is unavailable.", 503);

      const url = new URL(request.url);
      if (!protectedPath(url.pathname)) return privateResponse("Not found.", 404);

      const accessConfiguration = parseSettingsAccessConfiguration(environment);
      if (!accessConfiguration.ok) return privateResponse("Settings are temporarily unavailable.", 503);
      if (url.origin !== accessConfiguration.value.settingsOrigin) return privateResponse("Access denied.", 403);

      const validator = new CloudflareAccessJwtValidator({
        ...accessConfiguration.value,
        jwks: createJwksProvider(accessConfiguration.value.issuer),
        now
      });
      if (await validator.verifyRequest(request) === undefined) return privateResponse("Access denied.", 403);

      if (url.pathname === "/assets/settings.css" || url.pathname === "/assets/settings.js") {
        if (!isAssetBinding(environment.ASSETS)) return privateResponse("Settings are temporarily unavailable.", 503);
        const asset = await environment.ASSETS.fetch(request);
        return secureResponse(asset);
      }

      if (!isAssetBinding(environment.CAPABILITY_CATALOG) || !isDurableObjectNamespace(environment.OWNER_SETTINGS) ||
        typeof environment.SETTINGS_CSRF_HMAC_KEY !== "string") {
        return privateResponse("Settings are temporarily unavailable.", 503);
      }
      const receipt = await freshCapabilityReceipt(environment.CAPABILITY_CATALOG, now());
      const csrfKey = await importCsrfHmacKey(environment.SETTINGS_CSRF_HMAC_KEY);
      if (receipt === undefined || csrfKey === undefined) return privateResponse("Settings are temporarily unavailable.", 503);

      const ownerSettings = new SettingsDurableObjectClient({
        fetcher: environment.OWNER_SETTINGS.get(environment.OWNER_SETTINGS.idFromName("single-owner-settings-v1")),
        receipt
      });
      return createVerifiedSettingsGateway({
        ownerSettings,
        getCapabilityReceipt: () => receipt,
        csrf: createCsrfTokenService({ key: csrfKey, now }),
        csrfBinding: {
          principal: "owner",
          audience: accessConfiguration.value.audience,
          origin: accessConfiguration.value.settingsOrigin
        },
        now
      }).handle(request);
    }
  };
}

export default createWorker();
export { OwnerSettingsDurableObject } from "./cloudflare/owner-settings-durable-object.ts";
