import { createGoDaddyConsiliumRuntime, type GoDaddyConsiliumRuntime } from "./consilium-runtime.ts";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCsrfTokenService, importCsrfHmacKey } from "../access/csrf.ts";
import { securityHeaders } from "../http/security-headers.ts";
import { parseCapabilityReceipt } from "../settings/capability-receipt.ts";
import { createVerifiedSettingsGateway, type VerifiedSettingsGateway } from "../settings/gateway.ts";
import { OwnerSettingsDO, readCompatibleSettingsDocument } from "../settings/owner-settings-do.ts";
import type { CapabilityReceipt } from "../settings/types.ts";
import { parseRuntimeEnvironment } from "../runtime/environment.ts";
import type { RuntimeCapabilityCatalogResult } from "../runtime/capability-catalog.ts";
import { createOwnerGoogleService, parseOwnerGoogleConfiguration } from "./owner-google-auth.ts";
import type { GoogleIdentityProvider } from "./google-identity-provider.ts";
import { ownerAuthClientJavaScript, OWNER_AUTH_SCRIPT_PATH, isOwnerAuthScriptPath } from "./owner-auth-client.ts";
import {
  MySqlKeyValueStorage,
  parseGodaddyDatabaseConfiguration,
  type GodaddyDatabaseConfiguration,
  type MySqlPool
} from "./mysql-storage.ts";
import { createGodaddyMySqlPool } from "./mysql-pool.ts";
import { createGoDaddyRegistrarRuntime, type GoDaddyRegistrarRuntime } from "./registrar-runtime.ts";
import { createRuntimeBootstrap, type RuntimeBootstrap } from "./runtime-bootstrap.ts";
import { createMatrixSetupOperations, type MatrixSetupOperations } from "./matrix-setup-operations.ts";
import { MATRIX_SETUP_ACTION, MATRIX_SETUP_ACTIONS, MATRIX_SETUP_PAGE, matrixSetupDocument, type MatrixSetupAction } from "./matrix-setup-page.ts";
import { matrixPreviewVerifierResponse } from "./matrix-browser-isolation.ts";
import { matrixPositiveControlResponse } from "./matrix-positive-control.ts";

type SettingsAsset = "settings.css" | "settings.js";
type CatalogFailureCode = Extract<RuntimeCapabilityCatalogResult, { ok: false }>["code"];
const catalogFailureMessages: Readonly<Record<CatalogFailureCode, string>> = Object.freeze({
  codex_not_ready: "Codex не підтвердив готовність підписки. Перевірте його стан і повторіть перевірку.",
  claude_not_ready: "Claude Code не підтвердив вхід через підписку. Вхід Codex змінювати не потрібно.",
  private_boundary_failed: "Не підтверджено ізоляцію приватних підписок. Потрібна перевірка конфігурації застосунку.",
  claude_paid_acceleration_forbidden: "Claude Code повідомив про платний режим, заборонений налаштуваннями застосунку.",
  invalid_models: "Провайдер повернув несумісний список моделей. Потрібна перевірка відповіді runtime.",
  invalid_defaults: "Не вдалося сформувати сумісні початкові налаштування з підтверджених моделей.",
  claude_auth_rejected: "Claude Code відхилив авторизацію підписки під час перевірки моделей. Вхід Codex змінювати не потрібно.",
  claude_access_denied: "Сервіс Claude відхилив запит із сервера: HTTP 403. Потрібно перевірити дозволи облікового запису Claude, токен або доступ із мережі хостингу. Ця помилка не визначає точну причину. Вхід Google і Codex змінювати не потрібно.",
  claude_quota_blocked: "Під час перевірки моделей Claude Code повідомив про ліміт використання. Повторіть після його поновлення.",
  claude_cli_incompatible: "Встановлена версія Claude Code не підтримує команду перевірки моделей. Потрібне виправлення розгортання, не повторний вхід Codex.",
  claude_process_failed: "Команда перевірки моделей Claude Code завершилася помилкою. Потрібна перевірка запуску Claude Code на сервері.",
  claude_invalid_response: "Claude Code не повернув коректної успішної відповіді на перевірку моделей.",
  claude_models_unavailable: "Claude Code не підтвердив жодної з налаштованих моделей для цієї підписки.",
  catalog_storage_failed: "Моделі перевірено, але каталог не вдалося зберегти в базі даних. Повторіть збереження без очищення входу.",
  catalog_refresh_failed: "Перевірка каталогу перервалася через внутрішню помилку. Потрібна перевірка runtime на сервері."
});

