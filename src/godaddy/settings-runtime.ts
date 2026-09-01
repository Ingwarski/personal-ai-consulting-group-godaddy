import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPool } from "mysql2/promise";

import { createCsrfTokenService, importCsrfHmacKey } from "../access/csrf.ts";
import { securityHeaders } from "../http/security-headers.ts";
import { parseCapabilityReceipt } from "../settings/capability-receipt.ts";
import { createVerifiedSettingsGateway, type VerifiedSettingsGateway } from "../settings/gateway.ts";
import { OwnerSettingsDO } from "../settings/owner-settings-do.ts";
import type { CapabilityReceipt } from "../settings/types.ts";
import { createGoogleOidcService, parseGoogleOidcConfiguration } from "./google-oidc.ts";
import {
  MySqlKeyValueStorage,
  parseGodaddyDatabaseConfiguration,
  type GodaddyDatabaseConfiguration,
  type MySqlPool
} from "./mysql-storage.ts";
import { createGoDaddyRegistrarRuntime } from "./registrar-runtime.ts";

type SettingsAsset = "settings.css" | "settings.js";

export type GoDaddySettingsRuntime = Readonly<{
  configured: boolean;
  handle: (request: Request) => Promise<Response | undefined>;
}>;

export type GoDaddySettingsRuntimeDependencies = Readonly<{
  createPool?: (configuration: GodaddyDatabaseConfiguration) => MySqlPool;
  now?: () => Date;
  readAsset?: (asset: SettingsAsset) => Promise<Uint8Array>;
}>;

const protectedPaths = new Set([
  "/settings",
  "/api/settings",
  "/api/settings/reset",
  "/api/settings/csrf",
  "/assets/settings.css",
  "/assets/settings.js"
]);

const assetByPath: Readonly<Record<string, SettingsAsset>> = Object.freeze({
  "/assets/settings.css": "settings.css",
  "/assets/settings.js": "settings.js"
});

const runtimeAssetDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "assets");

const plain = (body: string, status: number, headers: HeadersInit = {}): Response =>
  new Response(body, {
    status,
    headers: securityHeaders(new Headers({ "content-type": "text/plain; charset=utf-8", ...headers }))
  });

const redirect = (location: string, cookies: readonly string[]): Response => {
  const headers = securityHeaders(new Headers({ location }));
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
};

const assetResponse = (body: Uint8Array, asset: SettingsAsset): Response =>
  new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, {
    status: 200,
    headers: securityHeaders(new Headers({
      "content-type": asset === "settings.css" ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8"
    }))
  });

const asSecret = (value: unknown): string | undefined =>
  typeof value === "string" && value.length >= 32 && value.length <= 4_096 ? value : undefined;

function capabilityReceiptFromEnvironment(environment: Record<string, unknown>, now: Date): CapabilityReceipt | undefined {
  const raw = environment.CAPABILITY_CATALOG_JSON;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 16_384) return undefined;
  try {
    return parseCapabilityReceipt(JSON.parse(raw), now);
  } catch {
    return undefined;
  }
}

function requestOrigin(request: Request): string | undefined {
  const host = request.headers.get("host");
  if (host === null || host.length === 0 || host.length > 255 || /[\s/\\@]/u.test(host)) return undefined;
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? forwardedProtocol : "https";
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return undefined;
  }
}

function isSameOriginNavigation(request: Request, expectedOrigin: string): boolean {
  return requestOrigin(request) === expectedOrigin &&
    request.headers.get("origin") === expectedOrigin &&
    request.headers.get("sec-fetch-site") === "same-origin";
}

const isProtectedPath = (pathname: string): boolean => protectedPaths.has(pathname);

function defaultPool(configuration: GodaddyDatabaseConfiguration): MySqlPool {
  return createPool({
    host: configuration.host,
    port: configuration.port,
    database: configuration.database,
    user: configuration.user,
    password: configuration.password,
    waitForConnections: true,
    connectionLimit: 4,
    queueLimit: 0,
    enableKeepAlive: true
  }) as unknown as MySqlPool;
}

const defaultReadAsset = (asset: SettingsAsset): Promise<Uint8Array> =>
  readFile(resolve(runtimeAssetDirectory, asset));

/**
 * The Node 22 Settings slice intentionally requires three independently
 * configured boundaries: Google identity, a current capability receipt, and
 * an explicitly Published MySQL state role. Preview therefore stays
 * stateless while it validates the deployable process.
 */
