import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { createGoogleIdentityProvider } from "../src/godaddy/google-identity-provider.ts";

const clientId = "google-client-used-only-in-tests.apps.googleusercontent.com";
const clientSecret = "google-secret-used-only-in-tests";
const redirectUri = "https://settings.example.test/auth/google/callback";
const nonce = Buffer.alloc(32, 42).toString("base64url");
const nonceHash = createHash("sha256").update(nonce).digest("hex");
const codeVerifier = Buffer.alloc(32, 43).toString("base64url");
const code = "4/test-only-single-use-google-code";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const keysEndpoint = "https://www.googleapis.com/oauth2/v3/certs";
const keys = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const publicJwk = { ...keys.publicKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid: "test-key-1" };
const epoch = Math.floor(Date.now() / 1_000);
const identity = { issuer: "https://accounts.google.com", subject: "test-only-owner-sub", email: "owner@example.test", emailVerified: true };

const claims = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: "https://accounts.google.com", aud: clientId, azp: clientId,
  sub: identity.subject, email: identity.email, email_verified: true,
  iat: epoch, exp: epoch + 3_600, nonce, ...extra
});

function signedToken(extraClaims: Record<string, unknown> = {}, extraHeader: Record<string, unknown> = {}, privateKey = keys.privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: publicJwk.kid, ...extraHeader })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims(extraClaims))).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const json = (value: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", ...headers } });

function harness(options: {
  token?: string;
  tokenResponse?: () => Response | Promise<Response>;
  keyResponse?: () => Response | Promise<Response>;
} = {}) {
  let time = epoch;
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target === tokenEndpoint) return options.tokenResponse?.() ?? json({ id_token: options.token ?? signedToken(), access_token: "not-an-identity" });
    if (target === keysEndpoint) return options.keyResponse?.() ?? json({ keys: [publicJwk] }, { "Cache-Control": "public, max-age=60" });
    throw new Error(`Unexpected test endpoint ${target}`);
  };
  const provider = createGoogleIdentityProvider({ clientId, clientSecret, redirectUri, fetcher, now: () => new Date(time * 1_000) });
  return {
    provider, calls, setTime: (value: number) => { time = value; },
    exchange: (overrides: Partial<{ code: string; codeVerifier: string; nonceHash: string; createdAt: number }> = {}) =>
      provider.exchange({ code, codeVerifier, nonceHash, createdAt: epoch, ...overrides })
  };
}

test("Google authorization uses only fixed identity scopes, browser binding, S256 and account selection", () => {
  const { provider, calls } = harness();
  const state = Buffer.alloc(32, 44).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const url = new URL(provider.authorizationUrl({ state, nonce, codeChallenge }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email",
    prompt: "select_account", state, nonce, code_challenge: codeChallenge, code_challenge_method: "S256"
  });
  assert.equal(url.href.includes(clientSecret), false);
  assert.equal(calls.length, 0);
  assert.throws(() => provider.authorizationUrl({ state: "short", nonce, codeChallenge }), { message: "Google identity verification unavailable." });
});

test("Google provider fails closed for unsafe configuration without echoing configuration", () => {
  for (const change of [
    { clientId: "" }, { clientId: "client with spaces" }, { clientSecret: "secret with spaces" },
    { redirectUri: "http://settings.example.test/auth/google/callback" },
    { redirectUri: "https://secret@settings.example.test/auth/google/callback" },
    { redirectUri: `${redirectUri}?secret=true` }, { redirectUri: `${redirectUri}#fragment` },
    { redirectUri: "https://settings.example.test/another/callback" }
  ]) assert.throws(() => createGoogleIdentityProvider({ clientId, clientSecret, redirectUri, ...change }), { message: "Google identity verification unavailable." });
});

