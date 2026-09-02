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
import { createOwnerPasswordService, parseOwnerPasswordConfiguration } from "./owner-password-auth.ts";
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

const html = (body: string, status: number, cookies: readonly string[] = []): Response => {
  const headers = securityHeaders(new Headers({ "content-type": "text/html; charset=utf-8" }));
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(body, { status, headers });
};

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

async function parseLoginForm(request: Request): Promise<Readonly<{ formToken: string; password: string }> | undefined> {
  const contentType = request.headers.get("content-type");
  const contentLength = request.headers.get("content-length");
  if (contentType === null || !contentType.startsWith("application/x-www-form-urlencoded") || contentLength === null || !/^[1-9][0-9]{0,4}$/u.test(contentLength)) {
    return undefined;
  }
  if (Number(contentLength) > 4_096) return undefined;
  const body = await request.text();
  if (body.length > 4_096) return undefined;
  const form = new URLSearchParams(body);
  const formTokens = form.getAll("formToken");
  const passwords = form.getAll("password");
  if (formTokens.length !== 1 || passwords.length !== 1) return undefined;
  const [formToken] = formTokens;
  const [password] = passwords;
  if (
    formToken === undefined || password === undefined ||
    !/^[A-Za-z0-9_-]{32,255}$/u.test(formToken) || password.length > 4_096
  ) return undefined;
  return Object.freeze({ formToken, password });
}

const loginDocument = (formToken: string, denied = false): string => `<!doctype html>
<html lang="uk">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Вхід власника — Personal Consultant</title>
  </head>
  <body>
    <main>
      <h1>Налаштування власника</h1>
      <p>Введіть ключ входу, збережений лише у GoDaddy Publish Secrets.</p>
      ${denied ? '<p role="alert">Доступ відхилено.</p>' : ""}
      <form action="/auth/sign-in" method="post">
        <input type="hidden" name="formToken" value="${formToken}" />
        <label>Ключ входу <input name="password" type="password" autocomplete="current-password" minlength="32" maxlength="4096" required autofocus /></label>
        <button type="submit">Увійти</button>
      </form>
    </main>
  </body>
</html>`;

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
 * configured boundaries: a local owner secret, a current capability receipt,
 * and an explicitly Published MySQL state role. Preview therefore stays
 * stateless while it validates the deployable process.
 */
export function createGoDaddySettingsRuntime(
  environment: Record<string, unknown>,
  dependencies: GoDaddySettingsRuntimeDependencies = {}
): GoDaddySettingsRuntime {
  const now = dependencies.now ?? (() => new Date());
  const database = parseGodaddyDatabaseConfiguration(environment);
  const ownerPassword = parseOwnerPasswordConfiguration(environment);
  const csrfSecret = asSecret(environment.SETTINGS_CSRF_HMAC_KEY);
  const receipt = capabilityReceiptFromEnvironment(environment, now());

  if (!database.ok || !ownerPassword.ok || csrfSecret === undefined || receipt === undefined) {
    return Object.freeze({
      configured: false,
      async handle(request: Request): Promise<Response | undefined> {
        return isProtectedPath(new URL(request.url).pathname) || new URL(request.url).pathname.startsWith("/auth/")
          ? plain("Settings are temporarily unavailable.", 503)
          : undefined;
      }
    });
  }

  const owner = createOwnerPasswordService({ configuration: ownerPassword.value, now });
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

  const gateway = async (settingsOrigin: string): Promise<VerifiedSettingsGateway | undefined> => {
    const key = await csrfKey;
    if (key === undefined) return undefined;
    return createVerifiedSettingsGateway({
      ownerSettings,
      getCapabilityReceipt: () => receipt,
      csrf: createCsrfTokenService({ key, now }),
      csrfBinding: { principal: "owner", audience: "local-owner-password", origin: settingsOrigin },
      now
    });
  };

  return Object.freeze({
    configured: true,
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      const origin = requestOrigin(request);

      if (url.pathname === "/auth/sign-in" && request.method === "GET") {
        if (origin === undefined) return plain("Access denied.", 403);
        const start = await owner.start(origin);
        return start === undefined
          ? plain("Access denied.", 403)
          : html(loginDocument(start.formToken), 200, [start.setCookie]);
      }

      if (url.pathname === "/auth/sign-in") {
        if (request.method !== "POST") return plain("Method not allowed.", 405, { allow: "GET, POST" });
        if (origin === undefined || !isSameOriginNavigation(request, origin)) return plain("Access denied.", 403);
        const form = await parseLoginForm(request);
        const result = await owner.finish({
          cookieHeader: request.headers.get("cookie"),
          password: form?.password,
          requestOrigin: origin,
          formToken: form?.formToken
        });
        if (result.ok) return redirect("/settings", [result.setCookie, result.clearCookie]);
        const retry = await owner.start(origin);
        return retry === undefined
          ? plain("Access denied.", 403)
          : html(loginDocument(retry.formToken, true), 403, [retry.setCookie, result.clearCookie]);
      }

      if (url.pathname === "/auth/sign-out") {
        if (request.method !== "POST") return plain("Method not allowed.", 405, { allow: "POST" });
        if (origin === undefined || !isSameOriginNavigation(request, origin) || !await owner.hasVerifiedOwner(request.headers.get("cookie"))) {
          return plain("Access denied.", 403);
        }
        return redirect("/auth/sign-in", [owner.signOutCookie()]);
      }

      if (!isProtectedPath(url.pathname)) return undefined;
      if (origin === undefined) return plain("Access denied.", 403);
      if (!await owner.hasVerifiedOwner(request.headers.get("cookie"))) {
        return url.pathname === "/settings" && request.method === "GET"
          ? redirect("/auth/sign-in", [])
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

      const verifiedGateway = await gateway(origin);
      return verifiedGateway === undefined
        ? plain("Settings are temporarily unavailable.", 503)
        : verifiedGateway.handle(request);
    }
  });
}
