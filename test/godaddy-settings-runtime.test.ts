import assert from "node:assert/strict";
import test from "node:test";

import { GODADDY_STATE_DATABASE_ROLE, type MySqlConnection } from "../src/godaddy/mysql-storage.ts";
import { createGoDaddySettingsRuntime, type GoDaddySettingsRuntime, type GoDaddySettingsRuntimeDependencies } from "../src/godaddy/settings-runtime.ts";
import { GOOGLE_SESSION_COOKIE } from "../src/godaddy/owner-google-auth.ts";
import type { GoogleIdentityProvider } from "../src/godaddy/google-identity-provider.ts";
import type { RuntimeBootstrap } from "../src/godaddy/runtime-bootstrap.ts";
import type { MatrixSetupOperations } from "../src/godaddy/matrix-setup-operations.ts";
import type { RuntimeCapabilityCatalogResult } from "../src/runtime/capability-catalog.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { OwnerAuthPool } from "./fixtures/owner-auth-pool.ts";
import { MatrixSchemaPool } from "./fixtures/matrix-schema-pool.ts";
import { MatrixCollationPool } from "./fixtures/matrix-collation-pool.ts";
import { browser, Form } from "./fixtures/owner-action-browser.ts";
import { createHash } from "node:crypto";
import { OWNER_AUTH_SCRIPT_PATH, ownerAuthClientJavaScript } from "../src/godaddy/owner-auth-client.ts";

const origin = "https://settings.example.test";
const configuredEnvironment = Object.freeze({
  RUNTIME_MODE: "production", GODADDY_STATE_DATABASE_ROLE,
  DB_HOST: "db.internal", DB_PORT: "3306", DB_NAME: "personal_consultant",
  DB_USER: "application", DB_PASSWORD: "test-only-password",
  GOOGLE_CLIENT_ID: "test-google-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-only-google-client-secret",
  SETTINGS_PUBLIC_ORIGIN: origin,
  SETTINGS_OWNER_GOOGLE_EMAIL: "allowed.test.owner@gmail.com",
  SETTINGS_OWNER_ENABLED: "true",
  SETTINGS_SESSION_HMAC_KEY: "a-very-long-test-session-secret-not-a-production-secret",
  SETTINGS_CSRF_HMAC_KEY: "a-very-long-test-csrf-secret-not-a-production-secret",
  SETTINGS_OAUTH_TRANSACTION_KEY: "a-very-long-test-transaction-key-not-a-production-secret",
  CAPABILITY_CATALOG_JSON: JSON.stringify(createCapabilityReceipt())
});

const provider = (onExchange: () => void = () => {}): GoogleIdentityProvider => ({
  authorizationUrl: ({ state, nonce, codeChallenge }) => {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ state, nonce, code_challenge: codeChallenge }).toString();
    return url.href;
  },
  exchange: async () => {
    onExchange();
    return { issuer: "https://accounts.google.com", subject: "test-owner-subject",
      email: configuredEnvironment.SETTINGS_OWNER_GOOGLE_EMAIL, emailVerified: true };
  }
});

const bootstrap = (overrides: Partial<RuntimeBootstrap> = {}): RuntimeBootstrap => ({
  loadCatalog: async () => createCapabilityReceipt(),
  status: async () => ({ codex: "ready", claude: "ready" }),
  startCodexDeviceAuthorization: async () => undefined,
  resetCodexAuthorization: async () => true,
  refreshCatalog: async () => ({ ok: true, receipt: createCapabilityReceipt() }),
  close: async () => {},
  ...overrides
});

class CookieJar {
  values = new Map<string, string>();
  collect(response: Response | undefined): void {
    for (const cookie of response?.headers.getSetCookie() ?? []) {
      const part = cookie.split(";")[0] ?? "";
      const equals = part.indexOf("=");
      const key = part.slice(0, equals);
      if (cookie.includes("Max-Age=0")) this.values.delete(key);
      else this.values.set(key, part.slice(equals + 1));
    }
  }
  header(): string { return [...this.values].map(([key, value]) => `${key}=${value}`).join("; "); }
}

/** Adds only Settings data to the strict auth fixture for end-to-end gateway tests. */
class SettingsPool extends OwnerAuthPool {
  settings = new Map<string, string>();
  settingQuery(values: Map<string, string>, statement: string, parameters: readonly unknown[]): readonly [unknown, unknown] {
    const key = String(parameters[1]);
    if (statement.startsWith("SELECT")) return [values.has(key) ? [{ stateValue: values.get(key) }] : [], []];
    if (statement.startsWith("INSERT") && typeof parameters[2] === "string") {
      values.set(key, parameters[2]); return [{ affectedRows: 1 }, []];
    }
    throw new Error("Unexpected settings query.");
  }
  override async execute(statement: string, parameters: readonly unknown[]): Promise<readonly [unknown, unknown]> {
    return parameters[0] === "owner-settings-v1" ? this.settingQuery(this.settings, statement, parameters) : super.execute(statement, parameters);
  }
  override async getConnection(): Promise<MySqlConnection> {
    const connection = await super.getConnection();
    const working = new Map(this.settings);
    return {
      ...connection,
      execute: async (statement, parameters) => parameters[0] === "owner-settings-v1"
        ? this.settingQuery(working, statement, parameters) : connection.execute(statement, parameters),
      commit: async () => { await connection.commit(); this.settings = working; }
    };
  }
}