export type GoDaddySettingsRuntime = Readonly<{
  configured: boolean;
  consilium?: GoDaddyConsiliumRuntime;
  prepareConsultationSnapshot?: (sessionId: string) => Promise<import("../settings/types.ts").EffectiveSessionSnapshot | undefined>;
  handle: (request: Request) => Promise<Response | undefined>;
  close: () => Promise<void>;
}>;

export type GoDaddySettingsRuntimeDependencies = Readonly<{
  matrixDiagnostics?: () => Readonly<{
    configured: boolean; ready: boolean; reason: string;
    consultationWorking: boolean; consultationBlocked: boolean;
  }>;
  /** A process-owned pool supplied by the application composition root. */
  pool?: MySqlPool;
  createPool?: (configuration: GodaddyDatabaseConfiguration) => MySqlPool;
  now?: () => Date;
  readAsset?: (asset: SettingsAsset) => Promise<Uint8Array>;
  createRuntimeBootstrap?: (input: Readonly<{
    environment: Record<string, unknown>;
    pool: MySqlPool;
    now: () => Date;
    initialCatalog?: CapabilityReceipt;
  }>) => RuntimeBootstrap;
  registrarRuntime?: GoDaddyRegistrarRuntime;
  googleIdentityProvider?: GoogleIdentityProvider;
  matrixSetupOperations?: MatrixSetupOperations;
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
  "/operations/runtime/codex/reconnect",
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

const json = (body: unknown, status = 200, cookies: readonly string[] = [], extra: HeadersInit = {}): Response => {
  const headers = securityHeaders(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
};

const redirect = (location: string, cookies: readonly string[], extra: HeadersInit = {}): Response => {
  const headers = securityHeaders(extra);
  headers.set("location", location);
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

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

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
  // Public origin is protected configuration, never proxy-controlled Host or
  // an arbitrary origin selected by a login request.
  return request.headers.get("sec-fetch-site") === "same-origin" && submittedHttpsOrigin(request) === expectedOrigin;
}

async function parseActionForm(request: Request, extraFields: readonly string[] = []): Promise<Readonly<{ formToken: string; fields: Readonly<Record<string, string>> }> | undefined> {
  const contentType = request.headers.get("content-type");
  const contentLength = request.headers.get("content-length");
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/iu.test(contentType ?? "") ||
      (contentLength !== null && (!/^[1-9][0-9]{0,4}$/u.test(contentLength) || Number(contentLength) > 4_096))) {
    return undefined;
  }
  const reader = request.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 4_096) { await reader.cancel(); return undefined; }
      chunks.push(part.value);
    }
  } catch { return undefined; }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: string;
  try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
  const form = new URLSearchParams(body);
  const formTokens = form.getAll("formToken");
  if (formTokens.length !== 1 || [...form.keys()].some((key) => key !== "formToken" && !extraFields.includes(key))) return undefined;
  const fields: Record<string, string> = {};
  for (const key of extraFields) {
    const values = form.getAll(key);
    if (values.length > 1 || (values.length === 1 && (!values[0] || Buffer.byteLength(values[0]) > (key === "previewReport" ? 2000 : 255) || /[\u0000-\u001f\u007f]/u.test(values[0])))) return undefined;
    if (values[0] !== undefined) fields[key] = values[0];
  }
  const [formToken] = formTokens;
  if (formToken === undefined || !/^[A-Za-z0-9_.-]{32,2048}$/u.test(formToken)) return undefined;
  return Object.freeze({ formToken, fields: Object.freeze(fields) });
}

