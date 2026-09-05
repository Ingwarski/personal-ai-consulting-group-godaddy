import assert from "node:assert/strict";
import test from "node:test";
import { MySqlKeyValueStorage } from "../src/godaddy/mysql-storage.ts";
import { OwnerAuthPool } from "./fixtures/owner-auth-pool.ts";
import type { SettingsStorage } from "../src/settings/storage.ts";

import {
  createOwnerPasswordService,
  parseOwnerPasswordConfiguration
} from "../src/godaddy/owner-password-auth.ts";

const configuration = Object.freeze({
  ownerPassword: "a-long-random-owner-secret-used-only-in-tests-1234567890",
  sessionHmacKey: "a-separate-long-session-hmac-secret-used-only-in-tests-1234567890"
});

const origin = "https://settings.example.test";
const cookiePair = (value: string): string => value.slice(0, value.indexOf(";"));
const issuedAt = new Date("2026-09-02T12:00:00.000Z");
const authStorage = (pool = new OwnerAuthPool()) => new MySqlKeyValueStorage({ executor: pool, namespace: "owner-access-v2" });

test("GoDaddy owner-password configuration requires distinct strong Secrets", () => {
  assert.deepEqual(parseOwnerPasswordConfiguration({}), { ok: false, code: "owner_password_not_configured" });
  assert.deepEqual(parseOwnerPasswordConfiguration({
    SETTINGS_OWNER_PASSWORD: "short",
    SETTINGS_SESSION_HMAC_KEY: configuration.sessionHmacKey
  }), { ok: false, code: "owner_password_not_configured" });
  assert.deepEqual(parseOwnerPasswordConfiguration({
    SETTINGS_OWNER_PASSWORD: configuration.ownerPassword,
    SETTINGS_SESSION_HMAC_KEY: configuration.sessionHmacKey
  }), { ok: true, value: configuration });
  assert.deepEqual(parseOwnerPasswordConfiguration({
    SETTINGS_OWNER_PASSWORD: configuration.ownerPassword,
    SETTINGS_SESSION_HMAC_KEY: configuration.ownerPassword
  }), { ok: false, code: "owner_password_not_configured" });
});