test("Google provider captures configuration instead of accepting later caller mutation", async () => {
  const calls: RequestInit[] = [];
  const input = {
    clientId, clientSecret, redirectUri,
    fetcher: (async (url, init = {}) => {
      calls.push(init);
      return String(url) === keysEndpoint
        ? json({ keys: [publicJwk] }, { "Cache-Control": "max-age=60" })
        : json({ id_token: signedToken() });
    }) as typeof fetch,
    now: () => new Date(epoch * 1_000)
  };
  const provider = createGoogleIdentityProvider(input);
  input.clientId = "mutated-client";
  input.clientSecret = "mutated-secret";
  input.redirectUri = "https://attacker.example/auth/google/callback";
  assert.deepEqual(await provider.exchange({ code, codeVerifier, nonceHash, createdAt: epoch }), identity);
  const posted = new URLSearchParams(calls[0]!.body as URLSearchParams);
  assert.equal(posted.get("client_id"), clientId);
  assert.equal(posted.get("client_secret"), clientSecret);
  assert.equal(posted.get("redirect_uri"), redirectUri);
});

test("Google provider verifies a locally signed ID token using trusted fixed-endpoint keys and returns identity only", async () => {
  const scenario = harness();
  assert.deepEqual(await scenario.exchange(), identity);
  assert.deepEqual(scenario.calls.map((call) => call.url), [tokenEndpoint, keysEndpoint]);
  const tokenCall = scenario.calls[0]!;
  assert.equal(tokenCall.init.method, "POST");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenCall.init.body as URLSearchParams)), {
    client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
    grant_type: "authorization_code", code, code_verifier: codeVerifier
  });
  for (const call of scenario.calls) {
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.referrerPolicy, "no-referrer");
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  assert.deepEqual(await harness({ token: signedToken({ iss: "accounts.google.com", email: "Owner@EXAMPLE.TEST", azp: undefined }) }).exchange(), identity);
});

test("Google ID token rejects wrong cryptographic headers, access tokens and untrusted signatures", async (t) => {
  const headers: Record<string, unknown>[] = [
    { alg: "none" }, { alg: "HS256" }, { alg: "ES256" }, { alg: undefined },
    { typ: "at+jwt" }, { typ: 123 }, { kid: undefined }, { kid: [] }, { kid: "" },
    { kid: "not-in-trusted-keys" }, { kid: "__proto__" }, { kid: "x".repeat(129) },
    { jku: "https://attacker.example/jwks" }, { x5u: "https://attacker.example/cert" },
    { jwk: publicJwk }, { x5c: ["attacker-certificate"] }, { crit: ["b64"] }, { b64: false }
  ];
  for (const [index, header] of headers.entries()) await t.test(`header mutation ${index + 1}`, async () => {
    assert.equal(await harness({ token: signedToken({}, header) }).exchange(), undefined);
  });
  assert.equal(await harness({ token: signedToken({}, {}, otherKeys.privateKey) }).exchange(), undefined);
  for (const token of ["access-token-is-not-id-token", "e30.e30.", "a.b.c.d", "*.*.*", "x".repeat(16_385), `${signedToken()}=`]) {
    assert.equal(await harness({ token }).exchange(), undefined);
  }
  const malformed = `${Buffer.from("{bad-json}").toString("base64url")}.${Buffer.from(JSON.stringify(claims())).toString("base64url")}.${Buffer.alloc(256).toString("base64url")}`;
  assert.equal(await harness({ token: malformed }).exchange(), undefined);
});