const request = (path: string, jar = new CookieJar(), init: RequestInit = {}): Request => {
  const headers = new Headers(init.headers);
  headers.set("cookie", jar.header());
  headers.set("host", "internal-node.godaddy.test");
  headers.set("x-forwarded-proto", "http");
  return new Request(origin + path, { ...init, headers });
};
const actionRequest = (path: string, token: string, jar: CookieJar, overrides: Record<string, string> = {}): Request => {
  const body = new URLSearchParams({ formToken: token }).toString();
  return request(path, jar, { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded",
    "content-length": String(Buffer.byteLength(body)), ...overrides
  }, body });
};
const formToken = (document: string, path?: string): string => {
  const segment = path === undefined ? document : document.slice(document.indexOf(`action="${path}"`));
  const token = /name="formToken" value="([A-Za-z0-9_.-]+)"/u.exec(segment)?.[1];
  assert.ok(token, "Expected a purpose-bound form token.");
  return token;
};
async function login(runtime: GoDaddySettingsRuntime, jar = new CookieJar()): Promise<{ jar: CookieJar; callback: Response | undefined }> {
  const entry = await runtime.handle(request("/auth/sign-in", jar));
  assert.equal(entry?.status, 200);
  jar.collect(entry);
  const token = formToken(await entry!.text());
  const start = await runtime.handle(actionRequest("/auth/google/start", token, jar));
  assert.equal(start?.status, 200);
  jar.collect(start);
  const location = (await start!.json()).location;
  const state = new URL(location).searchParams.get("state")!;
  const callback = await runtime.handle(request("/auth/google/callback?" + new URLSearchParams({ code: "test-code", state }), jar));
  jar.collect(callback);
  return { jar, callback };
}
function fixture(options: { pool?: OwnerAuthPool; runtime?: RuntimeBootstrap; google?: GoogleIdentityProvider; environment?: Record<string, unknown>; now?: () => Date; matrixSetup?: MatrixSetupOperations; matrixDiagnostics?: GoDaddySettingsRuntimeDependencies["matrixDiagnostics"]; inspectMatrixStorage?: GoDaddySettingsRuntimeDependencies["inspectMatrixStorage"] } = {}) {
  const pool = options.pool ?? new OwnerAuthPool();
  const runtime = createGoDaddySettingsRuntime({ ...configuredEnvironment, ...options.environment }, {
    pool, now: options.now ?? (() => activeNow),
    googleIdentityProvider: options.google ?? provider(),
    ...(options.matrixSetup === undefined ? {} : { matrixSetupOperations: options.matrixSetup }),
    ...(options.matrixDiagnostics === undefined ? {} : { matrixDiagnostics: options.matrixDiagnostics }),
    ...(options.inspectMatrixStorage === undefined ? {} : { inspectMatrixStorage: options.inspectMatrixStorage }),
    createRuntimeBootstrap: () => options.runtime ?? bootstrap(),
    readAsset: async () => new TextEncoder().encode("protected asset")
  });
  return { runtime, pool };
}

test("state collation repair is a distinct owner-only same-origin CSRF action, not an additive-schema side effect", async () => {
  const path = "/operations/matrix/state-collation";
  const pool = new MatrixCollationPool(); const { runtime } = fixture({ pool });
  for (const method of ["GET", "POST"]) assert.equal((await runtime.handle(request(path, undefined, { method })))?.status, 403);
  assert.equal(pool.queries.length, 0);
  const { jar } = await login(runtime);
  assert.equal(pool.queries.length, 0);
  const page = await runtime.handle(request(path, jar));
  assert.equal(page?.headers.get("cache-control"), "no-store");
  const token = formToken(await page!.text(), path);
  assert.equal(pool.alters.length, 0);
  assert.equal((await runtime.handle(actionRequest(path, token, jar, { origin: "https://evil.test" })))?.status, 403);
  assert.equal((await runtime.handle(actionRequest(path, token, jar, { "sec-fetch-site": "cross-site" })))?.status, 403);
  assert.equal((await runtime.handle(actionRequest(path, "x".repeat(64), jar)))?.status, 403);
  const operations = await runtime.handle(request("/operations/runtime", jar));
  const wrongToken = formToken(await operations!.text(), "/auth/sign-out");
  assert.equal((await runtime.handle(actionRequest(path, wrongToken, jar)))?.status, 403);
  assert.equal((await runtime.handle(actionRequest(path + "?sql=bad", token, jar)))?.status, 400);
  assert.equal((await runtime.handle(request(path, jar, { method: "DELETE" })))?.status, 405);
  const badBody = request(path, jar, { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded"
  }, body: new URLSearchParams({ formToken: token, sql: "arbitrary" }).toString() });
  assert.equal((await runtime.handle(badBody))?.status, 403);
  assert.equal(pool.alters.length, 0);
  const client = browser(async (actionPath, init) => {
    const headers = new Headers(init.headers); headers.set("origin", origin); headers.set("sec-fetch-site", "same-origin");
    return (await runtime.handle(request(actionPath, jar, { ...init, headers })))!;
  });
  const form = new Form(path); form.token = token; await client.submit(form);
  assert.equal(pool.alters.length, 1); assert.equal(client.state().replaced, true);
  assert.equal(client.state().message, "");
  assert.ok(!(await (await runtime.handle(request(path, jar)))!.text()).includes("<form"));
  await runtime.close();
  const inert = fixture({ pool, environment: { RUNTIME_MODE: "development" } }).runtime;
  const count = pool.queries.length;
  for (const method of ["GET", "POST"]) assert.equal((await inert.handle(request(path, undefined, { method })))?.status, 503);
  assert.equal(pool.queries.length, count); await inert.close();
});

