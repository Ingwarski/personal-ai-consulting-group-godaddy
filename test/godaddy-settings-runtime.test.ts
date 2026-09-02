import assert from "node:assert/strict";
import test from "node:test";

import { GODADDY_STATE_DATABASE_ROLE, type MySqlConnection, type MySqlPool } from "../src/godaddy/mysql-storage.ts";
import { createGoDaddySettingsRuntime } from "../src/godaddy/settings-runtime.ts";
import type { RuntimeBootstrap } from "../src/godaddy/runtime-bootstrap.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

class UnusedPool implements MySqlPool {
  execute(): Promise<readonly [unknown, unknown]> {
    throw new Error("Settings must not touch MySQL before the owner signs in.");
  }

  getConnection(): Promise<MySqlConnection> {
    throw new Error("Settings must not open a MySQL transaction before the owner signs in.");
  }
}

const configuredEnvironment = Object.freeze({
  GODADDY_STATE_DATABASE_ROLE,
  DB_HOST: "db.internal",
  DB_PORT: "3306",
  DB_NAME: "personal_consultant",
  DB_USER: "application",
  DB_PASSWORD: "test-only-password",
  SETTINGS_OWNER_PASSWORD: "a-very-long-random-owner-secret-that-is-never-a-production-secret",
  SETTINGS_SESSION_HMAC_KEY: "a-very-long-test-session-secret-that-is-never-a-production-secret",
  SETTINGS_CSRF_HMAC_KEY: "a-very-long-test-csrf-secret-that-is-never-a-production-secret",
  CAPABILITY_CATALOG_JSON: JSON.stringify(createCapabilityReceipt())
});

const originHeaders = Object.freeze({
  host: "settings.example.test",
  "x-forwarded-proto": "https"
});

test("GoDaddy Settings runtime is unavailable until every identity, state and catalog boundary exists", async () => {
  const runtime = createGoDaddySettingsRuntime({});
  assert.equal(runtime.configured, false);
  const response = await runtime.handle(new Request("https://settings.example.test/settings"));
  assert.equal(response?.status, 503);
  assert.equal(await response?.text(), "Settings are temporarily unavailable.");
});

test("GoDaddy Settings starts only a local owner-password session before it opens application state", async () => {
  const runtime = createGoDaddySettingsRuntime(configuredEnvironment, {
    createPool: () => new UnusedPool(),
    now: () => activeNow
  });
  assert.equal(runtime.configured, true);

  const unknownAsset = await runtime.handle(new Request("https://settings.example.test/assets/settings.css", { headers: originHeaders }));
  assert.equal(unknownAsset?.status, 403);

  const settings = await runtime.handle(new Request("https://settings.example.test/settings", { headers: originHeaders }));
  assert.equal(settings?.status, 303);
  assert.equal(settings?.headers.get("location"), "/auth/sign-in");

  const login = await runtime.handle(new Request("https://settings.example.test/auth/sign-in", { headers: originHeaders }));
  assert.equal(login?.status, 200);
  const loginDocument = await login?.text();
  assert.equal(loginDocument?.includes("Ключ входу"), true);
  const cookies = (login?.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0]?.startsWith("__Host-personal-consultant-login="), true);
  assert.equal(cookies[0]?.includes("HttpOnly; Secure; SameSite=Strict"), true);

  const formToken = /name="formToken" value="([A-Za-z0-9_-]+)"/u.exec(loginDocument ?? "")?.[1];
  assert.notEqual(formToken, undefined);
  if (formToken === undefined || cookies[0] === undefined) throw new Error("Expected a local owner login challenge.");
  const form = new URLSearchParams({
    formToken,
    password: configuredEnvironment.SETTINGS_OWNER_PASSWORD
  }).toString();
  const signedIn = await runtime.handle(new Request("https://settings.example.test/auth/sign-in", {
    method: "POST",
    headers: {
      ...originHeaders,
      cookie: cookies[0].slice(0, cookies[0].indexOf(";")),
      origin: "https://settings.example.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(form.length)
    },
    body: form
  }));
  assert.equal(signedIn?.status, 303);
  assert.equal(signedIn?.headers.get("location"), "/settings");
  const signInCookies = (signedIn?.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  assert.equal(signInCookies.some((cookie) => cookie.startsWith("__Host-personal-consultant-owner=")), true);
});

