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
import { createRuntimeBootstrap, type RuntimeBootstrap } from "./runtime-bootstrap.ts";

type SettingsAsset = "settings.css" | "settings.js";

export type GoDaddySettingsRuntime = Readonly<{
  configured: boolean;
  handle: (request: Request) => Promise<Response | undefined>;
}>;

export type GoDaddySettingsRuntimeDependencies = Readonly<{
  createPool?: (configuration: GodaddyDatabaseConfiguration) => MySqlPool;
  now?: () => Date;
  readAsset?: (asset: SettingsAsset) => Promise<Uint8Array>;
  createRuntimeBootstrap?: (input: Readonly<{
    environment: Record<string, unknown>;
    pool: MySqlPool;
    now: () => Date;
    initialCatalog?: CapabilityReceipt;
  }>) => RuntimeBootstrap;
}>;

const settingsPaths = new Set([
  "/settings",
  "/api/settings",
  "/api/settings/reset",
  "/api/settings/csrf",
  "/assets/settings.css",
  "/assets/settings.js"
]);

const runtimeOperationPaths = new Set([
  "/operations/runtime",
  "/operations/runtime/codex",
  "/operations/runtime/catalog"
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

function submittedHttpsOrigin(request: Request): string | undefined {
  const value = request.headers.get("origin");
  if (value === null || value.length === 0 || value.length > 255) return undefined;
  try {
    const origin = new URL(value);
    return origin.protocol === "https:" && origin.username.length === 0 && origin.password.length === 0 && origin.origin === value
      ? origin.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function isOwnerNavigation(request: Request, expectedOrigin: string): boolean {
  // Do not depend on proxy-controlled Host/X-Forwarded-Proto. The signed
  // session holds the browser origin selected at password sign-in, while
  // Fetch Metadata must independently identify the request as same-origin.
  return request.headers.get("sec-fetch-site") === "same-origin" && submittedHttpsOrigin(request) === expectedOrigin;
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

const isSettingsPath = (pathname: string): boolean => settingsPaths.has(pathname);
const isManagedPath = (pathname: string): boolean => isSettingsPath(pathname) || runtimeOperationPaths.has(pathname);

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

function operationDocument(input: Readonly<{
  codex: string;
  claude: string;
  catalogReady: boolean;
  deviceAuthorization?: Readonly<{ verificationUrl: string; userCode: string }>;
  catalogResult?: "updated" | "unavailable";
}>): string {
  const state = input.catalogReady ? "Каталог можливостей активний." : "Каталог можливостей ще не створено.";
  const device = input.deviceAuthorization === undefined ? "" : `
      <section>
        <h2>Вхід Codex</h2>
        <p>Відкрийте <a href="${input.deviceAuthorization.verificationUrl}" rel="noreferrer">сторінку авторизації OpenAI</a> і введіть цей одноразовий код:</p>
        <p><strong>${input.deviceAuthorization.userCode}</strong></p>
        <p>Після завершення поверніться сюди та оновіть сторінку. Код не зберігається у застосунку.</p>
      </section>`;
  const catalogResult = input.catalogResult === "updated"
    ? '<p role="status">Каталог можливостей оновлено.</p>'
    : input.catalogResult === "unavailable" ? '<p role="alert">Каталог не оновлено. Перевірте готовність обох підписок і повторіть дію.</p>' : "";
  return `<!doctype html>
<html lang="uk">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Підготовка runtime — Personal Consultant</title></head>
  <body>
    <main>
      <h1>Підготовка runtime</h1>
      <p>Codex: ${input.codex}. Claude Code: ${input.claude}.</p>
      <p>${state}</p>
      ${catalogResult}
      ${device}
      <form action="/operations/runtime/codex" method="post"><button type="submit">Почати вхід Codex</button></form>
      <form action="/operations/runtime/catalog" method="post"><button type="submit">Перевірити підписки й оновити каталог</button></form>
      ${input.catalogReady ? '<p><a href="/settings">Відкрити Налаштування власника</a></p>' : ""}
    </main>
  </body>
</html>`;
}

/**
 * The Node 22 runtime requires local owner access and an explicitly Published
 * MySQL state role before it exposes any management route.  Settings stay
 * fail-closed until an owner has created a current runtime capability receipt.
 * Preview stays stateless and cannot reach either boundary.
 */
export function createGoDaddySettingsRuntime(
  environment: Record<string, unknown>,
  dependencies: GoDaddySettingsRuntimeDependencies = {}
): GoDaddySettingsRuntime {
  const now = dependencies.now ?? (() => new Date());
  const database = parseGodaddyDatabaseConfiguration(environment);
  const ownerPassword = parseOwnerPasswordConfiguration(environment);
  const csrfSecret = asSecret(environment.SETTINGS_CSRF_HMAC_KEY);
  let receipt = capabilityReceiptFromEnvironment(environment, now());

  if (!database.ok || !ownerPassword.ok || csrfSecret === undefined) {
    return Object.freeze({
      configured: false,
      async handle(request: Request): Promise<Response | undefined> {
        return isManagedPath(new URL(request.url).pathname) || new URL(request.url).pathname.startsWith("/auth/")
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
  const runtime = (dependencies.createRuntimeBootstrap ?? createRuntimeBootstrap)({
    environment,
    pool,
    now,
    ...(receipt === undefined ? {} : { initialCatalog: receipt })
  });
  const loadReceipt = async (): Promise<CapabilityReceipt | undefined> => {
    const loaded = await runtime.loadCatalog();
    if (loaded !== undefined) receipt = loaded;
    return loaded;
  };
  const currentReceipt = (): CapabilityReceipt => {
    const parsed = receipt === undefined ? undefined : parseCapabilityReceipt(receipt, now());
    if (parsed === undefined) throw new Error("Runtime capability receipt is unavailable.");
    return parsed;
  };
  const ownerSettings = new OwnerSettingsDO({
    storage,
    getCapabilityReceipt: currentReceipt,
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
      getCapabilityReceipt: currentReceipt,
      csrf: createCsrfTokenService({ key, now }),
      csrfBinding: { principal: "owner", audience: "local-owner-password", origin: settingsOrigin },
      now
    });
  };

  return Object.freeze({
    configured: true,
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);

      if (url.pathname === "/auth/sign-in" && request.method === "GET") {
        const start = await owner.start();
        return html(loginDocument(start.formToken), 200, [start.setCookie]);
      }

      if (url.pathname === "/auth/sign-in") {
        if (request.method !== "POST") return plain("Method not allowed.", 405, { allow: "GET, POST" });
        const submittedOrigin = submittedHttpsOrigin(request);
        if (submittedOrigin === undefined || request.headers.get("sec-fetch-site") !== "same-origin") return plain("Access denied.", 403);
        const form = await parseLoginForm(request);
        const result = await owner.finish({
          cookieHeader: request.headers.get("cookie"),
          password: form?.password,
          requestOrigin: submittedOrigin,
          formToken: form?.formToken
        });
        if (result.ok) return redirect(receipt === undefined ? "/operations/runtime" : "/settings", [result.setCookie, result.clearCookie]);
        const retry = await owner.start();
        return html(loginDocument(retry.formToken, true), 403, [result.clearCookie, retry.setCookie]);
      }

      if (url.pathname === "/auth/sign-out") {
        if (request.method !== "POST") return plain("Method not allowed.", 405, { allow: "POST" });
        const ownerOrigin = await owner.getVerifiedOwnerOrigin(request.headers.get("cookie"));
        if (ownerOrigin === undefined || !isOwnerNavigation(request, ownerOrigin)) {
          return plain("Access denied.", 403);
        }
        return redirect("/auth/sign-in", [owner.signOutCookie()]);
      }

      if (!isManagedPath(url.pathname)) return undefined;
      const ownerOrigin = await owner.getVerifiedOwnerOrigin(request.headers.get("cookie"));
      if (ownerOrigin === undefined) {
        return url.pathname === "/settings" && request.method === "GET"
          ? redirect("/auth/sign-in", [])
          : plain("Access denied.", 403);
      }

      if (runtimeOperationPaths.has(url.pathname)) {
        if (url.pathname === "/operations/runtime" && request.method === "GET") {
          const [status, catalog] = await Promise.all([runtime.status(), loadReceipt()]);
          return html(operationDocument({ ...status, catalogReady: catalog !== undefined }), 200);
        }
        if ((url.pathname === "/operations/runtime/codex" || url.pathname === "/operations/runtime/catalog") && request.method === "POST") {
          if (!isOwnerNavigation(request, ownerOrigin)) return plain("Access denied.", 403);
          const [status, catalog] = await Promise.all([runtime.status(), loadReceipt()]);
          if (url.pathname === "/operations/runtime/codex") {
            const deviceAuthorization = await runtime.startCodexDeviceAuthorization();
            return html(operationDocument({ ...status, catalogReady: catalog !== undefined, ...(deviceAuthorization === undefined ? {} : { deviceAuthorization }) }), deviceAuthorization === undefined ? 503 : 200);
          }
          const refreshed = await runtime.refreshCatalog();
          if (refreshed.ok) receipt = refreshed.receipt;
          return html(operationDocument({
            ...status,
            catalogReady: refreshed.ok || catalog !== undefined,
            catalogResult: refreshed.ok ? "updated" : "unavailable"
          }), refreshed.ok ? 200 : 503);
        }
        return plain("Method not allowed.", 405, { allow: url.pathname === "/operations/runtime" ? "GET" : "POST" });
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

      if (await loadReceipt() === undefined) return plain("Settings are temporarily unavailable.", 503);
      const verifiedGateway = await gateway(ownerOrigin);
      return verifiedGateway === undefined
        ? plain("Settings are temporarily unavailable.", 503)
        : verifiedGateway.handle(request);
    }
  });
}