test("collation migration errors are sanitized and never report success", async () => {
  const pool = new MatrixCollationPool(); pool.failAlter = true;
  const { runtime } = fixture({ pool }); const { jar } = await login(runtime);
  const path = "/operations/matrix/state-collation";
  const page = await runtime.handle(request(path, jar));
  const response = await runtime.handle(actionRequest(path, formToken(await page!.text()), jar));
  assert.equal(response?.status, 503); assert.ok(!(await response!.text()).includes("private alter"));
  await runtime.close();
});

test("additive schema route requires owner, same origin and purpose CSRF; GET never creates tables", async () => {
  const path = "/operations/matrix/schema";
  const pool = new MatrixSchemaPool();
  const { runtime } = fixture({ pool });
  assert.equal((await runtime.handle(request(path)))?.status, 403);
  assert.equal((await runtime.handle(request(path, undefined, { method: "POST" })))?.status, 403);
  assert.equal(pool.schemaStatements.length, 0);
  const { jar } = await login(runtime);
  assert.equal(pool.schemaStatements.length, 0, "Startup and login cannot run schema operations");
  const page = await runtime.handle(request(path, jar));
  const document = await page!.text();
  const token = formToken(document, path);
  assert.equal(page?.headers.get("cache-control"), "no-store");
  assert.equal(pool.creates.length, 0);
  assert.equal((await runtime.handle(actionRequest(path, token, jar, { origin: "https://evil.test" })))?.status, 403);
  assert.equal((await runtime.handle(actionRequest(path, token, jar, { "sec-fetch-site": "cross-site" })))?.status, 403);
  assert.equal((await runtime.handle(actionRequest(path, "x".repeat(64), jar)))?.status, 403);
  const operations = await runtime.handle(request("/operations/runtime", jar));
  const wrongPurpose = formToken(await operations!.text(), "/auth/sign-out");
  assert.equal((await runtime.handle(actionRequest(path, wrongPurpose, jar)))?.status, 403);
  assert.equal((await runtime.handle(actionRequest(path + "?sql=DROP", token, jar)))?.status, 400);
  assert.equal((await runtime.handle(request(path, jar, { method: "PUT" })))?.status, 405);
  assert.equal((await runtime.handle(request(path, jar, { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded"
  }, body: new URLSearchParams({ formToken: token, sql: "DROP TABLE existing" }).toString() })))?.status, 403);
  assert.equal(pool.creates.length, 0);
  const client = browser(async (actionPath, init) => {
    const headers = new Headers(init.headers);
    headers.set("origin", origin); headers.set("sec-fetch-site", "same-origin");
    return (await runtime.handle(request(actionPath, jar, { ...init, headers })))!;
  });
  const form = new Form(path); form.token = token;
  await client.submit(form);
  assert.equal(pool.creates.length, 2);
  assert.equal(client.state().replaced, true);
  assert.equal(client.state().message, "");
  const after = await runtime.handle(request(path, jar));
  assert.ok(!(await after!.text()).includes("<form"), "Completed operation offers no further migration action");
  await runtime.close();
});

test("Preview schema route is inert and database errors remain private", async () => {
  const pool = new MatrixSchemaPool();
  const preview = fixture({ pool, environment: { RUNTIME_MODE: "development" } }).runtime;
  for (const method of ["GET", "POST"]) {
    assert.equal((await preview.handle(request("/operations/matrix/schema", undefined, { method })))?.status, 503);
  }
  assert.equal(pool.schemaStatements.length, 0);
  await preview.close();
  const { runtime } = fixture({ pool }); const { jar } = await login(runtime);
  const page = await runtime.handle(request("/operations/matrix/schema", jar));
  const token = formToken(await page!.text()); pool.failCreateAt = 0;
  const response = await runtime.handle(actionRequest("/operations/matrix/schema", token, jar));
  assert.equal(response?.status, 503);
  assert.ok(!(await response!.text()).includes("private-database-error"));
  await runtime.close();
});

test("Matrix diagnostics are read-only, owner-only, uncached, and project fixed fields only", async () => {
  let reads = 0;
  let storageReads = 0;
  const storagePaths = { application: "directory", public: "directory", assets: "directory",
    privateRoot: "missing", cryptoStore: "not_checked", deviceBinding: "not_checked" } as const;
  let reason = "schema_unavailable";
  const { runtime } = fixture({ environment: { MATRIX_SETUP_MODE: "disabled" }, matrixDiagnostics: () => {
    reads += 1;
    return { configured: true, ready: false, reason, consultationWorking: false, consultationBlocked: true,
      privateValue: "never-expose-this" };
  }, inspectMatrixStorage: async () => { storageReads += 1; return storagePaths; } });
  assert.equal((await runtime.handle(request("/operations/matrix/status")))?.status, 403);
  assert.equal(reads, 0);
  const { jar } = await login(runtime);
  const response = await runtime.handle(request("/operations/matrix/status", jar));
  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response!.json(), { setupMode: "disabled", configured: true, ready: false,
    reason: "schema_unavailable", consultationWorking: false, consultationBlocked: true });
  for (const storageReason of ["store_binding_missing", "store_binding_access_denied", "store_binding_transient"]) {
    reason = storageReason;
    const storageResponse = await runtime.handle(request("/operations/matrix/status", jar));
    assert.deepEqual(await storageResponse!.json(), { setupMode: "disabled", configured: true, ready: false,
      reason: storageReason, consultationWorking: false, consultationBlocked: true,
      ...(storageReason === "store_binding_missing" ? { storagePaths } : {}) });
  }
  reason = "secret-that-must-not-leak";
  assert.equal((await (await runtime.handle(request("/operations/matrix/status", jar)))!.json()).reason, "unavailable");
  assert.equal((await runtime.handle(request("/operations/matrix/status", jar, { method: "POST" })))?.status, 405);
  assert.equal((await runtime.handle(request("/operations/matrix/status?x=1", jar)))?.status, 400);
  assert.equal(reads, 5);
  assert.equal(storageReads, 1);
  reason = "store_binding_missing";
  assert.equal((await runtime.handle(request("/operations/matrix/status")))?.status, 403);
  assert.equal((await runtime.handle(request("/operations/matrix/status?path=/etc", jar)))?.status, 400);
  assert.equal((await runtime.handle(request("/operations/matrix/status", jar, { method: "POST" })))?.status, 405);
  assert.equal(storageReads, 1, "Denied requests cannot inspect storage");
  await runtime.close();
});