export function createGoDaddySettingsRuntime(
  environment: Record<string, unknown>,
  dependencies: GoDaddySettingsRuntimeDependencies = {}
): GoDaddySettingsRuntime {
  const now = dependencies.now ?? (() => new Date());
  const database = parseGodaddyDatabaseConfiguration(environment);
  const oidc = parseGoogleOidcConfiguration(environment);
  const csrfSecret = asSecret(environment.SETTINGS_CSRF_HMAC_KEY);
  const receipt = capabilityReceiptFromEnvironment(environment, now());

  if (!database.ok || !oidc.ok || csrfSecret === undefined || receipt === undefined) {
    return Object.freeze({
      configured: false,
      async handle(request: Request): Promise<Response | undefined> {
        return isProtectedPath(new URL(request.url).pathname) || new URL(request.url).pathname.startsWith("/auth/google/")
          ? plain("Settings are temporarily unavailable.", 503)
          : undefined;
      }
    });
  }

  const settingsOrigin = new URL(oidc.value.redirectUri).origin;
  const google = createGoogleOidcService({ configuration: oidc.value, now });
  const pool = (dependencies.createPool ?? defaultPool)(database.value);
  const storage = new MySqlKeyValueStorage({
    executor: pool,
    namespace: "owner-settings-v1"
  });
  const registrar = createGoDaddyRegistrarRuntime({ pool, now });
  const ownerSettings = new OwnerSettingsDO({
    storage,
    getCapabilityReceipt: () => receipt,
    getActiveSessionSummary: registrar.getActiveSessionSummary,
    now
  });
  const csrfKey = importCsrfHmacKey(csrfSecret);
  const readAsset = dependencies.readAsset ?? defaultReadAsset;

  const gateway = async (): Promise<VerifiedSettingsGateway | undefined> => {
    const key = await csrfKey;
    if (key === undefined) return undefined;
    return createVerifiedSettingsGateway({
      ownerSettings,
      getCapabilityReceipt: () => receipt,
      csrf: createCsrfTokenService({ key, now }),
      csrfBinding: { principal: "owner", audience: "google-owner", origin: settingsOrigin },
      now
    });
  };

  return Object.freeze({
    configured: true,
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      const origin = requestOrigin(request);

      if (url.pathname === "/auth/google/start") {
        if (request.method !== "GET" || origin === undefined) return plain("Access denied.", 403);
        const start = await google.start(origin);
        return start === undefined ? plain("Access denied.", 403) : redirect(start.authorizationUrl, [start.setCookie]);
      }

      if (url.pathname === "/auth/google/callback") {
        if (request.method !== "GET" || origin === undefined) return plain("Access denied.", 403);
        const result = await google.finish({
          cookieHeader: request.headers.get("cookie"),
          code: url.searchParams.get("code"),
          requestOrigin: origin,
          state: url.searchParams.get("state")
        });
        return result.ok
          ? redirect("/settings", [result.setCookie, result.clearCookie])
          : plain("Access denied.", 403, { "set-cookie": result.clearCookie });
      }

      if (url.pathname === "/auth/sign-out") {
        if (request.method !== "POST") return plain("Method not allowed.", 405, { allow: "POST" });
        if (!isSameOriginNavigation(request, settingsOrigin) || !await google.hasVerifiedOwner(request.headers.get("cookie"))) {
          return plain("Access denied.", 403);
        }
        return redirect("/settings", [google.signOutCookie()]);
      }

      if (!isProtectedPath(url.pathname)) return undefined;
      if (!await google.hasVerifiedOwner(request.headers.get("cookie"))) {
        return url.pathname === "/settings" && request.method === "GET"
          ? redirect("/auth/google/start", [])
          : plain("Access denied.", 403);
      }

      const asset = assetByPath[url.pathname];
      if (asset !== undefined) {
        if (request.method !== "GET") return plain("Method not allowed.", 405, { allow: "GET" });
        try {
          return assetResponse(await readAsset(asset), asset);
        } catch {
          return plain("Settings are temporarily unavailable.", 503);
        }
      }

      const verifiedGateway = await gateway();
      return verifiedGateway === undefined
        ? plain("Settings are temporarily unavailable.", 503)
        : verifiedGateway.handle(request);
    }
  });
}