test("Google token claim types, owner identity prerequisites, audience, freshness and nonce are strict", async (t) => {
  const cases: [string, Record<string, unknown>][] = [
    ["wrong issuer", { iss: "https://attacker.example" }], ["issuer slash", { iss: "https://accounts.google.com/" }],
    ["issuer type", { iss: ["accounts.google.com"] }], ["wrong audience", { aud: "other-client" }],
    ["audience array", { aud: [clientId] }], ["missing audience", { aud: undefined }],
    ["wrong presenter", { azp: "other-client" }], ["null presenter", { azp: null }],
    ["unverified email", { email_verified: false }], ["string verification", { email_verified: "true" }],
    ["missing verification", { email_verified: undefined }], ["missing email", { email: undefined }],
    ["non-string email", { email: { address: identity.email } }], ["padded email", { email: ` ${identity.email}` }],
    ["empty subject", { sub: "" }], ["missing subject", { sub: undefined }], ["numeric subject", { sub: 123 }],
    ["oversize subject", { sub: "x".repeat(256) }], ["subject controls", { sub: "owner\n" }],
    ["wrong nonce", { nonce: Buffer.alloc(32, 99).toString("base64url") }], ["missing nonce", { nonce: undefined }],
    ["nonce type", { nonce: [nonce] }], ["expired now", { exp: epoch }], ["expired past", { exp: epoch - 1 }],
    ["missing expiry", { exp: undefined }], ["string expiry", { exp: `${epoch + 3_600}` }],
    ["fractional expiry", { exp: epoch + 0.5 }], ["expiry before issue", { exp: epoch + 30, iat: epoch + 60 }],
    ["issued too far ahead", { iat: epoch + 61 }], ["issued before transaction", { iat: epoch - 61 }],
    ["missing issued-at", { iat: undefined }], ["string issued-at", { iat: `${epoch}` }],
    ["fractional issued-at", { iat: epoch + 0.5 }], ["future not-before", { nbf: epoch + 1 }],
    ["not-before type", { nbf: "0" }]
  ];
  for (const [name, extra] of cases) await t.test(name, async () => {
    const scenario = harness({ token: signedToken(extra) });
    assert.equal(await scenario.exchange(), undefined);
    assert.equal(scenario.calls.length, 1, "Malformed identity must not trigger trusted key retrieval.");
  });
  assert.deepEqual(await harness({ token: signedToken({ iat: epoch - 60 }) }).exchange(), identity);
  assert.deepEqual(await harness({ token: signedToken({ iat: epoch + 60 }) }).exchange(), identity);
  assert.deepEqual(await harness({ token: signedToken({ nbf: epoch }) }).exchange(), identity);
});

test("Google code exchange validates bounded local inputs before network", async () => {
  for (const change of [
    { code: "" }, { code: "x".repeat(4_097) }, { code: "code\r\nsecret" },
    { codeVerifier: "short" }, { codeVerifier: "x".repeat(129) },
    { nonceHash: "x".repeat(64) }, { nonceHash: "" }, { createdAt: epoch + 1 },
    { createdAt: epoch - 600 }, { createdAt: NaN }, { createdAt: epoch + 0.1 }
  ]) {
    const scenario = harness();
    assert.equal(await scenario.exchange(change), undefined);
    assert.equal(scenario.calls.length, 0);
  }
});

test("Google exchange denies malformed, oversized, wrong-content and redirect token responses without retry", async (t) => {
  const factories: [string, () => Response][] = [
    ["provider error", () => json({ error: "invalid_grant", error_description: `${code} ${clientSecret}` })],
    ["error plus token", () => json({ error: "invalid_grant", id_token: signedToken() })],
    ["access token only", () => json({ access_token: signedToken() })],
    ["token type", () => json({ id_token: {} })], ["non-object JSON", () => json([])],
    ["server failure", () => new Response(clientSecret, { status: 500 })],
    ["redirect", () => Response.redirect("https://attacker.example/collect", 302)],
    ["content type", () => new Response(JSON.stringify({ id_token: signedToken() }), { headers: { "Content-Type": "text/plain" } })],
    ["invalid JSON", () => new Response("{malformed", { headers: { "Content-Type": "application/json" } })],
    ["oversize length", () => json({}, { "Content-Length": "65537" })],
    ["bad length", () => json({}, { "Content-Length": "-1" })],
    ["actual oversize", () => json({ padding: "x".repeat(65_536) })],
    ["misleading short length", () => json({ padding: "x".repeat(65_536) }, { "Content-Length": "1" })]
  ];
  for (const [name, tokenResponse] of factories) await t.test(name, async () => {
    const scenario = harness({ tokenResponse });
    assert.equal(await scenario.exchange(), undefined);
    assert.equal(scenario.calls.length, 1);
  });
  const networkFailure = harness({ tokenResponse: () => { throw new Error(`Secret-bearing upstream failure ${code} ${clientSecret}`); } });
  assert.equal(await networkFailure.exchange(), undefined);
  assert.equal(networkFailure.calls.length, 1);
});

test("Google bounded reader cancels an overflowing stream even with no Content-Length", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(65_537)); },
    cancel() { canceled = true; }
  });
  const scenario = harness({ tokenResponse: () => new Response(stream, { headers: { "Content-Type": "application/json" } }) });
  assert.equal(await scenario.exchange(), undefined);
  assert.equal(canceled, true);
});

