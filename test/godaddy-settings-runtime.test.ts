import assert from "node:assert/strict";
import test from "node:test";

import { GODADDY_STATE_DATABASE_ROLE, type MySqlConnection, type MySqlPool } from "../src/godaddy/mysql-storage.ts";
import { createGoDaddySettingsRuntime } from "../src/godaddy/settings-runtime.ts";
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
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
  GOOGLE_OWNER_EMAIL: "owner@example.test",
  GOOGLE_REDIRECT_URI: "https://settings.example.test/auth/google/callback",
  GOOGLE_SESSION_HMAC_KEY: "a-very-long-test-session-secret-that-is-never-a-production-secret",
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

test("GoDaddy Settings starts only Google OIDC before it opens application state", async () => {
  const runtime = createGoDaddySettingsRuntime(configuredEnvironment, {
    createPool: () => new UnusedPool(),
    now: () => activeNow
  });
  assert.equal(runtime.configured, true);

  const unknownAsset = await runtime.handle(new Request("https://settings.example.test/assets/settings.css", { headers: originHeaders }));
  assert.equal(unknownAsset?.status, 403);

  const settings = await runtime.handle(new Request("https://settings.example.test/settings", { headers: originHeaders }));
  assert.equal(settings?.status, 303);
  assert.equal(settings?.headers.get("location"), "/auth/google/start");

  const login = await runtime.handle(new Request("https://settings.example.test/auth/google/start", { headers: originHeaders }));
  assert.equal(login?.status, 303);
  assert.equal(login?.headers.get("location")?.startsWith("https://accounts.google.com/"), true);
  const cookies = (login?.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0]?.startsWith("__Host-personal-consultant-oidc="), true);
  assert.equal(cookies[0]?.includes("HttpOnly; Secure; SameSite=Lax"), true);
});