test("owner sign-in ignores GoDaddy internal Host and HTTP upstream protocol while retaining the public browser origin", async () => {
  const runtime = createGoDaddySettingsRuntime(configuredEnvironment, {
    createPool: () => new UnusedPool(),
    now: () => activeNow
  });
  const proxyHeaders = { host: "internal-node.godaddy.test", "x-forwarded-proto": "http" };
  const login = await runtime.handle(new Request("https://settings.example.test/auth/sign-in", { headers: proxyHeaders }));
  assert.equal(login?.status, 200);
  const document = await login?.text();
  const loginCookie = (login?.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()[0];
  const formToken = /name="formToken" value="([A-Za-z0-9_-]+)"/u.exec(document ?? "")?.[1];
  if (loginCookie === undefined || formToken === undefined) throw new Error("Expected login challenge.");
  const form = new URLSearchParams({ formToken, password: configuredEnvironment.SETTINGS_OWNER_PASSWORD }).toString();
  const crossSite = await runtime.handle(new Request("https://settings.example.test/auth/sign-in", {
    method: "POST",
    headers: {
      ...proxyHeaders,
      cookie: loginCookie.slice(0, loginCookie.indexOf(";")),
      origin: "https://other.example.test",
      "sec-fetch-site": "cross-site",
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(form.length)
    },
    body: form
  }));
  assert.equal(crossSite?.status, 403);
  const signedIn = await runtime.handle(new Request("https://settings.example.test/auth/sign-in", {
    method: "POST",
    headers: {
      ...proxyHeaders,
      cookie: loginCookie.slice(0, loginCookie.indexOf(";")),
      origin: "https://settings.example.test",
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(form.length)
    },
    body: form
  }));
  assert.equal(signedIn?.status, 303);
  assert.equal(signedIn?.headers.get("location"), "/settings");
});

test("the owner-only runtime operation can begin Codex device authorization without exposing a credential to public routes", async () => {
  const bootstrap: RuntimeBootstrap = {
    loadCatalog: async () => undefined,
    status: async () => ({ codex: "auth_required", claude: "ready" }),
    startCodexDeviceAuthorization: async () => ({ verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" }),
    refreshCatalog: async () => ({ ok: false, code: "codex_not_ready" }),
    close: async () => {}
  };
  const runtime = createGoDaddySettingsRuntime({ ...configuredEnvironment, CAPABILITY_CATALOG_JSON: "" }, {
    createPool: () => new UnusedPool(),
    createRuntimeBootstrap: () => bootstrap,
    now: () => activeNow
  });
  const login = await runtime.handle(new Request("https://settings.example.test/auth/sign-in", { headers: originHeaders }));
  const document = await login?.text();
  const loginCookie = (login?.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()[0];
  const formToken = /name="formToken" value="([A-Za-z0-9_-]+)"/u.exec(document ?? "")?.[1];
  if (loginCookie === undefined || formToken === undefined) throw new Error("Expected login challenge.");
  const form = new URLSearchParams({ formToken, password: configuredEnvironment.SETTINGS_OWNER_PASSWORD }).toString();
  const signedIn = await runtime.handle(new Request("https://settings.example.test/auth/sign-in", {
    method: "POST",
    headers: {
      ...originHeaders,
      cookie: loginCookie.slice(0, loginCookie.indexOf(";")),
      origin: "https://settings.example.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(form.length)
    },
    body: form
  }));
  const ownerCookie = (signedIn?.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
    .find((cookie) => cookie.startsWith("__Host-personal-consultant-owner="));
  if (ownerCookie === undefined) throw new Error("Expected owner session.");
  const operation = await runtime.handle(new Request("https://settings.example.test/operations/runtime/codex", {
    method: "POST",
    headers: {
      ...originHeaders,
      cookie: ownerCookie.slice(0, ownerCookie.indexOf(";")),
      origin: "https://settings.example.test",
      "sec-fetch-site": "same-origin"
    }
  }));
  assert.equal(operation?.status, 200);
  assert.match(await operation?.text() ?? "", /ABCD-1234/);

  const wrongOrigin = await runtime.handle(new Request("https://settings.example.test/operations/runtime/codex", {
    method: "POST",
    headers: {
      ...originHeaders,
      cookie: ownerCookie.slice(0, ownerCookie.indexOf(";")),
      origin: "https://other.example.test",
      "sec-fetch-site": "cross-site"
    }
  }));
  assert.equal(wrongOrigin?.status, 403);

  const denied = await runtime.handle(new Request("https://settings.example.test/operations/runtime/codex", { method: "POST", headers: originHeaders }));
  assert.equal(denied?.status, 403);
});