test("Google denies a transport that claims it followed a redirect or returned a different endpoint", async () => {
  for (const property of ["redirected", "url"]) {
    const response = json({ id_token: signedToken() });
    Object.defineProperty(response, property, { value: property === "redirected" ? true : "https://attacker.example/collect" });
    const scenario = harness({ tokenResponse: () => response });
    assert.equal(await scenario.exchange(), undefined);
    assert.equal(scenario.calls.length, 1);
  }
});

test("Google keys reject malformed, duplicate, private, weak or excessive key material", async (t) => {
  const weak = generateKeyPairSync("rsa", { modulusLength: 1_024 }).publicKey.export({ format: "jwk" });
  const invalidSets: [string, unknown][] = [
    ["empty keys", { keys: [] }], ["key count", { keys: Array(17).fill(publicJwk) }],
    ["duplicate ID", { keys: [publicJwk, publicJwk] }], ["wrong type", { keys: [null] }],
    ["wrong algorithm", { keys: [{ ...publicJwk, alg: "HS256" }] }],
    ["encryption key", { keys: [{ ...publicJwk, use: "enc" }] }],
    ["non-RSA", { keys: [{ ...publicJwk, kty: "EC" }] }],
    ["missing exponent", { keys: [{ ...publicJwk, e: undefined }] }],
    ["unsafe exponent", { keys: [{ ...publicJwk, e: "AQ" }] }],
    ["invalid modulus", { keys: [{ ...publicJwk, n: "x" }] }],
    ["weak modulus", { keys: [{ ...publicJwk, ...weak }] }],
    ["private key", { keys: [{ ...publicJwk, d: "private-material" }] }],
    ["external key URL", { keys: [{ ...publicJwk, jku: "https://attacker.example/keys" }] }],
    ["wrong key operations", { keys: [{ ...publicJwk, key_ops: ["sign"] }] }]
  ];
  for (const [name, value] of invalidSets) await t.test(name, async () => {
    const scenario = harness({ keyResponse: () => json(value, { "Cache-Control": "max-age=60" }) });
    assert.equal(await scenario.exchange(), undefined);
    assert.equal(scenario.calls.length, 2);
  });
  for (const keyResponse of [
    () => Response.redirect("https://attacker.example/keys", 302),
    () => json({ keys: [publicJwk], padding: "x".repeat(65_536) }),
    () => new Response("provider keys unavailable", { status: 503 })
  ]) assert.equal(await harness({ keyResponse }).exchange(), undefined);
});

test("Google key cache honors TTL/Age, coalesces concurrency and limits unknown-key refresh", async () => {
  let currentToken = signedToken();
  let currentKey = publicJwk;
  const scenario = harness({
    tokenResponse: () => json({ id_token: currentToken }),
    keyResponse: () => json({ keys: [currentKey] }, { "Cache-Control": "max-age=60", Age: "20" })
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => scenario.exchange()));
  assert.deepEqual(results, Array(8).fill(identity));
  assert.equal(scenario.calls.filter((call) => call.url === keysEndpoint).length, 1);
  scenario.setTime(epoch + 39);
  assert.deepEqual(await scenario.exchange(), identity);
  assert.equal(scenario.calls.filter((call) => call.url === keysEndpoint).length, 1);
  scenario.setTime(epoch + 40);
  assert.deepEqual(await scenario.exchange(), identity);
  assert.equal(scenario.calls.filter((call) => call.url === keysEndpoint).length, 2);
  currentToken = signedToken({}, { kid: "rotated-key" });
  currentKey = { ...publicJwk, kid: "rotated-key" };
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => scenario.exchange())), Array(8).fill(undefined));
  assert.equal(scenario.calls.filter((call) => call.url === keysEndpoint).length, 2);
  scenario.setTime(epoch + 70);
  assert.deepEqual(await scenario.exchange(), identity);
  assert.equal(scenario.calls.filter((call) => call.url === keysEndpoint).length, 3);
});