test("Preview cannot inspect Matrix storage even when a diagnostic callback is supplied", async () => {
  const { runtime } = fixture({ environment: { RUNTIME_MODE: "development" },
    matrixDiagnostics: () => { throw new Error("must not run"); },
    inspectMatrixStorage: async () => { throw new Error("must not run"); } });
  assert.equal((await runtime.handle(request("/operations/matrix/status")))?.status, 503);
  await runtime.close();
});

test("every owner surface binds its script URL to the exact current handler bytes", async () => {
  const { runtime } = fixture({ pool: new SettingsPool() });
  const digest = createHash("sha256").update(ownerAuthClientJavaScript).digest("hex");
  assert.equal(OWNER_AUTH_SCRIPT_PATH, `/assets/owner-auth.${digest}.js`);
  const { jar } = await login(runtime);
  for (const path of ["/auth/sign-in", "/settings", "/operations/runtime", "/operations/matrix"]) {
    const page = await runtime.handle(request(path, jar));
    assert.equal(page?.status, 200, path);
    const document = await page!.text();
    assert.ok(document.includes(`src="${OWNER_AUTH_SCRIPT_PATH}"`), path);
    assert.ok(!document.includes('src="/assets/owner-auth.js"'), path);
  }
  const script = await runtime.handle(request(OWNER_AUTH_SCRIPT_PATH));
  assert.equal(script?.status, 200);
  assert.equal(script?.headers.get("cache-control"), "no-store");
  assert.equal(await script!.text(), ownerAuthClientJavaScript);
  assert.equal((await runtime.handle(request(OWNER_AUTH_SCRIPT_PATH, undefined, { method: "POST" })))?.status, 405);
  assert.equal(await runtime.handle(request(`/assets/owner-auth.${"0".repeat(64)}.js`)), undefined);
  await runtime.close();
});

test("Matrix prepare uses the HTML-selected versioned handler even when the legacy URL has an obsolete cached handler", async () => {
  const calls: string[] = [];
  const { runtime } = fixture({ matrixSetup: { view: () => ({ state: "unprepared" }), close: async () => {},
    action: async action => { calls.push(action); return { state: "prepared" }; } } });
  const { jar } = await login(runtime);
  const page = await runtime.handle(request("/operations/matrix", jar));
  const document = await page!.text();
  const path = /<script src="([^"]+)"/u.exec(document)?.[1];
  assert.equal(path, OWNER_AUTH_SCRIPT_PATH);
  const cachedLegacyScript = ownerAuthClientJavaScript.replace('form.getAttribute("action") || ""', 'form.action');
  const cached = new Map([["/assets/owner-auth.js", cachedLegacyScript]]);
  const script = cached.get(path!) ?? await (await runtime.handle(request(path!)))!.text();
  const client = browser(async (actionPath, init) => {
    const headers = new Headers(init.headers);
    headers.set("origin", origin); headers.set("sec-fetch-site", "same-origin");
    return (await runtime.handle(request(actionPath, jar, { ...init, headers })))!;
  }, script);
  const form = new Form("/operations/matrix/action");
  form.token = formToken(document, "/operations/matrix/action"); form.fields = { action: "prepare" };
  await client.submit(form);
  assert.deepEqual(calls, ["prepare"]);
  assert.equal(client.state().replaced, true);
  assert.equal(client.state().message, "");
  await runtime.close();
});