const loginDocument = (formToken: string, denied = false, rateLimited = false): string => `<!doctype html>
<html lang="uk">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Вхід власника — Personal Consultant</title>
    <script src="${OWNER_AUTH_SCRIPT_PATH}" defer></script>
  </head>
  <body>
    <main>
      <h1>Налаштування власника</h1>
      <p>Увійдіть через Google з дозволеним обліковим записом власника.</p>
      ${rateLimited ? '<p role="alert">Забагато спроб входу. Зачекайте хвилину, оновіть сторінку та спробуйте знову.</p>' : denied ? '<p role="alert">Вхід не завершено або доступ не дозволено. Спробуйте знову з обліковим записом власника.</p>' : ""}
      <p role="alert" tabindex="-1" data-owner-action-status></p>
      <form action="/auth/google/start" method="post" data-owner-action>
        <input type="hidden" name="formToken" value="${escapeHtml(formToken)}" />
        <button type="submit">Увійти через Google</button>
      </form>
      <noscript>Для захищеного входу увімкніть JavaScript і оновіть сторінку.</noscript>
    </main>
  </body>
</html>`;

async function isEmptyJsonAction(request: Request): Promise<boolean> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("content-type") ?? "")) return false;
  const length = request.headers.get("content-length");
  if (length !== null && length !== "2") return false;
  const reader = request.body?.getReader();
  if (!reader) return false;
  let body = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (body.length + part.value.byteLength > 2) { await reader.cancel(); return false; }
      body += new TextDecoder("utf-8", { fatal: true }).decode(part.value);
    }
    return body === "{}";
  } catch { return false; }
}

const isSettingsPath = (pathname: string): boolean => settingsPaths.has(pathname);
const MATRIX_STATUS_PATH = "/operations/matrix/status";
const MATRIX_STATUS_REASONS = new Set([
  "matrix_disabled_for_runtime", "matrix_state_database_not_enabled", "matrix_not_configured",
  "matrix_configuration_incomplete", "matrix_configuration_invalid", "store_binding_unavailable", "store_binding_invalid",
  "not_started", "starting", "ready", "database_unavailable", "schema_unavailable", "outbox_blocked",
  "ingress_blocked", "media_consumer_unavailable", "sidecar_not_ready", "lock_contended", "circuit_open",
  "retry_exhausted", "publication_fence_unavailable", "stopping", "stopped", "termination_failed"
]);
const isManagedPath = (pathname: string): boolean => isSettingsPath(pathname) || runtimeOperationPaths.has(pathname) || pathname === MATRIX_SETUP_PAGE || pathname === MATRIX_SETUP_ACTION || pathname === MATRIX_STATUS_PATH;

function defaultPool(configuration: GodaddyDatabaseConfiguration): MySqlPool {
  return createGodaddyMySqlPool(configuration);
}

const defaultReadAsset = (asset: SettingsAsset): Promise<Uint8Array> =>
  readFile(resolve(runtimeAssetDirectory, asset));