test("Google no-store/expired keys are not reused and a new flow recovers after a bounded failure", async () => {
  let failed = true;
  const scenario = harness({ keyResponse: () => {
    if (failed) throw new Error(`${clientSecret} raw JWKS upstream error`);
    return json({ keys: [publicJwk] }, { "Cache-Control": "no-store, max-age=3600" });
  } });
  assert.equal(await scenario.exchange(), undefined);
  failed = false;
  assert.equal(await scenario.exchange(), undefined);
  assert.equal(scenario.calls.filter((call) => call.url === keysEndpoint).length, 1);
  scenario.setTime(epoch + 30);
  assert.deepEqual(await scenario.exchange(), identity);
  assert.equal(await scenario.exchange(), undefined, "no-store keys cannot be reused from a cache");
  scenario.setTime(epoch + 60);
  assert.deepEqual(await scenario.exchange(), identity);
  assert.equal(scenario.calls.filter((call) => call.url === keysEndpoint).length, 3);
});

test("Google key cache never exceeds one hour even if the provider advertises longer freshness", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: epoch * 1_000 });
  let time = epoch;
  const scenario = harness({
    tokenResponse: () => json({ id_token: signedToken({ iat: time, exp: time + 3_600 }) }),
    keyResponse: () => json({ keys: [publicJwk] }, { "Cache-Control": "max-age=86400" })
  });
  assert.deepEqual(await scenario.exchange(), identity);
  time = epoch + 3_599;
  scenario.setTime(time);
  t.mock.timers.setTime(time * 1_000);
  assert.deepEqual(await scenario.exchange({ createdAt: time }), identity);
  assert.equal(scenario.calls.filter((call) => call.url === keysEndpoint).length, 1);
  time = epoch + 3_600;
  scenario.setTime(time);
  t.mock.timers.setTime(time * 1_000);
  assert.deepEqual(await scenario.exchange({ createdAt: time }), identity);
  assert.equal(scenario.calls.filter((call) => call.url === keysEndpoint).length, 2);
});

test("Google key cache does not invent freshness from missing, conflicting or expired cache metadata", async () => {
  const headers: Record<string, string>[] = [
    {}, { "Cache-Control": "no-cache, max-age=60" }, { "Cache-Control": "max-age=60, max-age=3600" },
    { "Cache-Control": "max-age=60", Age: "60" }, { "Cache-Control": "max-age=60", Age: "invalid" }
  ];
  for (const metadata of headers) {
    const scenario = harness({ keyResponse: () => json({ keys: [publicJwk] }, metadata) });
    assert.deepEqual(await scenario.exchange(), identity);
    assert.equal(await scenario.exchange(), undefined);
    assert.equal(scenario.calls.filter((call) => call.url === keysEndpoint).length, 1);
  }
});

test("Google rechecks token expiry after a slow key fetch before returning identity", async () => {
  const scenario = harness({ token: signedToken({ exp: epoch + 1 }), keyResponse: () => {
    scenario.setTime(epoch + 1);
    return json({ keys: [publicJwk] }, { "Cache-Control": "max-age=60" });
  } });
  assert.equal(await scenario.exchange(), undefined);
});

test("Google token transport and body stalls have an overall 10-second deadline and no retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scenario = harness({ tokenResponse: () => new Promise(() => {}) });
  const result = scenario.exchange();
  t.mock.timers.tick(10_001);
  assert.equal(await result, undefined);
  assert.equal(scenario.calls.length, 1);
  assert.equal(scenario.calls[0]!.init.signal!.aborted, true);

  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  const body = harness({ tokenResponse: () => new Response(stream, { headers: { "Content-Type": "application/json" } }) });
  const stalled = body.exchange();
  await nextTurn();
  t.mock.timers.tick(10_001);
  assert.equal(await stalled, undefined);
  assert.equal(canceled, true);
});

test("Google JWKS stalls remain closed, cancel network and recover only through another exchange", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let stalled = true;
  const scenario = harness({ keyResponse: () => stalled ? new Promise<Response>(() => {}) : json({ keys: [publicJwk] }, { "Cache-Control": "max-age=60" }) });
  const result = scenario.exchange();
  await nextTurn();
  assert.equal(scenario.calls.length, 2);
  t.mock.timers.tick(10_001);
  assert.equal(await result, undefined);
  assert.equal(scenario.calls[1]!.init.signal!.aborted, true);
  stalled = false;
  scenario.setTime(epoch + 30);
  await nextTurn();
  assert.deepEqual(await scenario.exchange(), identity);
});