test("Matrix setup page and all setup effects require the same exact owner session and purpose-bound CSRF", async () => {
  const actions: unknown[] = [];
  const setup: MatrixSetupOperations = { view: () => ({ state: "prepared" }), close: async () => {},
    action: async (action, fields) => { actions.push({ action, fields }); return { state: "prepared" }; } };
  const { runtime } = fixture({ matrixSetup: setup });
  assert.equal((await runtime.handle(request("/operations/matrix")))?.headers.get("location"), "/auth/sign-in");
  assert.equal((await runtime.handle(request("/operations/matrix/action", undefined, { method: "POST" })))?.status, 403);
  assert.deepEqual(actions, []);
  const { jar } = await login(runtime);
  const page = await runtime.handle(request("/operations/matrix", jar));
  const token = formToken(await page!.text(), "/operations/matrix/action");
  assert.deepEqual(actions, [], "GET must not provision or start any child");
  const post = (values: URLSearchParams, extra: Record<string, string> = {}) => runtime.handle(request("/operations/matrix/action", jar,
    { method: "POST", headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", ...extra }, body: values.toString() }));
  assert.equal((await post(new URLSearchParams({ formToken: token, action: "prepare" }), { origin: "https://evil.test" }))?.status, 403);
  assert.equal((await post(new URLSearchParams({ formToken: token, action: "confirm", flowId: "f" })))?.status, 400);
  assert.equal((await post(new URLSearchParams({ formToken: token, action: "prepare", access_token: "do-not-accept" })))?.status, 403);
  const duplicates = new URLSearchParams({ formToken: token, action: "prepare" }); duplicates.append("action", "confirm");
  assert.equal((await post(duplicates))?.status, 403);
  assert.deepEqual(actions, []);
  const result = await post(new URLSearchParams({ formToken: token, action: "confirm", flowId: "flow1", comparisonToken: "c".repeat(32) }));
  assert.equal(result?.status, 200);
  assert.deepEqual(actions, [{ action: "confirm", fields: { action: "confirm", flowId: "flow1", comparisonToken: "c".repeat(32) } }]);
  assert.equal(result?.headers.get("cache-control"), "no-store");
  await runtime.close();
});

test("served owner script forwards only explicit setup fields and does not discard device/SAS confirmation data", async () => {
  let submitted: Record<string, string> | undefined;
  const surface = browser(async (path, init) => {
    assert.equal(path, "/operations/matrix/action");
    submitted = Object.fromEntries(new URLSearchParams(String(init.body)));
    return new Response("<main><h1>Matrix</h1></main>", { headers: { "content-type": "text/html" } });
  });
  const form = new Form("https://settings.example.test/operations/matrix/action");
  form.fields = { action: "confirm", flowId: "same-flow", comparisonToken: "c".repeat(32), password: "must-not-forward" };
  await surface.submit(form);
  assert.deepEqual(submitted, { formToken: form.token, action: "confirm", flowId: "same-flow", comparisonToken: "c".repeat(32) });
  assert.equal(surface.state().replaced, true);
  assert.equal(surface.state().message, "");
});

test("provider-specific catalog actions preserve Google auth and dispatch only the requested provider", async () => {
  const calls: string[] = [];
  const { runtime } = fixture({ runtime: bootstrap({ refreshCatalog: async (selected) => {
    calls.push(selected!); return { ok: true, receipt: createCapabilityReceipt() };
  } }) });
  const { jar } = await login(runtime);
  for (const selected of ["codex", "claude_code"] as const) {
    const page = await runtime.handle(request("/operations/runtime", jar));
    const path = `/operations/runtime/catalog?provider=${selected}`;
    const result = await runtime.handle(actionRequest(path, formToken(await page!.text(), path), jar));
    assert.equal(result?.status, 200);
  }
  assert.deepEqual(calls, ["codex", "claude_code"]);
  const page = await runtime.handle(request("/operations/runtime", jar));
  const token = formToken(await page!.text(), "/operations/runtime/catalog?provider=codex");
  assert.equal((await runtime.handle(actionRequest("/operations/runtime/catalog?provider=other", token, jar)))?.status, 400);
  assert.deepEqual(calls, ["codex", "claude_code"]);
});

test("served catalog forms pass through the served browser script to the exact protected provider route", async () => {
  const calls: string[] = [];
  const { runtime } = fixture({ runtime: bootstrap({ refreshCatalog: async (selected) => {
    calls.push(selected!); return { ok: true, receipt: createCapabilityReceipt() };
  } }) });
  const { jar } = await login(runtime);
  const script = await runtime.handle(request("/assets/owner-auth.js", jar));
  assert.equal(script?.status, 200);
  const client = await script!.text();
  for (const selected of ["codex", "claude_code"] as const) {
    const page = await runtime.handle(request("/operations/runtime", jar));
    const html = await page!.text();
    const path = `/operations/runtime/catalog?provider=${selected}`;
    assert.ok(html.includes(`action="${path}"`));
    const form = new Form(path);
    form.token = formToken(html, path);
    const requests: string[] = [];
    const app = browser(async (actual, init) => {
      requests.push(actual);
      const headers = new Headers(init.headers);
      headers.set("origin", origin);
      headers.set("sec-fetch-site", "same-origin");
      const response = await runtime.handle(request(actual, jar, { ...init, headers }));
      assert.equal(response?.status, 200);
      assert.match(await response!.clone().text(), /Каталог можливостей оновлено/u);
      return response!;
    }, client);
    await app.submit(form);
    assert.deepEqual(requests, [path]);
    assert.equal(app.state().replaced, true);
    assert.equal(app.state().headingFocused, true);
  }
  assert.deepEqual(calls, ["codex", "claude_code"]);
});

test("an expired or missing catalog exposes saved Critic recovery controls without enabling an unverified save", async () => {
  const pool = new SettingsPool();
  let available = true;
  const { runtime } = fixture({ pool, runtime: bootstrap({ loadCatalog: async () => available ? createCapabilityReceipt() : undefined }) });
  const { jar } = await login(runtime);
  assert.equal((await runtime.handle(request("/settings", jar)))?.status, 200);
  const saved = pool.settings.get("owner-settings:document");
  assert.ok(saved);
  available = false;
  const page = await runtime.handle(request("/settings", jar));
  assert.equal(page?.status, 200);
  const body = await page!.text();
  assert.match(body, /id="critic-provider"/);
  assert.match(body, /href="\/operations\/runtime"/);
  assert.equal(pool.settings.get("owner-settings:document"), saved);
  const read = await runtime.handle(request("/api/settings", jar));
  assert.equal(read?.status, 200);
  const value = await read!.json();
  assert.equal(value.effectiveForNextSession, null);
  assert.ok(value.effectiveIncompatibility);
  assert.equal((await runtime.handle(request("/settings")))?.status, 303);
});

test("a first-time owner with no catalog gets a protected recovery page rather than an HTTP 503", async () => {
  const { runtime } = fixture({ pool: new SettingsPool(), runtime: bootstrap({ loadCatalog: async () => undefined }) });
  const { jar } = await login(runtime);
  const page = await runtime.handle(request("/settings", jar));
  assert.equal(page?.status, 200);
  assert.match(await page!.text(), /href="\/operations\/runtime"/);
});

test("catalog failures identify the failing step without leaking details or clearing credentials", async () => {
  const codes: Extract<RuntimeCapabilityCatalogResult, { ok: false }>["code"][] = [
    'claude_auth_rejected', 'claude_access_denied', 'claude_quota_blocked', 'claude_cli_incompatible', 'claude_process_failed',
    'claude_invalid_response', 'claude_models_unavailable', 'catalog_storage_failed', 'invalid_models', 'invalid_defaults'
  ];
  for (const code of codes) {
    let resets = 0;
    const { runtime } = fixture({ runtime: bootstrap({
      status: async () => ({ codex: 'ready', codexPlanType: 'pro', claude: 'ready' }),
      refreshCatalog: async () => ({ ok: false, code }),
      resetCodexAuthorization: async () => { resets++; return true; }
    }) });
    const { jar } = await login(runtime);
    const page = await runtime.handle(request('/operations/runtime', jar));
    const token = formToken(await page!.text(), '/operations/runtime/catalog?provider=claude_code');
    const result = await runtime.handle(actionRequest('/operations/runtime/catalog?provider=claude_code', token, jar));
    assert.equal(result?.status, 503);
    const html = await result!.text();
    assert.ok(html.includes(`<code>${code}</code>`));
    assert.match(html, /Codex: ready \(план: pro\)/);
    if (code === 'claude_auth_rejected') assert.match(html, /Claude Code: auth_required/);
    if (code === 'claude_access_denied') { assert.match(html, /Claude Code: unavailable/); assert.match(html, /HTTP 403/); }
    if (code === 'claude_quota_blocked') assert.match(html, /Claude Code: quota_blocked/);
    assert.doesNotMatch(html, /Перевірте готовність обох підписок/);
    assert.match(html, /Каталог можливостей активний/, 'previous valid catalog is preserved');
    assert.equal(resets, 0);
  }
});

test("unexpected catalog exceptions stay private and leave the Google session usable", async () => {
  const { runtime } = fixture({ runtime: bootstrap({ refreshCatalog: async () => { throw new Error('RAW-SECRET-MARKER'); } }) });
  const { jar } = await login(runtime);
  const page = await runtime.handle(request('/operations/runtime', jar));
  const response = await runtime.handle(actionRequest('/operations/runtime/catalog?provider=claude_code', formToken(await page!.text(), '/operations/runtime/catalog?provider=claude_code'), jar));
  assert.equal(response?.status, 503);
  const html = await response!.text();
  assert.match(html, /catalog_refresh_failed/);
  assert.doesNotMatch(html, /RAW-SECRET-MARKER/);
  assert.equal((await runtime.handle(request('/operations/runtime', jar)))?.status, 200);
});

test("Google configuration and Published policy fail closed before a pool is created; password is not a fallback", async () => {
  for (const change of [{}, { SETTINGS_OWNER_ENABLED: "false" }, { RUNTIME_MODE: "preview" },
    { GOOGLE_CLIENT_ID: "", SETTINGS_OWNER_PASSWORD: "x".repeat(64) }, { OPENAI_API_KEY: "forbidden" }]) {
    let pools = 0;
    const environment = Object.keys(change).length === 0 ? {} : { ...configuredEnvironment, ...change };
    const runtime = createGoDaddySettingsRuntime(environment, { createPool: () => { pools++; return new OwnerAuthPool(); } });
    assert.equal(runtime.configured, false);
    assert.equal(pools, 0);
    for (const path of ["/settings", "/auth/sign-in", "/operations/runtime", "/assets/settings.js"]) {
      const response = await runtime.handle(request(path));
      assert.equal(response?.status, 503);
      assert.equal(response?.headers.get("cache-control"), "no-store");
    }
  }
});

test("entry and GET start cannot exchange tokens or touch durable auth/application state", async () => {
  let exchanges = 0;
  const { runtime, pool } = fixture({ google: provider(() => { exchanges++; }) });
  const entry = await runtime.handle(request("/auth/sign-in"));
  assert.equal(entry?.status, 200);
  const document = await entry!.text();
  assert.match(document, /Увійти через Google/u);
  assert.doesNotMatch(document, /password|Ключ входу/u);
  assert.match(document, /data-owner-action/u);
  assert.ok(document.includes(`src="${OWNER_AUTH_SCRIPT_PATH}"`));
  assert.equal(entry?.headers.get("referrer-policy"), "no-referrer");
  assert.match(entry!.headers.getSetCookie()[0]!, /Secure; HttpOnly; SameSite=Lax/u);
  assert.equal(pool.values.size, 0);
  assert.equal((await runtime.handle(request("/auth/google/start")))?.status, 405);
  assert.equal((await runtime.handle(request("/auth/sign-in", undefined, { method: "POST" })))?.status, 405);
  assert.equal(exchanges, 0);
  assert.equal(pool.values.size, 0);
  const script = await runtime.handle(request("/assets/owner-auth.js"));
  assert.equal(script?.status, 200);
  assert.match(await script!.text(), /mode: "cors"/u);
});

test("Google login uses configured public origin despite internal Host, returns same-tab callback to a catalog-independent destination", async () => {
  for (const catalogReady of [true, false]) {
    let exchanges = 0;
    let aiStarts = 0;
    const { runtime } = fixture({ google: provider(() => { exchanges++; }),
      runtime: bootstrap({ loadCatalog: async () => catalogReady ? createCapabilityReceipt() : undefined,
        startCodexDeviceAuthorization: async () => { aiStarts++; return undefined; } }) });
    const { jar, callback } = await login(runtime);
    assert.equal(callback?.status, 303);
    assert.equal(callback?.headers.get("location"), catalogReady ? "/settings" : "/operations/runtime");
    assert.equal(callback?.headers.get("referrer-policy"), "no-referrer");
    assert.equal(callback?.headers.get("cache-control"), "no-store");
    assert.ok(jar.values.has(GOOGLE_SESSION_COOKIE));
    assert.equal(exchanges, 1);
    assert.equal(aiStarts, 0);
    const asset = await runtime.handle(request("/assets/settings.js", jar));
    assert.equal(asset?.status, 200);
    assert.equal(await asset!.text(), "protected asset");
  }
});

test("all protected bytes deny unknown grants, while callback failures clean the URL without exposing provider text", async () => {
  const { runtime } = fixture();
  for (const path of ["/api/settings", "/api/settings/reset", "/api/settings/csrf", "/assets/settings.css", "/assets/settings.js",
    "/operations/runtime/codex", "/auth/sign-out", "/auth/sessions/revoke"]) {
    assert.equal((await runtime.handle(request(path)))?.status, 403);
  }
  for (const path of ["/settings", "/operations/runtime"]) {
    const response = await runtime.handle(request(path));
    assert.equal(response?.status, 303);
    assert.equal(response?.headers.get("location"), "/auth/sign-in");
  }
  const denied = await runtime.handle(request("/auth/google/callback?code=DO-NOT-REFLECT&state=invalid&error_description=SECRET"));
  assert.equal(denied?.status, 303);
  assert.equal(denied?.headers.get("location"), "/auth/sign-in/denied");
  assert.equal(await denied!.text(), "");
  assert.doesNotMatch([...denied!.headers].join(""), /DO-NOT-REFLECT|SECRET/u);
  const page = await runtime.handle(request("/auth/sign-in/denied"));
  assert.match(await page!.text(), /Спробуйте знову/u);
});

test("start rejects null/wrong Origin, wrong metadata, missing/duplicate token and oversized/chunked body before exchange", async () => {
  let exchanges = 0;
  const { runtime } = fixture({ google: provider(() => { exchanges++; }) });
  const jar = new CookieJar();
  const entry = await runtime.handle(request("/auth/sign-in", jar));
  jar.collect(entry);
  const token = formToken(await entry!.text());
  for (const headers of [{ origin: "null" }, { origin: "https://attacker.test" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await runtime.handle(actionRequest("/auth/google/start", token, jar, headers)))?.status, 403);
  }
  for (const body of ["", "formToken=" + token + "&formToken=" + token, "formToken=" + token + "&password=wrong", "formToken=" + "x".repeat(5000)]) {
    const response = await runtime.handle(request("/auth/google/start", jar, { method: "POST", headers: {
      origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded"
    }, body }));
    assert.equal(response?.status, 400);
  }
  assert.equal(exchanges, 0);
});

test("durable start limiter produces 429 with bounded retry and no new provider exchange", async () => {
  const { runtime } = fixture();
  const jar = new CookieJar();
  const entry = await runtime.handle(request("/auth/sign-in", jar));
  jar.collect(entry);
  const token = formToken(await entry!.text());
  for (let index = 0; index < 5; index++) assert.equal((await runtime.handle(actionRequest("/auth/google/start", token, jar)))?.status, 200);
  const limited = await runtime.handle(actionRequest("/auth/google/start", token, jar));
  assert.equal(limited?.status, 429);
  assert.ok(Number(limited?.headers.get("retry-after")) >= 1);
  assert.ok(Number(limited?.headers.get("retry-after")) <= 600);
});

test("callback throttling immediately cleans the callback URL and the final retry page returns429", async () => {
  let exchanges = 0;
  const { runtime } = fixture({ google: provider(() => { exchanges++; }) });
  const jar = new CookieJar();
  const entry = await runtime.handle(request("/auth/sign-in", jar));
  jar.collect(entry);
  const token = formToken(await entry!.text());
  let state = "";
  for (let index = 0; index < 5; index++) {
    const response = await runtime.handle(actionRequest("/auth/google/start", token, jar));
    jar.collect(response);
    state = new URL((await response!.json()).location).searchParams.get("state")!;
  }
  const callback = await runtime.handle(request("/auth/google/callback?" + new URLSearchParams({ code: "not-exchanged", state }), jar));
  assert.equal(callback?.status, 303);
  assert.equal(callback?.headers.get("location"), "/auth/sign-in/rate-limited");
  assert.ok(Number(callback?.headers.get("retry-after")) > 0);
  const page = await runtime.handle(request("/auth/sign-in/rate-limited", jar));
  assert.equal(page?.status, 429);
  assert.equal(page?.headers.get("retry-after"), "60");
  assert.match(await page!.text(), /Увійти через Google/u);
  assert.equal(exchanges, 0);
});

test("Settings page exposes only session-bound action tokens and CSRF refresh requires its own purpose token and bounded JSON", async () => {
  const { runtime } = fixture({ pool: new SettingsPool() });
  const { jar } = await login(runtime);
  const page = await runtime.handle(request("/settings", jar));
  assert.equal(page?.status, 200);
  const document = await page!.text();
  const refresh = /name="owner-csrf-refresh-token" content="([A-Za-z0-9_.-]+)"/u.exec(document)?.[1];
  assert.ok(refresh);
  const logout = formToken(document, "/auth/sign-out");
  assert.notEqual(refresh, logout);
  const csrfRequest = (token: string, body = "{}", extra: Record<string, string> = {}): Request => request("/api/settings/csrf", jar, {
    method: "POST", headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-owner-action-token": token, ...extra }, body
  });
  assert.equal((await runtime.handle(csrfRequest(logout)))?.status, 403);
  assert.equal((await runtime.handle(csrfRequest(refresh, "{}", { origin: "null" })))?.status, 403);
  assert.equal((await runtime.handle(csrfRequest(refresh, "{\"extra\":true}")))?.status, 400);
  const response = await runtime.handle(csrfRequest(refresh));
  assert.equal(response?.status, 200);
  assert.equal(typeof (await response!.json()).csrfToken, "string");
  assert.doesNotMatch(document, /allowed\.test\.owner@gmail\.com|test-owner-subject|test-only-google-client-secret/u);
});

test("runtime operations require independent purpose CSRF; login/logout do not change AI credentials", async () => {
  let starts = 0;
  let resets = 0;
  let available = true;
  const { runtime } = fixture({ runtime: bootstrap({
    loadCatalog: async () => undefined,
    status: async () => ({ codex: "auth_required", claude: "ready" }),
    startCodexDeviceAuthorization: async () => {
      starts++;
      return available ? { verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" } : undefined;
    },
    resetCodexAuthorization: async () => { resets++; return true; }
  }) });
  const { jar } = await login(runtime);
  assert.equal(starts, 0);
  const operations = await runtime.handle(request("/operations/runtime", jar));
  const document = await operations!.text();
  assert.match(document, /Вийти з цього браузера/u);
  assert.match(document, /Завершити всі сесії/u);
  const codexToken = formToken(document, "/operations/runtime/codex");
  const resetToken = formToken(document, "/operations/runtime/codex/reconnect");
  const logoutToken = formToken(document, "/auth/sign-out");
  assert.notEqual(codexToken, resetToken);
  assert.equal((await runtime.handle(actionRequest("/operations/runtime/codex", resetToken, jar)))?.status, 403);
  assert.equal((await runtime.handle(actionRequest("/operations/runtime/codex", codexToken, jar, { origin: "null" })))?.status, 403);
  assert.equal(starts, 0);
  const authorization = await runtime.handle(actionRequest("/operations/runtime/codex", codexToken, jar));
  assert.equal(authorization?.status, 200);
  const body = await authorization!.text();
  assert.match(body, /ABCD-1234/u);
  assert.match(body, /target="_blank"/u);
  assert.match(body, /rel="noopener noreferrer"/u);
  assert.equal(starts, 1);
  assert.equal((await runtime.handle(actionRequest("/operations/runtime/codex/reconnect", resetToken, jar)))?.status, 200);
  assert.equal(resets, 1);
  available = false;
  assert.equal((await runtime.handle(actionRequest("/operations/runtime/codex", codexToken, jar)))?.status, 503);
  const signedOut = await runtime.handle(actionRequest("/auth/sign-out", logoutToken, jar));
  assert.equal(signedOut?.status, 200);
  assert.deepEqual(await signedOut!.json(), { location: "/auth/sign-in" });
  assert.equal((await runtime.handle(request("/assets/settings.js", jar)))?.status, 403);
  assert.equal(resets, 1);
});

test("revoke-all invalidates every browser grant, and session-bound action tokens do not cross browsers", async () => {
  const { runtime } = fixture();
  const first = await login(runtime);
  const second = await login(runtime);
  const operations = await runtime.handle(request("/operations/runtime", first.jar));
  const revoke = formToken(await operations!.text(), "/auth/sessions/revoke");
  assert.equal((await runtime.handle(actionRequest("/auth/sessions/revoke", revoke, second.jar)))?.status, 403);
  assert.equal((await runtime.handle(actionRequest("/auth/sessions/revoke", revoke, first.jar)))?.status, 200);
  for (const jar of [first.jar, second.jar]) assert.equal((await runtime.handle(request("/assets/settings.js", jar)))?.status, 403);
});

test("session expiry is enforced for protected assets without relying on browser cookie deletion", async () => {
  let instant = activeNow;
  const { runtime } = fixture({ now: () => instant });
  const { jar } = await login(runtime);
  instant = new Date(instant.getTime() + 30 * 60_000);
  assert.equal((await runtime.handle(request("/assets/settings.css", jar)))?.status, 403);
});

test("database failures are sanitized and callback failures still remove the callback query", async () => {
  class FailedPool extends OwnerAuthPool {
    override async getConnection(): Promise<never> { throw new Error("SECRET_TOKEN raw provider query"); }
  }
  const { runtime } = fixture({ pool: new FailedPool() });
  const callback = await runtime.handle(request("/auth/google/callback?code=SECRET_TOKEN&state=bad"));
  assert.equal(callback?.status, 303);
  assert.equal(callback?.headers.get("location"), "/auth/sign-in/denied");
  const jar = new CookieJar();
  const entry = await runtime.handle(request("/auth/sign-in"));
  jar.collect(entry);
  const response = await runtime.handle(actionRequest("/auth/google/start", formToken(await entry!.text()), jar));
  assert.equal(response?.status, 503);
  assert.doesNotMatch(await response!.text(), /SECRET_TOKEN|provider query/u);
});

test("Settings closes its bootstrap once, closes only its owned pool and preserves shared-pool ownership", async () => {
  class CloseTrackingPool extends OwnerAuthPool { endCount = 0; async end() { this.endCount++; } }
  for (const shared of [false, true]) {
    const pool = new CloseTrackingPool();
    let closes = 0;
    const runtime = createGoDaddySettingsRuntime(configuredEnvironment, {
      ...(shared ? { pool } : { createPool: () => pool }), now: () => activeNow,
      googleIdentityProvider: provider(),
      createRuntimeBootstrap: () => bootstrap({ close: async () => { closes++; } })
    });
    await Promise.all([runtime.close(), runtime.close()]);
    assert.equal(closes, 1);
    assert.equal(pool.endCount, shared ? 0 : 1);
  }
});
