import assert from "node:assert/strict";
import test from "node:test";

import {
  createGoogleOidcService,
  parseGoogleOidcConfiguration,
  type GoogleOidcClient
} from "../src/godaddy/google-oidc.ts";

const configuration = Object.freeze({
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  ownerEmail: "owner@example.test",
  redirectUri: "https://settings.example.test/auth/google/callback",
  sessionHmacKey: "a-very-long-test-secret-that-is-never-a-production-secret"
});

const cookiePair = (value: string): string => value.slice(0, value.indexOf(";"));

class FakeGoogleClient implements GoogleOidcClient {
  readonly #payload: Record<string, unknown>;
  authorizationOptions: Record<string, unknown> | undefined;
  tokenCall: Readonly<{ code: string; codeVerifier: string }> | undefined;

  constructor(payload: Record<string, unknown>) {
    this.#payload = payload;
  }

  generateAuthUrl(options: Record<string, unknown>): string {
    this.authorizationOptions = options;
    return `https://accounts.google.test/authorize?state=${encodeURIComponent(String(options.state))}`;
  }

  async generateCodeVerifierAsync() {
    return {
      codeVerifier: "v".repeat(64),
      codeChallenge: "c".repeat(43)
    };
  }

  async getToken(input: Readonly<{ code: string; codeVerifier: string }>) {
    this.tokenCall = input;
    return { tokens: { id_token: "verified-google-id-token" } };
  }

  async verifyIdToken() {
    return { getPayload: () => this.#payload };
  }
}

const issuedAt = new Date("2026-09-02T12:00:00.000Z");

const validPayload = (): Record<string, unknown> => ({
  iss: "https://accounts.google.com",
  aud: configuration.clientId,
  exp: Math.floor(issuedAt.getTime() / 1_000) + 300,
  nonce: "set-after-start",
  email: configuration.ownerEmail,
  email_verified: true,
  sub: "google-owner-subject"
});

test("GoDaddy Google OIDC configuration is explicit and never has an insecure callback", () => {
  assert.deepEqual(parseGoogleOidcConfiguration({}), { ok: false, code: "google_oidc_not_configured" });
  assert.deepEqual(parseGoogleOidcConfiguration({
    GOOGLE_OAUTH_CLIENT_ID: configuration.clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: configuration.clientSecret,
    GOOGLE_OWNER_EMAIL: configuration.ownerEmail,
    GOOGLE_REDIRECT_URI: "http://settings.example.test/auth/google/callback",
    GOOGLE_SESSION_HMAC_KEY: configuration.sessionHmacKey
  }), { ok: false, code: "invalid_google_oidc_configuration" });
  assert.deepEqual(parseGoogleOidcConfiguration({
    GOOGLE_OAUTH_CLIENT_ID: configuration.clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: configuration.clientSecret,
    GOOGLE_OWNER_EMAIL: configuration.ownerEmail,
    GOOGLE_REDIRECT_URI: configuration.redirectUri,
    GOOGLE_SESSION_HMAC_KEY: configuration.sessionHmacKey
  }), { ok: true, value: configuration });
});

test("GoDaddy Google OIDC grants a local owner session only after the exact verified identity returns", async () => {
  const payload = validPayload();
  const client = new FakeGoogleClient(payload);
  const oidc = createGoogleOidcService({
    configuration,
    createClient: () => client,
    now: () => issuedAt
  });

  assert.equal(await oidc.start("https://attacker.example.test"), undefined);
  const start = await oidc.start("https://settings.example.test");
  assert.notEqual(start, undefined);
  if (start === undefined || client.authorizationOptions === undefined) throw new Error("Expected a Google authorization start.");
  assert.equal(client.authorizationOptions.redirect_uri, configuration.redirectUri);
  assert.equal(client.authorizationOptions.code_challenge_method, "S256");
  assert.equal(client.authorizationOptions.scope instanceof Array, true);
  const state = client.authorizationOptions.state;
  const nonce = client.authorizationOptions.nonce;
  assert.equal(typeof state, "string");
  assert.equal(typeof nonce, "string");
  payload.nonce = nonce;

  const finish = await oidc.finish({
    cookieHeader: cookiePair(start.setCookie),
    code: "google-authorized-code",
    requestOrigin: "https://settings.example.test",
    state: state as string
  });
  assert.equal(finish.ok, true);
  assert.equal(finish.setCookie.includes("verified-google-id-token"), false);
  assert.equal(finish.setCookie.startsWith("__Host-personal-consultant-owner="), true);
  assert.equal(finish.setCookie.includes("Path=/; HttpOnly; Secure; SameSite=Lax"), true);
  assert.deepEqual(client.tokenCall, { code: "google-authorized-code", codeVerifier: "v".repeat(64) });
  assert.equal(await oidc.hasVerifiedOwner(cookiePair(finish.setCookie)), true);
});

test("GoDaddy Google OIDC fails closed for a mismatched email, nonce or state", async () => {
  for (const mutation of ["email", "nonce", "state"] as const) {
    const payload = validPayload();
    const client = new FakeGoogleClient(payload);
    const oidc = createGoogleOidcService({ configuration, createClient: () => client, now: () => issuedAt });
    const start = await oidc.start("https://settings.example.test");
    if (start === undefined || client.authorizationOptions === undefined) throw new Error("Expected a Google authorization start.");
    payload.nonce = mutation === "nonce" ? "wrong-nonce" : client.authorizationOptions.nonce;
    if (mutation === "email") payload.email = "other@example.test";
    const finish = await oidc.finish({
      cookieHeader: cookiePair(start.setCookie),
      code: "google-authorized-code",
      requestOrigin: "https://settings.example.test",
      state: mutation === "state" ? "wrong-state" : client.authorizationOptions.state as string
    });
    assert.deepEqual(finish, {
      ok: false,
      code: "access_denied",
      clearCookie: "__Host-personal-consultant-oidc=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    });
  }
});
