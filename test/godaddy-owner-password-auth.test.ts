import assert from "node:assert/strict";
import test from "node:test";

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
});

test("GoDaddy owner-password service issues no secret-bearing cookie and accepts only a same-origin challenged sign-in", async () => {
  const service = createOwnerPasswordService({ configuration, now: () => issuedAt });
  assert.equal(await service.start("http://settings.example.test"), undefined);

  const start = await service.start(origin);
  assert.notEqual(start, undefined);
  if (start === undefined) throw new Error("Expected a password login challenge.");
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

  const completed = await service.finish({
    cookieHeader: cookiePair(start.setCookie),
    password: configuration.ownerPassword,
    requestOrigin: origin,
    formToken: start.formToken
  });
  assert.equal(completed.ok, true);
  if (!completed.ok) throw new Error("Expected a valid owner session.");
  assert.equal(completed.setCookie.startsWith("__Host-personal-consultant-owner="), true);
  assert.equal(completed.setCookie.includes(configuration.ownerPassword), false);
  assert.equal(await service.hasVerifiedOwner(cookiePair(completed.setCookie)), true);

  const crossOrigin = await service.finish({
    cookieHeader: cookiePair(start.setCookie),
    password: configuration.ownerPassword,
    requestOrigin: "https://attacker.example.test",
    formToken: start.formToken
  });
  assert.equal(crossOrigin.ok, false);
  assert.equal(service.signOutCookie(), "__Host-personal-consultant-owner=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
});

test("GoDaddy owner session expires without a refresh path", async () => {
  let currentTime = issuedAt.getTime();
  const service = createOwnerPasswordService({ configuration, now: () => new Date(currentTime) });
  const start = await service.start(origin);
  if (start === undefined) throw new Error("Expected a password login challenge.");
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