function operationDocument(input: Readonly<{
  codex: string;
  codexPlanType?: string;
  claude: string;
  catalogReady: boolean;
  deviceAuthorization?: Readonly<{ verificationUrl: string; userCode: string }>;
  deviceAuthorizationFailed?: boolean;
  codexResetResult?: "cleared" | "failed";
  catalogResult?: "updated" | "unavailable";
  catalogFailure?: CatalogFailureCode;
  actionTokens: Readonly<Record<string, string>>;
}>): string {
  const form = (path: string, label: string): string => `<form action="${path}" method="post" data-owner-action><input type="hidden" name="formToken" value="${escapeHtml(input.actionTokens[path.split("?")[0]!] ?? "")}" /><button type="submit">${label}</button></form>`;
  const state = input.catalogReady ? "Каталог можливостей активний." : "Каталог можливостей ще не створено.";
  const device = input.deviceAuthorization === undefined ? "" : `
      <section>
        <h2>Вхід Codex</h2>
        <p>Відкрийте <a href="${escapeHtml(input.deviceAuthorization.verificationUrl)}" target="_blank" rel="noopener noreferrer">сторінку авторизації OpenAI</a> у новій вкладці режиму інкогніто, увійдіть саме в обліковий запис із потрібною Codex-підпискою й введіть цей одноразовий код:</p>
        <p><strong>${escapeHtml(input.deviceAuthorization.userCode)}</strong></p>
        <p>Після завершення поверніться до цієї вкладки й оновіть сторінку. Код не зберігається у застосунку.</p>
      </section>`;
  const deviceError = input.deviceAuthorizationFailed === true
    ? '<p role="alert">Не вдалося запустити вхід Codex: runtime Codex не відповів. Повторіть після публікації актуальної версії застосунку.</p>'
    : "";
  const resetResult = input.codexResetResult === "cleared"
    ? '<p role="status">Попередній вхід Codex і його каталог очищено. Тепер почніть новий вхід.</p>'
    : input.codexResetResult === "failed"
      ? '<p role="alert">Не вдалося повністю очистити попередній вхід Codex. Стан на екрані може бути застарілим; не починайте новий вхід і повторіть очищення.</p>'
      : "";
  const failureCode = input.catalogFailure !== undefined && Object.hasOwn(catalogFailureMessages, input.catalogFailure)
    ? input.catalogFailure : "catalog_refresh_failed";
  const catalogResult = input.catalogResult === "updated"
    ? '<p role="status">Каталог можливостей оновлено.</p>'
    : input.catalogResult === "unavailable" ? `<p role="alert">Каталог не оновлено. ${catalogFailureMessages[failureCode]} Код: <code>${failureCode}</code>.</p>` : "";
  return `<!doctype html>
<html lang="uk">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Підготовка runtime — Personal Consultant</title><script src="${OWNER_AUTH_SCRIPT_PATH}" defer></script></head>
  <body>
    <main>
      <h1>Підготовка runtime</h1>
      <p>Codex: ${escapeHtml(input.codex)}${input.codexPlanType === undefined ? "" : ` (план: ${escapeHtml(input.codexPlanType)})`}. Claude Code: ${escapeHtml(input.claude === "not_checked" ? "не перевірено" : input.claude)}.</p>
      <p role="alert" tabindex="-1" data-owner-action-status></p>
      <p>${state}</p>
      ${catalogResult}
      ${resetResult}
      ${deviceError}
      ${device}
      <p>Якщо показаний план відрізняється від вашої Codex-підписки або потрібна інша модель, очистіть попередній вхід перед повторною авторизацією.</p>
      ${form("/operations/runtime/codex/reconnect", "Очистити попередній вхід Codex")}
      ${form("/operations/runtime/codex", "Почати вхід Codex")}
      ${form("/operations/runtime/catalog?provider=codex", "Оновити каталог Codex")}
      ${form("/operations/runtime/catalog?provider=claude_code", "Перевірити Claude Code й оновити його каталог")}
      <p>Перевірка Codex не звертається до Claude Code. Доступність кожного провайдера перевіряється окремо.</p>
      <p><a href="/settings">Відкрити Налаштування власника</a></p>
      <p><a href="/operations/matrix">Підключення та перевірка Matrix</a></p>
      <section aria-label="Сесії власника">
        ${form("/auth/sign-out", "Вийти з цього браузера")}
        ${form("/auth/sessions/revoke", "Завершити всі сесії")}
        <p>Вихід завершує лише доступ до застосунку, не до облікового запису Google чи підписок ШІ.</p>
      </section>
      <noscript>Для захищених дій увімкніть JavaScript і оновіть сторінку.</noscript>
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
  const runtimeEnvironment = parseRuntimeEnvironment(environment);
  const database = parseGodaddyDatabaseConfiguration(environment);
  const google = parseOwnerGoogleConfiguration(environment);
  let receipt = capabilityReceiptFromEnvironment(environment, now());

  if (!runtimeEnvironment.ok || !database.ok || !google.ok) {
    return Object.freeze({
      configured: false,
      async handle(request: Request): Promise<Response | undefined> {
        // Static, read-only verifier: no pool, owner session, state or credentials.
        const verifier = matrixPreviewVerifierResponse(request);
        if (verifier !== undefined) return verifier;
        const control = await matrixPositiveControlResponse(request);
        if (control !== undefined) return control;
        return isManagedPath(new URL(request.url).pathname) || new URL(request.url).pathname.startsWith("/auth/") || isOwnerAuthScriptPath(new URL(request.url).pathname)
          ? plain("Settings are temporarily unavailable.", 503)
          : undefined;
      },
      async close(): Promise<void> {}
    });
  }

  const ownsPool = dependencies.pool === undefined;
  const pool = dependencies.pool ?? (dependencies.createPool ?? defaultPool)(database.value);
  const owner = createOwnerGoogleService({ configuration: google.value, now,
    storage: new MySqlKeyValueStorage({ executor: pool, namespace: "owner-google-access-v1" }),
    ...(dependencies.googleIdentityProvider === undefined ? {} : { provider: dependencies.googleIdentityProvider }) });
  const storage = new MySqlKeyValueStorage({
    executor: pool,
    namespace: "owner-settings-v1"
  });
  const registrar = dependencies.registrarRuntime ?? createGoDaddyRegistrarRuntime({ pool, now });
  const runtime = (dependencies.createRuntimeBootstrap ?? createRuntimeBootstrap)({
    environment,
    pool,
    now,
    ...(receipt === undefined ? {} : { initialCatalog: receipt })
  });
  const loadReceipt = async (): Promise<CapabilityReceipt | undefined> => {
    const loaded = await runtime.loadCatalog();
    receipt = loaded;
    return loaded;
  };
  let recoveryReceipt: CapabilityReceipt | undefined;
  const currentReceipt = (): CapabilityReceipt => {
    const parsed = receipt === undefined ? undefined : parseCapabilityReceipt(receipt, now());
    if (parsed === undefined) {
      if (recoveryReceipt !== undefined) return recoveryReceipt;
      throw new Error("Runtime capability receipt is unavailable.");
    }
    return parsed;
  };
  const ownerSettings = new OwnerSettingsDO({
    storage,
    getCapabilityReceipt: currentReceipt,
    getActiveSessionSummary: registrar.getActiveSessionSummary,
    now
  });
  const csrfKey = importCsrfHmacKey(google.value.csrfHmacKey);
  const readAsset = dependencies.readAsset ?? defaultReadAsset;

  const gateway = async (grant: Readonly<{ origin: string; csrfAudience: string }>, cookieHeader: string | null, includeOwnerActions: boolean): Promise<VerifiedSettingsGateway | undefined> => {
    const key = await csrfKey;
    if (key === undefined) return undefined;
    const ownerActionTokens: Record<string, string> = {};
    if (includeOwnerActions) {
      for (const path of ["/auth/sign-out", "/auth/sessions/revoke", "/api/settings/csrf"]) {
        const token = await owner.issueActionToken(cookieHeader, path);
        if (token === undefined) return undefined;
        ownerActionTokens[path] = token;
      }
    }
    return createVerifiedSettingsGateway({
      ownerSettings,
      getCapabilityReceipt: currentReceipt,
      csrf: createCsrfTokenService({ key, now }),
      csrfBinding: { principal: "owner", audience: grant.csrfAudience, origin: grant.origin },
      ...(includeOwnerActions ? { ownerActionTokens, ownerAuthScriptPath: OWNER_AUTH_SCRIPT_PATH } : {}),
      now
    });
  };

  const consilium = createGoDaddyConsiliumRuntime({ bootstrap: runtime, registrarRuntime: registrar, environment, now });
  const matrixSetup = dependencies.matrixSetupOperations ?? createMatrixSetupOperations(environment);
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        await matrixSetup.close();
        await consilium.close();
        await runtime.close();
      } finally {
        if (ownsPool && "end" in pool && typeof pool.end === "function") {
          await (pool as MySqlPool & Readonly<{ end: () => Promise<void> }>).end();
        }
      }
    })();
    return closePromise;
  };

  const handle = async (request: Request): Promise<Response | undefined> => {
      const url = new URL(request.url);
      const verifier = matrixPreviewVerifierResponse(request);
      if (verifier !== undefined) return verifier;
      const control = await matrixPositiveControlResponse(request);
      if (control !== undefined) return control;
      const cookieHeader = request.headers.get("cookie");

      if (isOwnerAuthScriptPath(url.pathname)) {
        return request.method === "GET"
          ? new Response(ownerAuthClientJavaScript, { headers: securityHeaders({ "content-type": "application/javascript; charset=utf-8" }) })
          : plain("Method not allowed.", 405, { allow: "GET" });
      }

      const rateLimitedPage = url.pathname === "/auth/sign-in/rate-limited";
      const loginPath = url.pathname === "/auth/sign-in" || url.pathname === "/auth/sign-in/denied" || rateLimitedPage;
      if (loginPath && request.method === "GET") {
        const entry = await owner.entry(cookieHeader);
        const response = html(loginDocument(entry.formToken, url.pathname !== "/auth/sign-in", rateLimitedPage), rateLimitedPage ? 429 : 200, [entry.setCookie]);
        if (rateLimitedPage) response.headers.set("retry-after", "60");
        return response;
      }

      if (loginPath) {
        return plain("Method not allowed.", 405, { allow: "GET" });
      }

      if (url.pathname === "/auth/google/start") {
        if (request.method !== "POST") return plain("Method not allowed.", 405, { allow: "POST" });
        if (!isOwnerNavigation(request, google.value.publicOrigin)) return plain("Access denied.", 403);
        const form = await parseActionForm(request);
        if (!form) return plain("Invalid request.", 400);
        const result = await owner.start({ cookieHeader, formToken: form.formToken });
        return result.ok ? json({ location: result.location }, 200, result.cookies)
          : json({ error: result.code }, result.code === "rate_limited" ? 429 : 403, [],
            result.retryAfter === undefined ? {} : { "retry-after": String(result.retryAfter) });
      }

      if (url.pathname === "/auth/google/callback") {
        if (request.method !== "GET") return plain("Method not allowed.", 405, { allow: "GET" });
        let result: Awaited<ReturnType<typeof owner.finish>>;
        try { result = await owner.finish({ cookieHeader, parameters: url.searchParams }); }
        catch { return redirect("/auth/sign-in/denied", []); }
        // Callback never renders provider-controlled data and never reflects its
        // query. Errors also leave the callback URL immediately.
        if (!result.ok) return redirect(result.code === "rate_limited" ? "/auth/sign-in/rate-limited" : "/auth/sign-in/denied", result.cookies,
          result.retryAfter === undefined ? {} : { "retry-after": String(result.retryAfter) });
        let catalog: CapabilityReceipt | undefined;
        try { catalog = await loadReceipt(); } catch { catalog = undefined; }
        return redirect(catalog === undefined ? "/operations/runtime" : "/settings", result.cookies);
      }

      const sessionAction = url.pathname === "/auth/sign-out" || url.pathname === "/auth/sessions/revoke";
      if (!isManagedPath(url.pathname) && !sessionAction) return undefined;
      const grant = await owner.getVerifiedOwner(cookieHeader);
      if (grant === undefined) {
        return request.method === "GET" && (url.pathname === "/settings" || url.pathname === "/operations/runtime" || url.pathname === MATRIX_SETUP_PAGE)
          ? redirect("/auth/sign-in", [])
          : plain("Access denied.", 403);
      }

      const verifyAction = async (): Promise<boolean> => {
        if (!isOwnerNavigation(request, grant.origin)) return false;
        const form = await parseActionForm(request);
        return form !== undefined && await owner.verifyActionToken(cookieHeader, url.pathname, form.formToken);
      };
      if (url.pathname === MATRIX_STATUS_PATH) {
        if (request.method !== "GET") return plain("Method not allowed.", 405, { allow: "GET" });
        if (url.search) return plain("Invalid request.", 400);
        let status: ReturnType<NonNullable<GoDaddySettingsRuntimeDependencies["matrixDiagnostics"]>> | undefined;
        try { status = dependencies.matrixDiagnostics?.(); } catch { /* Do not expose errors or state. */ }
        return json({
          setupMode: environment.MATRIX_SETUP_MODE === "provision" ? "provision"
            : environment.MATRIX_SETUP_MODE === "disabled" || environment.MATRIX_SETUP_MODE === undefined ? "disabled" : "invalid",
          configured: status?.configured === true, ready: status?.ready === true,
          reason: status !== undefined && MATRIX_STATUS_REASONS.has(status.reason) ? status.reason : "unavailable",
          consultationWorking: status?.consultationWorking === true,
          consultationBlocked: status?.consultationBlocked !== false
        });
      }
      if (url.pathname === MATRIX_SETUP_PAGE || url.pathname === MATRIX_SETUP_ACTION) {
        if (url.search) return plain("Invalid request.", 400);
        const render = async (view = matrixSetup.view()): Promise<Response> => {
          const token = await owner.issueActionToken(cookieHeader, MATRIX_SETUP_ACTION);
          return token === undefined ? plain("Access denied.", 403) : html(matrixSetupDocument(view, token), 200);
        };
        if (url.pathname === MATRIX_SETUP_PAGE && request.method === "GET") return render();
        if (url.pathname !== MATRIX_SETUP_ACTION || request.method !== "POST") return plain("Method not allowed.", 405);
        if (!isOwnerNavigation(request, grant.origin)) return plain("Access denied.", 403);
        const form = await parseActionForm(request, ["action", "deviceId", "flowId", "comparisonToken", "previewReport"]);
        if (form === undefined || !await owner.verifyActionToken(cookieHeader, MATRIX_SETUP_ACTION, form.formToken)) return plain("Access denied.", 403);
        const action = form.fields.action as MatrixSetupAction;
        if (!MATRIX_SETUP_ACTIONS.includes(action)) return plain("Invalid request.", 400);
        const required = action === "verify_self" || action === "verify_owner" ? ["deviceId"] : action === "confirm"
          ? ["flowId", "comparisonToken"] : action === "cancel" ? ["flowId"] : action === "complete_preview" ? ["previewReport"] : [];
        if (Object.keys(form.fields).length !== required.length + 1 || required.some(key => form.fields[key] === undefined)) return plain("Invalid request.", 400);
        return render(await matrixSetup.action(action, form.fields, grant.csrfAudience));
      }
      if (sessionAction) {
        if (request.method !== "POST") return plain("Method not allowed.", 405, { allow: "POST" });
        if (!await verifyAction()) return plain("Access denied.", 403);
        const cookie = url.pathname === "/auth/sign-out" ? await owner.signOut(cookieHeader) : await owner.revokeAll(cookieHeader);
        return json({ location: "/auth/sign-in" }, 200, [cookie]);
      }

      if (runtimeOperationPaths.has(url.pathname)) {
        const actionTokens: Record<string, string> = {};
        const render = async (input: Omit<Parameters<typeof operationDocument>[0], "actionTokens">, status = 200): Promise<Response> => {
          for (const path of [...runtimeOperationPaths].filter((path) => path !== "/operations/runtime").concat(["/auth/sign-out", "/auth/sessions/revoke"])) {
            const token = await owner.issueActionToken(cookieHeader, path);
            if (token === undefined) return plain("Access denied.", 403);
            actionTokens[path] = token;
          }
          return html(operationDocument({ ...input, actionTokens }), status);
        };
        if (url.pathname === "/operations/runtime" && request.method === "GET") {
          const [status, catalog] = await Promise.all([runtime.status(), loadReceipt()]);
          return render({ ...status, catalogReady: catalog !== undefined });
        }
        if ((url.pathname === "/operations/runtime/codex" || url.pathname === "/operations/runtime/codex/reconnect" || url.pathname === "/operations/runtime/catalog") && request.method === "POST") {
          if (!await verifyAction()) return plain("Access denied.", 403);
          const [status, catalog] = await Promise.all([runtime.status(), loadReceipt()]);
          if (url.pathname === "/operations/runtime/codex") {
            const deviceAuthorization = await runtime.startCodexDeviceAuthorization();
            return render({
              ...status,
              catalogReady: catalog !== undefined,
              ...(deviceAuthorization === undefined ? { deviceAuthorizationFailed: true } : { deviceAuthorization })
            }, deviceAuthorization === undefined ? 503 : 200);
          }
          if (url.pathname === "/operations/runtime/codex/reconnect") {
            const reset = await runtime.resetCodexAuthorization();
            const afterReset = await runtime.status();
            return render({
              ...afterReset,
              catalogReady: reset ? false : catalog !== undefined,
              codexResetResult: reset ? "cleared" : "failed"
            }, reset ? 200 : 503);
          }
          let refreshed: RuntimeCapabilityCatalogResult;
          const providers = url.searchParams.getAll("provider");
          const provider = providers.length === 0 ? "codex" : providers.length === 1 ? providers[0] : undefined;
          if ((provider !== "codex" && provider !== "claude_code") || [...url.searchParams.keys()].some(key => key !== "provider")) return plain("Invalid request.", 400);
          try { refreshed = await runtime.refreshCatalog(provider); }
          catch { refreshed = { ok: false, code: "catalog_refresh_failed" }; }
          if (refreshed.ok) receipt = refreshed.receipt;
          return render({
            ...status,
            ...(refreshed.ok && provider === "claude_code" ? { claude: "ready" as const } : {}),
            ...(!refreshed.ok && refreshed.code === "claude_auth_rejected" ? { claude: "auth_required" as const } : {}),
            ...(!refreshed.ok && refreshed.code === "claude_access_denied" ? { claude: "unavailable" as const } : {}),
            ...(!refreshed.ok && refreshed.code === "claude_quota_blocked" ? { claude: "quota_blocked" as const } : {}),
            catalogReady: refreshed.ok || catalog !== undefined,
            catalogResult: refreshed.ok ? "updated" : "unavailable",
            ...(!refreshed.ok ? { catalogFailure: refreshed.code } : {})
          }, refreshed.ok ? 200 : 503);
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

      if (url.pathname === "/api/settings/csrf" && request.method === "POST") {
        const token = request.headers.get("x-owner-action-token");
        if (!isOwnerNavigation(request, grant.origin) || token === null ||
          !await owner.verifyActionToken(cookieHeader, url.pathname, token)) return plain("Access denied.", 403);
        if (!await isEmptyJsonAction(request)) return plain("Invalid request.", 400);
      }
      if (await loadReceipt() === undefined) {
        // Recovery is a read-only projection of the owner's saved choices,
        // never a synthetic trusted catalog or an implicit provider switch.
        const stored = readCompatibleSettingsDocument(await storage.get<unknown>("owner-settings:document"));
        if (stored === undefined) {
          return url.pathname === "/settings" && request.method === "GET"
            ? html('<!doctype html><html lang="uk"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Налаштування власника</title><main><h1>Налаштування власника</h1><p role="status">Каталог ще не перевірено. Оновіть лише каталог потрібного провайдера.</p><a href="/operations/runtime">Підготовка runtime</a></main></html>', 200)
            : plain("Settings are temporarily unavailable.", 503);
        }
        recoveryReceipt = Object.freeze({
          catalogVersion: "unavailable", issuedAt: now().toISOString(), expiresAt: now().toISOString(),
          trusted: false, codexModels: [], claudeModels: [], defaults: stored.settings
        });
      } else recoveryReceipt = undefined;
      const verifiedGateway = await gateway(grant, cookieHeader, url.pathname === "/settings" && request.method === "GET");
      return verifiedGateway === undefined
        ? plain("Settings are temporarily unavailable.", 503)
        : verifiedGateway.handle(request);
  };

  return Object.freeze({
    configured: true,
    consilium,
    async prepareConsultationSnapshot(sessionId: string) {
      // Read the owner's saved selection and existing catalog. A Matrix input
      // must never refresh a subscription, silently reset preferences or accept
      // settings supplied by a message.
      const current = await loadReceipt();
      if (current === undefined) return undefined;
      const document = await ownerSettings.read();
      if (document?.effectiveForNextSession === null || document === undefined) return undefined;
      const { resolveEffectiveSessionSnapshot } = await import("../settings/snapshot.ts");
      const resolved = resolveEffectiveSessionSnapshot({
        sessionId, settingsRevision: document.document.revision,
        settings: document.document.settings, capabilityReceipt: current
      }, now());
      return resolved.ok ? resolved.value : undefined;
    },
    close,
    async handle(request: Request): Promise<Response | undefined> {
      try { return await handle(request); } catch {
        // DB/provider/library errors can contain sensitive request material.
        // Never expose an exception, query or owner identity to the response.
        return plain("Settings are temporarily unavailable.", 503);
      }
    }
  });
}