test("GoDaddy owner-password service issues no secret-bearing cookie and binds a completed owner session to a canonical HTTPS origin", async () => {
  const service = createOwnerPasswordService({ configuration, storage: authStorage(), now: () => issuedAt });
  const start = await service.start();
  assert.equal(start.formToken.length >= 32, true);
  assert.equal(start.setCookie.startsWith("__Host-personal-consultant-login="), true);
  assert.equal(start.setCookie.includes("HttpOnly; Secure; SameSite=Strict"), true);
  assert.equal(start.setCookie.includes(configuration.ownerPassword), false);

  const denied = await service.finish({
    cookieHeader: cookiePair(start.setCookie),
    password: "not-the-owner-secret",
    requestOrigin: origin,
    formToken: start.formToken
  });
  assert.deepEqual(denied, {
    ok: false,
    code: "access_denied",
    clearCookie: "__Host-personal-consultant-login=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
  });

  const retry = await service.start();
  const completed = await service.finish({
    cookieHeader: cookiePair(retry.setCookie),
    password: configuration.ownerPassword,
    requestOrigin: origin,
    formToken: retry.formToken
  });
  assert.equal(completed.ok, true);
  if (!completed.ok) throw new Error("Expected a valid owner session.");
  assert.equal(completed.setCookie.startsWith("__Host-personal-consultant-owner="), true);
  assert.equal(completed.setCookie.includes(configuration.ownerPassword), false);
  assert.equal(await service.hasVerifiedOwner(cookiePair(completed.setCookie)), true);
  assert.equal(await service.getVerifiedOwnerOrigin(cookiePair(completed.setCookie)), origin);

  const invalidOrigin = await service.finish({
    cookieHeader: cookiePair(start.setCookie),
    password: configuration.ownerPassword,
    requestOrigin: "http://settings.example.test",
    formToken: start.formToken
  });
  assert.equal(invalidOrigin.ok, false);
  assert.equal(await service.signOutCookie(cookiePair(completed.setCookie)), "__Host-personal-consultant-owner=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  assert.equal(await service.hasVerifiedOwner(cookiePair(completed.setCookie)), false);
});

test("GoDaddy owner session expires without a refresh path", async () => {
  let currentTime = issuedAt.getTime();
  const service = createOwnerPasswordService({ configuration, storage: authStorage(), now: () => new Date(currentTime) });
  const start = await service.start();
  const completed = await service.finish({
    cookieHeader: cookiePair(start.setCookie),
    password: configuration.ownerPassword,
    requestOrigin: origin,
    formToken: start.formToken
  });
  if (!completed.ok) throw new Error("Expected a valid owner session.");
  currentTime += 12 * 60 * 60 * 1_000 + 1_000;
  assert.equal(await service.hasVerifiedOwner(cookiePair(completed.setCookie)), false);
});

test("a login challenge is consumed once across concurrent services and restart, including a failed password", async () => {
  const pool = new OwnerAuthPool();
  const make = () => createOwnerPasswordService({ configuration, storage: authStorage(pool), now: () => issuedAt });
  const first = make();
  const start = await first.start();
  const input = { cookieHeader: cookiePair(start.setCookie), formToken: start.formToken,
    requestOrigin: origin, password: configuration.ownerPassword };
  const results = await Promise.all([first.finish(input), make().finish(input)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal((await make().finish(input)).ok, false);
  const wrong = await first.start();
  const wrongInput = { ...input, cookieHeader: cookiePair(wrong.setCookie), formToken: wrong.formToken };
  assert.equal((await first.finish({ ...wrongInput, password: "wrong" })).ok, false);
  assert.equal((await make().finish(wrongInput)).ok, false);
});

test("owner session survives a process restart, but not logout, password or signing-key rotation", async () => {
  const pool = new OwnerAuthPool();
  const make = (config = configuration) => createOwnerPasswordService({ configuration: config, storage: authStorage(pool), now: () => issuedAt });
  const service = make();
  const start = await service.start();
  const login = await service.finish({ cookieHeader: cookiePair(start.setCookie), formToken: start.formToken,
    requestOrigin: origin, password: configuration.ownerPassword });
  assert.equal(login.ok, true);
  if (!login.ok) return;
  const cookie = cookiePair(login.setCookie);
  assert.equal(await make().hasVerifiedOwner(cookie), true);
  assert.equal(await make({ ...configuration, ownerPassword: `${configuration.ownerPassword}-rotated` }).hasVerifiedOwner(cookie), false);
  assert.equal(await make({ ...configuration, sessionHmacKey: `${configuration.sessionHmacKey}-rotated` }).hasVerifiedOwner(cookie), false);
  await make().signOutCookie(cookie);
  assert.equal(await service.hasVerifiedOwner(cookie), false);
  const stored = JSON.stringify([...pool.values]);
  for (const sensitive of [configuration.ownerPassword, configuration.sessionHmacKey, cookie, start.formToken]) {
    assert.equal(stored.includes(sensitive), false);
  }
});

test("fresh login rotates the browser's old session while retaining other owner devices", async () => {
  const service = createOwnerPasswordService({ configuration, storage: authStorage(), now: () => issuedAt });
  const login = async (existingCookie = "") => {
    const start = await service.start();
    const result = await service.finish({ cookieHeader: `${cookiePair(start.setCookie)}; ${existingCookie}`,
      formToken: start.formToken, requestOrigin: origin, password: configuration.ownerPassword });
    if (!result.ok) throw new Error("Expected login");
    return cookiePair(result.setCookie);
  };
  const first = await login();
  const otherDevice = await login();
  const rotated = await login(first);
  assert.equal(await service.hasVerifiedOwner(first), false);
  assert.equal(await service.hasVerifiedOwner(rotated), true);
  assert.equal(await service.hasVerifiedOwner(otherDevice), true);
});

test("idle expiry is refreshed by activity without extending the absolute lifetime", async () => {
  let current = issuedAt.getTime();
  const service = createOwnerPasswordService({ configuration, storage: authStorage(), now: () => new Date(current) });
  const login = async () => {
    const start = await service.start();
    const result = await service.finish({ cookieHeader: cookiePair(start.setCookie), formToken: start.formToken,
      requestOrigin: origin, password: configuration.ownerPassword });
    if (!result.ok) throw new Error("Expected login");
    return cookiePair(result.setCookie);
  };
  const cookie = await login();
  for (let step = 1; step < 36; step += 1) {
    current = issuedAt.getTime() + step * 20 * 60_000;
    assert.equal(await service.hasVerifiedOwner(cookie), true);
  }
  current = issuedAt.getTime() + 12 * 60 * 60_000;
  assert.equal(await service.hasVerifiedOwner(cookie), false);
  const idleCookie = await login();
  current += 30 * 60_000;
  assert.equal(await service.hasVerifiedOwner(idleCookie), false);
});

test("password throttling survives new challenges and service restart, then permits recovery", async () => {
  const pool = new OwnerAuthPool();
  let current = issuedAt.getTime();
  const make = () => createOwnerPasswordService({ configuration, storage: authStorage(pool), now: () => new Date(current) });
  const attempt = async (password: string) => {
    const service = make();
    const start = await service.start();
    return service.finish({ cookieHeader: cookiePair(start.setCookie), formToken: start.formToken,
      requestOrigin: origin, password });
  };
  for (let index = 0; index < 5; index += 1) assert.equal((await attempt("wrong")).ok, false);
  assert.equal((await attempt(configuration.ownerPassword)).ok, false);
  current += 60_000;
  assert.equal((await attempt(configuration.ownerPassword)).ok, true);
});

test("a storage outage or corrupt authorization state fails closed", async () => {
  const pool = new OwnerAuthPool();
  const service = createOwnerPasswordService({ configuration, storage: authStorage(pool), now: () => issuedAt });
  const start = await service.start();
  const input = { cookieHeader: cookiePair(start.setCookie), formToken: start.formToken,
    requestOrigin: origin, password: configuration.ownerPassword };
  pool.values.set("owner-access-v2", JSON.stringify({ v: 2, sessions: [], consumed: {}, failures: [] }));
  await assert.rejects(service.finish(input), /Owner access state is invalid/u);
  const unavailable = createOwnerPasswordService({ configuration, now: () => issuedAt,
    storage: { get: async () => undefined, put: async () => {}, transaction: async () => { throw new Error("offline"); } } });
  await assert.rejects(unavailable.finish(input), /offline/u);
});

test("a burst of throttled challenges cannot extend cooldown by filling replay storage", async () => {
  const pool = new OwnerAuthPool();
  let current = issuedAt.getTime();
  const service = createOwnerPasswordService({ configuration, storage: authStorage(pool), now: () => new Date(current) });
  const retained = await service.start();
  const submit = (start: Awaited<ReturnType<typeof service.start>>, password: string) => service.finish({
    cookieHeader: cookiePair(start.setCookie), formToken: start.formToken, requestOrigin: origin, password
  });
  for (let index = 0; index < 600; index += 1) assert.equal((await submit(await service.start(), "wrong")).ok, false);
  const state = JSON.parse(pool.values.get("owner-access-v2")!);
  assert.equal(Object.keys(state.consumed).length < 6, true);
  current += 61_000;
  assert.equal((await submit(retained, configuration.ownerPassword)).ok, false);
  assert.equal((await submit(await service.start(), configuration.ownerPassword)).ok, true);
});

test("credential rotation releases stale session capacity immediately", async () => {
  for (const rotatedConfiguration of [
    { ...configuration, ownerPassword: `${configuration.ownerPassword}-rotated` },
    { ...configuration, sessionHmacKey: `${configuration.sessionHmacKey}-rotated` }
  ]) {
    const pool = new OwnerAuthPool();
    const make = (config = configuration) => createOwnerPasswordService({ configuration: config, storage: authStorage(pool), now: () => issuedAt });
    const login = async (service: ReturnType<typeof make>, password: string) => {
      const start = await service.start();
      return service.finish({ cookieHeader: cookiePair(start.setCookie), formToken: start.formToken, requestOrigin: origin, password });
    };
    const original = make();
    for (let index = 0; index < 16; index += 1) assert.equal((await login(original, configuration.ownerPassword)).ok, true);
    assert.equal((await login(make(rotatedConfiguration), rotatedConfiguration.ownerPassword)).ok, true);
    assert.equal(Object.keys(JSON.parse(pool.values.get("owner-access-v2")!).sessions).length, 1);
  }
});

test("challenge and idle expiry are evaluated after waiting for the authorization transaction", async () => {
  let current = issuedAt.getTime();
  let delayNextRead = false;
  const base = authStorage();
  const storage: SettingsStorage = {
    get: (key) => base.get(key), put: (key, value) => base.put(key, value),
    transaction: (operation) => base.transaction((transaction) => operation({
      get: async <T>(key: string) => {
        const result = await transaction.get<T>(key);
        if (delayNextRead) { current += 2_000; delayNextRead = false; }
        return result;
      },
      put: (key, value) => transaction.put(key, value),
      transaction: (nested) => transaction.transaction(nested)
    }))
  };
  const service = createOwnerPasswordService({ configuration, storage, now: () => new Date(current) });
  const start = await service.start();
  current += 599_000;
  delayNextRead = true;
  assert.equal((await service.finish({ cookieHeader: cookiePair(start.setCookie), formToken: start.formToken,
    requestOrigin: origin, password: configuration.ownerPassword })).ok, false);
  const fresh = await service.start();
  const completed = await service.finish({ cookieHeader: cookiePair(fresh.setCookie), formToken: fresh.formToken,
    requestOrigin: origin, password: configuration.ownerPassword });
  if (!completed.ok) throw new Error("Expected fresh login");
  current += 1_799_000;
  delayNextRead = true;
  assert.equal(await service.hasVerifiedOwner(cookiePair(completed.setCookie)), false);
});
