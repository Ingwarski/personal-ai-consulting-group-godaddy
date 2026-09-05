import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import test from "node:test";
import type { SettingsStorage } from "../src/settings/storage.ts";
import type { GoogleIdentity, GoogleIdentityProvider } from "../src/godaddy/google-identity-provider.ts";
import {
  createOwnerGoogleService, parseOwnerGoogleConfiguration, GOOGLE_AUTH_STATE_KEY,
  GOOGLE_BROWSER_COOKIE, GOOGLE_TRANSACTION_COOKIE, GOOGLE_SESSION_COOKIE,
  type OwnerGoogleConfiguration
} from "../src/godaddy/owner-google-auth.ts";

const epoch = Math.floor(Date.now() / 1_000);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const configuration: OwnerGoogleConfiguration = Object.freeze({
  clientId: "google-client-only-for-tests.apps.googleusercontent.com", clientSecret: "a-google-client-secret-only-for-tests",
  publicOrigin: "https://settings.example.test", ownerEmail: "owner@gmail.com",
  sessionHmacKey: "a-separate-session-signing-secret-only-for-tests",
  csrfHmacKey: "a-separate-cross-site-request-secret-only-for-tests",
  transactionKey: "a-separate-encrypted-transaction-secret-only-for-tests"
});
const owner: GoogleIdentity = Object.freeze({ issuer: "https://accounts.google.com", subject: "test-only-stable-google-subject", email: configuration.ownerEmail, emailVerified: true });
const environment = {
  SETTINGS_OWNER_ENABLED: "true", GOOGLE_CLIENT_ID: configuration.clientId, GOOGLE_CLIENT_SECRET: configuration.clientSecret,
  SETTINGS_PUBLIC_ORIGIN: configuration.publicOrigin, SETTINGS_OWNER_GOOGLE_EMAIL: configuration.ownerEmail,
  SETTINGS_SESSION_HMAC_KEY: configuration.sessionHmacKey, SETTINGS_CSRF_HMAC_KEY: configuration.csrfHmacKey,
  SETTINGS_OAUTH_TRANSACTION_KEY: configuration.transactionKey
};

test("malformed Google client secret fails configuration before constructing the provider", () => {
  for (const value of [" ".repeat(40), configuration.clientSecret + "\n", "before\u0000after".repeat(4)]) {
    assert.equal(parseOwnerGoogleConfiguration({ ...environment, GOOGLE_CLIENT_SECRET: value }).ok, false);
  }
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Serialized, rollback-capable credential-free adapter. It cannot access app namespaces. */
class AtomicAuthStorage implements SettingsStorage {
  data = new Map<string, unknown>();
  locked = 0;
  commits = 0;
  failNextCommit = false;
  #tail = Promise.resolve();
  #context = new AsyncLocalStorage<boolean>();
  inTransaction() { return this.#context.getStore() === true; }
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.data.get(key)) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> {
    assert.equal(key, GOOGLE_AUTH_STATE_KEY);
    this.data.set(key, structuredClone(value));
  }
  async transaction<T>(operation: (storage: SettingsStorage) => Promise<T>): Promise<T> {
    const prior = this.#tail;
    const released = deferred();
    this.#tail = released.promise;
    await prior;
    this.locked += 1;
    const working = structuredClone(this.data);
    const scoped: SettingsStorage = {
      get: async <V>(key: string) => { assert.equal(key, GOOGLE_AUTH_STATE_KEY); return structuredClone(working.get(key)) as V | undefined; },
      put: async <V>(key: string, value: V) => { assert.equal(key, GOOGLE_AUTH_STATE_KEY); working.set(key, structuredClone(value)); },
      transaction: async <V>(nested: (storage: SettingsStorage) => Promise<V>) => nested(scoped)
    };
    try {
      const result = await this.#context.run(true, () => operation(scoped));
      if (this.failNextCommit) { this.failNextCommit = false; throw new Error("Injected auth transaction commit failure."); }
      this.data = working;
      this.commits += 1;
      return result;
    } finally {
      this.locked -= 1;
      released.resolve();
    }
  }
  async hold(): Promise<() => Promise<void>> {
    const entered = deferred();
    const released = deferred();
    const held = this.transaction(async () => { entered.resolve(); await released.promise; });
    await entered.promise;
    return async () => { released.resolve(); await held; };
  }
  snapshot(): any { return structuredClone(this.data.get(GOOGLE_AUTH_STATE_KEY)); }
}

class CookieJar {
  values = new Map<string, string>();
  apply(value: string) {
    const pair = value.split(";", 1)[0]!;
    const equals = pair.indexOf("=");
    const key = pair.slice(0, equals);
    if (value.includes("Max-Age=0")) this.values.delete(key);
    else this.values.set(key, pair.slice(equals + 1));
  }
  applyAll(values: readonly string[]) { values.forEach((value) => this.apply(value)); }
  header() { return [...this.values].map(([key, value]) => `${key}=${value}`).join("; "); }
  copy() { const result = new CookieJar(); result.values = new Map(this.values); return result; }
}

function harness(options: { storage?: AtomicAuthStorage; configuration?: OwnerGoogleConfiguration; time?: { value: number } } = {}) {
  const storage = options.storage ?? new AtomicAuthStorage();
  const time = options.time ?? { value: epoch };
  const starts: Parameters<GoogleIdentityProvider["authorizationUrl"]>[0][] = [];
  const exchanges: Parameters<GoogleIdentityProvider["exchange"]>[0][] = [];
  let exchange: GoogleIdentityProvider["exchange"] = async () => owner;
  const provider: GoogleIdentityProvider = {
    authorizationUrl: (input) => {
      starts.push(input);
      return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(input).toString()}`;
    },
    exchange: async (input) => {
      assert.equal(storage.inTransaction(), false, "Google network must run after its durable claim commit without holding that database lock.");
      exchanges.push(input);
      return exchange(input);
    }
  };
  const make = (config = options.configuration ?? configuration) => createOwnerGoogleService({ configuration: config, storage, provider, now: () => new Date(time.value * 1_000) });
  return { service: make(), make, storage, time, starts, exchanges, setExchange: (value: GoogleIdentityProvider["exchange"]) => { exchange = value; } };
}
type Service = ReturnType<typeof createOwnerGoogleService>;

async function begin(service: Service, jar = new CookieJar()) {
  const entry = await service.entry(jar.header());
  jar.apply(entry.setCookie);
  const started = await service.start({ cookieHeader: jar.header(), formToken: entry.formToken });
  assert.equal(started.ok, true, "Expected a valid explicit owner sign-in start.");
  if (!started.ok) throw new Error("Test sign-in could not start.");
  jar.applyAll(started.cookies);
  const state = new URL(started.location).searchParams.get("state")!;
  return { jar, state, parameters: () => new URLSearchParams({ state, code: "test-only-authorization-code" }) };
}

async function login(service: Service, jar = new CookieJar()) {
  const flow = await begin(service, jar);
  const result = await service.finish({ cookieHeader: jar.header(), parameters: flow.parameters() });
  assert.equal(result.ok, true, "Expected the exact allowed owner to establish a local session.");
  jar.applyAll(result.cookies);
  return jar;
}

test("Google owner configuration requires explicit enablement, exact Gmail and separate protected configuration", () => {
  assert.deepEqual(parseOwnerGoogleConfiguration(environment), { ok: true, value: configuration });
  const normalized = parseOwnerGoogleConfiguration({ ...environment, SETTINGS_OWNER_GOOGLE_EMAIL: " Owner.Name+tag@GMAIL.COM " });
  assert.equal(normalized.ok, true);
  if (normalized.ok) assert.equal(normalized.value.ownerEmail, "owner.name+tag@gmail.com", "Do not strip dots or plus aliases.");
  for (const change of [
    { SETTINGS_OWNER_ENABLED: undefined }, { SETTINGS_OWNER_ENABLED: "false" }, { SETTINGS_OWNER_ENABLED: true },
    { GOOGLE_CLIENT_ID: "bad-client" }, { GOOGLE_CLIENT_SECRET: "short" }, { SETTINGS_OWNER_GOOGLE_EMAIL: "owner@example.test" },
    { SETTINGS_OWNER_GOOGLE_EMAIL: "owner@gmail.com.attacker.test" }, { SETTINGS_PUBLIC_ORIGIN: "http://settings.example.test" },
    { SETTINGS_PUBLIC_ORIGIN: "https://settings.example.test/" }, { SETTINGS_PUBLIC_ORIGIN: "https://x:secret@settings.example.test" },
    { SETTINGS_SESSION_HMAC_KEY: "short" }, { SETTINGS_CSRF_HMAC_KEY: configuration.sessionHmacKey },
    { SETTINGS_OAUTH_TRANSACTION_KEY: configuration.csrfHmacKey }
  ]) assert.deepEqual(parseOwnerGoogleConfiguration({ ...environment, ...change }), { ok: false, code: "owner_google_not_configured" });
});

test("Google owner flow persists only hashed bindings and AEAD-encrypted verifier, then a separate local session", async () => {
  const h = harness();
  const flow = await begin(h.service);
  const pending = h.storage.snapshot();
  const serialized = JSON.stringify(pending);
  const authorization = h.starts[0]!;
  assert.equal(pending.transactions.length, 1);
  assert.equal(pending.transactions[0].stateHash, hash(flow.state));
  assert.equal(pending.transactions[0].nonceHash, hash(authorization.nonce));
  assert.match(pending.transactions[0].verifierCiphertext, /^[A-Za-z0-9_-]{95}$/u);
  for (const secret of [flow.state, authorization.nonce, configuration.clientSecret, configuration.sessionHmacKey, configuration.csrfHmacKey,
    configuration.transactionKey, owner.email, owner.subject]) assert.equal(serialized.includes(secret), false);
  assert.equal(await h.service.getVerifiedOwner(flow.jar.header()), undefined);
  const result = await h.service.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() });
  assert.equal(result.ok, true);
  assert.equal(h.exchanges.length, 1);
  assert.equal(createHash("sha256").update(h.exchanges[0]!.codeVerifier).digest("base64url"), authorization.codeChallenge);
  assert.equal(serialized.includes(h.exchanges[0]!.codeVerifier), false);
  flow.jar.applyAll(result.cookies);
  const verified = await h.service.getVerifiedOwner(flow.jar.header());
  assert.equal(verified?.origin, configuration.publicOrigin);
  assert.match(verified!.csrfAudience, /^owner-google-settings-v1:/u);
  for (const header of result.cookies) {
    assert.ok(header.includes("Path=/; Secure; HttpOnly; SameSite=Lax;"));
    assert.equal(header.includes("Domain="), false);
    assert.equal(header.includes(owner.email), false);
    assert.equal(header.includes(owner.subject), false);
  }
  const complete = h.storage.snapshot();
  assert.equal(complete.sessions.length, 1);
  assert.equal(complete.owner, hash(`https://accounts.google.com:${owner.subject}`));
  assert.equal(JSON.stringify(complete).includes(h.exchanges[0]!.codeVerifier), false);
  assert.equal(JSON.stringify(complete).includes("test-only-authorization-code"), false);
});

test("Google owner start rejects missing, wrong, duplicate, tampered and expired browser-intent bindings", async () => {
  const h = harness();
  const entry = await h.service.entry(null);
  const jar = new CookieJar(); jar.apply(entry.setCookie);
  for (const request of [
    { cookieHeader: null, formToken: entry.formToken }, { cookieHeader: jar.header(), formToken: "wrong" },
    { cookieHeader: `${jar.header()}; ${jar.header()}`, formToken: entry.formToken },
    { cookieHeader: `${jar.header()}tampered`, formToken: entry.formToken },
    { cookieHeader: `${GOOGLE_BROWSER_COOKIE}=${"x".repeat(16_385)}`, formToken: entry.formToken }
  ]) assert.equal((await h.service.start(request)).ok, false);
  h.time.value += 600;
  assert.equal((await h.service.start({ cookieHeader: jar.header(), formToken: entry.formToken })).ok, false);
  assert.equal(h.starts.length, 0);
  assert.equal(h.exchanges.length, 0);
});

test("Google callback accepts its RFC 9207 issuer metadata without bypassing owner verification", async () => {
  const h = harness();
  const flow = await begin(h.service);
  const parameters = flow.parameters();
  parameters.set("iss", "https://accounts.google.com");
  parameters.set("scope", "openid email");
  parameters.set("authuser", "0");
  parameters.set("prompt", "none");
  const result = await h.service.finish({ cookieHeader: flow.jar.header(), parameters });
  assert.equal(result.ok, true);
  assert.equal(h.exchanges.length, 1);
  flow.jar.applyAll(result.cookies);
  assert.ok(await h.service.getVerifiedOwner(flow.jar.header()));

  const rejected = harness();
  rejected.setExchange(async () => undefined);
  const attempt = await begin(rejected.service);
  const unverified = attempt.parameters();
  unverified.set("iss", "https://accounts.google.com");
  assert.equal((await rejected.service.finish({ cookieHeader: attempt.jar.header(), parameters: unverified })).ok, false);
  assert.equal(rejected.exchanges.length, 1);
  assert.equal(rejected.storage.snapshot().sessions.length, 0);
});

test("Google callback rejects non-exact or duplicate issuer metadata before exchange", async (t) => {
  for (const issuer of ["", "accounts.google.com", "http://accounts.google.com", "https://accounts.google.com/",
    "https://accounts.google.com.attacker.test", "https://accounts.google.com?ignored=true", "https://ACCOUNTS.GOOGLE.COM"]) {
    await t.test(`reject issuer ${JSON.stringify(issuer)}`, async () => {
      const h = harness(); const flow = await begin(h.service); const parameters = flow.parameters();
      parameters.set("iss", issuer);
      assert.equal((await h.service.finish({ cookieHeader: flow.jar.header(), parameters })).ok, false);
      assert.equal(h.exchanges.length, 0);
      assert.equal(h.storage.snapshot().sessions.length, 0);
    });
  }
  const h = harness(); const flow = await begin(h.service); const parameters = flow.parameters();
  parameters.append("iss", "https://accounts.google.com");
  parameters.append("iss", "https://accounts.google.com");
  assert.equal((await h.service.finish({ cookieHeader: flow.jar.header(), parameters })).ok, false);
  assert.equal(h.exchanges.length, 0);
});

test("Google cancellation with issuer metadata consumes its transaction without token exchange", async () => {
  const h = harness(); const flow = await begin(h.service);
  const parameters = new URLSearchParams({ state: flow.state, error: "access_denied", iss: "https://accounts.google.com" });
  assert.equal((await h.service.finish({ cookieHeader: flow.jar.header(), parameters })).ok, false);
  assert.equal(h.exchanges.length, 0);
  const retry = flow.parameters(); retry.set("iss", "https://accounts.google.com");
  assert.equal((await h.service.finish({ cookieHeader: flow.jar.header(), parameters: retry })).ok, false);
  assert.equal(h.exchanges.length, 0);
});

test("Google callback rejects invalid protocol parameters without exchanging a token", async (t) => {
  const cases: [string, (parameters: URLSearchParams) => void][] = [
    ["duplicate state", (p) => p.append("state", p.get("state")!)], ["duplicate code", (p) => p.append("code", "second")],
    ["missing state", (p) => p.delete("state")], ["missing code and error", (p) => p.delete("code")],
    ["code and error", (p) => p.set("error", "access_denied")], ["unknown field", (p) => p.set("redirect_uri", "https://attacker.test")],
    ["oversized code", (p) => p.set("code", "x".repeat(4_097))], ["code whitespace", (p) => p.set("code", "bad code")],
    ["oversized response", (p) => p.set("scope", "x".repeat(8_193))], ["wrong state format", (p) => p.set("state", "bad-state")],
    ["duplicate optional metadata", (p) => { p.append("scope", "openid"); p.append("scope", "email"); }]
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const h = harness(); const flow = await begin(h.service); const parameters = flow.parameters(); mutate(parameters);
    const denied = await h.service.finish({ cookieHeader: flow.jar.header(), parameters });
    assert.equal(denied.ok, false); assert.equal(h.exchanges.length, 0);
    assert.deepEqual(denied.cookies, [`${GOOGLE_TRANSACTION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`]);
  });
});

test("Google callback state and transaction binding cannot move across browsers or be supplied twice", async () => {
  for (const mutate of [
    (jar: CookieJar) => { jar.values.delete(GOOGLE_BROWSER_COOKIE); },
    (jar: CookieJar) => { jar.values.delete(GOOGLE_TRANSACTION_COOKIE); },
    (jar: CookieJar) => { jar.values.set(GOOGLE_TRANSACTION_COOKIE, `${jar.values.get(GOOGLE_TRANSACTION_COOKIE)}x`); }
  ]) {
    const h = harness(); const flow = await begin(h.service); mutate(flow.jar);
    assert.equal((await h.service.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() })).ok, false);
    assert.equal(h.exchanges.length, 0);
  }
  const h = harness(); const one = await begin(h.service); const two = await begin(h.service);
  assert.equal((await h.service.finish({ cookieHeader: two.jar.header(), parameters: one.parameters() })).ok, false);
  assert.equal((await h.service.finish({ cookieHeader: `${one.jar.header()}; ${GOOGLE_TRANSACTION_COOKIE}=${one.jar.values.get(GOOGLE_TRANSACTION_COOKIE)}`, parameters: one.parameters() })).ok, false);
  assert.equal(h.exchanges.length, 0);
});

test("Google cancel consumes its transaction, creates no grant and permits a fresh retry", async () => {
  const h = harness(); const flow = await begin(h.service);
  const denied = await h.service.finish({ cookieHeader: flow.jar.header(), parameters: new URLSearchParams({ state: flow.state, error: "access_denied" }) });
  assert.equal(denied.ok, false); assert.equal(h.exchanges.length, 0);
  assert.equal((await h.service.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() })).ok, false);
  assert.equal(h.exchanges.length, 0);
  flow.jar.applyAll(denied.cookies);
  const retry = await login(h.service, flow.jar);
  assert.ok(await h.service.getVerifiedOwner(retry.header()));
});

test("Concurrent Google callbacks commit one claim before exchange and deny replay after restart", async () => {
  const h = harness(); const flow = await begin(h.service);
  const waiting = deferred<GoogleIdentity | undefined>(); const started = deferred();
  h.setExchange(async () => { started.resolve(); return waiting.promise; });
  const first = h.service.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() });
  await started.promise;
  assert.equal(h.storage.snapshot().transactions[0].status, "claimed");
  const restarted = h.make();
  const replay = await restarted.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() });
  assert.equal(replay.ok, false); assert.equal(h.exchanges.length, 1);
  waiting.resolve(owner);
  const completed = await first;
  assert.equal(completed.ok, true);
  assert.equal((await restarted.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() })).ok, false);
  flow.jar.applyAll(completed.cookies);
  assert.ok(await restarted.getVerifiedOwner(flow.jar.header()));
  assert.equal(h.storage.snapshot().sessions.length, 1);
});

test("Google provider timeout/error consumes the claim without leaking errors or retrying the code", async () => {
  const h = harness(); const flow = await begin(h.service);
  h.setExchange(async () => { throw new Error(`secret-bearing provider error ${configuration.clientSecret}`); });
  const denied = await h.service.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() });
  assert.equal(denied.ok, false);
  assert.equal(JSON.stringify(denied).includes(configuration.clientSecret), false);
  assert.equal((await h.make().finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() })).ok, false);
  assert.equal(h.exchanges.length, 1);
});

test("Google transactions expire after lock wait and after network verification, without a late grant", async () => {
  const before = harness(); const flow = await begin(before.service);
  const release = await before.storage.hold();
  const delayed = before.service.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() });
  before.time.value += 600;
  await release();
  assert.equal((await delayed).ok, false); assert.equal(before.exchanges.length, 0);
  const after = harness(); const second = await begin(after.service);
  after.setExchange(async () => { after.time.value += 600; return owner; });
  assert.equal((await after.service.finish({ cookieHeader: second.jar.header(), parameters: second.parameters() })).ok, false);
  assert.equal(after.storage.snapshot().sessions.length, 0);
});

test("Only the preallowed verified email may bind the owner, and a different subject cannot rebind", async () => {
  const h = harness();
  for (const identity of [
    { ...owner, email: "someone@gmail.com" }, { ...owner, email: "owner+alias@gmail.com" },
    { ...owner, email: "o.wner@gmail.com" }, { ...owner, emailVerified: false },
    { ...owner, issuer: "https://attacker.test" }, { ...owner, subject: "" }
  ]) {
    h.setExchange(async () => identity as GoogleIdentity);
    const flow = await begin(h.service);
    assert.equal((await h.service.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() })).ok, false);
    assert.equal(h.storage.snapshot().owner, undefined);
  }
  h.setExchange(async () => owner); const valid = await login(h.service);
  assert.ok(await h.service.getVerifiedOwner(valid.header()));
  const ownerHash = h.storage.snapshot().owner;
  h.setExchange(async () => ({ ...owner, subject: "another-subject-with-same-email" }));
  const attempt = await begin(h.service);
  assert.equal((await h.service.finish({ cookieHeader: attempt.jar.header(), parameters: attempt.parameters() })).ok, false);
  assert.equal(h.storage.snapshot().owner, ownerHash);
  assert.ok(await h.service.getVerifiedOwner(valid.header()));
});

test("Malformed provider identity fails closed as a sanitized denial", async () => {
  for (const identity of [null, {}, { ...owner, email: undefined }, { ...owner, email: [] }, { ...owner, issuer: [] }]) {
    const h = harness(); const flow = await begin(h.service);
    h.setExchange(async () => identity as unknown as GoogleIdentity);
    const result = await h.service.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() });
    assert.equal(result.ok, false);
    assert.equal(h.storage.snapshot().sessions.length, 0);
  }
});

test("Google relogin rotates the browser session; logout revokes only that browser durably", async () => {
  const h = harness(); const first = await login(h.service); const oldHeader = first.header();
  const second = await login(h.service);
  await login(h.service, first);
  assert.equal(await h.service.getVerifiedOwner(oldHeader), undefined);
  assert.ok(await h.service.getVerifiedOwner(first.header()));
  assert.ok(await h.service.getVerifiedOwner(second.header()));
  assert.equal(h.storage.snapshot().sessions.length, 2);
  const clear = await h.service.signOut(first.header());
  assert.ok(clear.includes(`${GOOGLE_SESSION_COOKIE}=`));
  assert.ok(clear.includes("Max-Age=0"));
  assert.equal(await h.make().getVerifiedOwner(first.header()), undefined);
  assert.ok(await h.make().getVerifiedOwner(second.header()));
});

test("Revocation invalidates every session and in-flight claim, while unauthenticated revocation does not", async () => {
  const h = harness(); const first = await login(h.service); const second = await login(h.service);
  await h.service.revokeAll(null);
  assert.ok(await h.service.getVerifiedOwner(first.header()));
  const flow = await begin(h.service); const waiting = deferred<GoogleIdentity | undefined>(); const started = deferred();
  h.setExchange(async () => { started.resolve(); return waiting.promise; });
  const completion = h.service.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() });
  await started.promise;
  await h.service.revokeAll(first.header());
  waiting.resolve(owner);
  assert.equal((await completion).ok, false);
  const restarted = h.make();
  assert.equal(await restarted.getVerifiedOwner(first.header()), undefined);
  assert.equal(await restarted.getVerifiedOwner(second.header()), undefined);
  h.setExchange(async () => owner);
  assert.ok(await restarted.getVerifiedOwner((await login(restarted)).header()));
});

test("Google idle and absolute session expiry use fresh time after obtaining the database lock", async () => {
  const h = harness(); const jar = await login(h.service);
  const release = await h.storage.hold();
  const verification = h.service.getVerifiedOwner(jar.header());
  h.time.value += 1_800;
  await release();
  assert.equal(await verification, undefined);
  const absolute = harness(); const active = await login(absolute.service);
  for (let elapsed = 1_799; elapsed < 43_200; elapsed += 1_799) {
    absolute.time.value = epoch + elapsed;
    assert.ok(await absolute.service.getVerifiedOwner(active.header()));
  }
  absolute.time.value = epoch + 43_200;
  assert.equal(await absolute.service.getVerifiedOwner(active.header()), undefined);
});

test("Google session cap rejects a seventeenth browser without evicting existing sessions", async () => {
  const h = harness(); const jars: CookieJar[] = [];
  for (let index = 0; index < 16; index += 1) jars.push(await login(h.service));
  const attempt = await begin(h.service);
  assert.equal((await h.service.finish({ cookieHeader: attempt.jar.header(), parameters: attempt.parameters() })).ok, false);
  assert.equal(h.storage.snapshot().sessions.length, 16);
  for (const jar of jars) assert.ok(await h.service.getVerifiedOwner(jar.header()));
  await login(h.service, jars[0]);
  assert.equal(h.storage.snapshot().sessions.length, 16);
  await h.service.signOut(jars[1]!.header());
  const fresh = await login(h.service);
  assert.ok(await h.service.getVerifiedOwner(fresh.header()));
  assert.equal(h.storage.snapshot().sessions.length, 16);
});

test("Google session/config generation invalidates existing sessions and pending callbacks but preserves stable subject binding", async () => {
  for (const change of [
    { clientId: "rotated-google-client.apps.googleusercontent.com" }, { clientSecret: "rotated-google-client-secret-only-for-tests" },
    { publicOrigin: "https://other.example.test" }, { sessionHmacKey: "rotated-session-signing-secret-only-for-tests" },
    { csrfHmacKey: "rotated-cross-site-request-secret-only-for-tests" }, { transactionKey: "rotated-encrypted-transaction-secret-only-for-tests" }
  ]) {
    const h = harness(); const jar = await login(h.service); const flow = await begin(h.service);
    const changed = h.make({ ...configuration, ...change });
    assert.equal(await changed.getVerifiedOwner(jar.header()), undefined);
    assert.equal((await changed.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() })).ok, false);
    h.setExchange(async () => ({ ...owner, subject: "replacement-subject" }));
    const unauthorized = await begin(changed);
    assert.equal((await changed.finish({ cookieHeader: unauthorized.jar.header(), parameters: unauthorized.parameters() })).ok, false);
    h.setExchange(async () => owner);
    assert.ok(await changed.getVerifiedOwner((await login(changed)).header()));
  }
});

test("A callback from an old configuration cannot erase a new configuration's sessions after its network wait", async () => {
  const h = harness(); const oldFlow = await begin(h.service);
  const started = deferred(); const waiting = deferred<GoogleIdentity | undefined>();
  h.setExchange(async () => { started.resolve(); return waiting.promise; });
  const staleCompletion = h.service.finish({ cookieHeader: oldFlow.jar.header(), parameters: oldFlow.parameters() });
  await started.promise;
  const changed = h.make({ ...configuration, sessionHmacKey: "a-rotated-session-key-only-for-this-test" });
  h.setExchange(async () => owner);
  const currentSession = await login(changed);
  assert.ok(await changed.getVerifiedOwner(currentSession.header()));
  const currentGeneration = h.storage.snapshot().generation;
  waiting.resolve(owner);
  assert.equal((await staleCompletion).ok, false);
  assert.equal(h.storage.snapshot().generation, currentGeneration);
  assert.ok(await changed.getVerifiedOwner(currentSession.header()));
});

test("An explicit allowed-email configuration change retires old access and binds only the newly allowed owner", async () => {
  const h = harness(); const previous = await login(h.service);
  const changed = h.make({ ...configuration, ownerEmail: "new-allowed-owner@gmail.com" });
  const oldAttempt = await begin(changed);
  assert.equal((await changed.finish({ cookieHeader: oldAttempt.jar.header(), parameters: oldAttempt.parameters() })).ok, false);
  assert.equal(h.storage.snapshot().owner, undefined);
  assert.equal(await changed.getVerifiedOwner(previous.header()), undefined);
  h.setExchange(async () => ({ ...owner, email: "new-allowed-owner@gmail.com", subject: "new-allowed-subject" }));
  const current = await login(changed);
  assert.ok(await changed.getVerifiedOwner(current.header()));
  assert.equal(h.storage.snapshot().owner, hash("https://accounts.google.com:new-allowed-subject"));
  assert.equal(await h.service.getVerifiedOwner(previous.header()), undefined);
  assert.ok(await changed.getVerifiedOwner(current.header()));
});

test("Stale service reads, logout, revocation, callback and start never roll back a newly activated configuration", async (t) => {
  for (const action of ["read", "logout", "revoke", "callback", "start"] as const) await t.test(action, async () => {
    const h = harness(); const staleSession = await login(h.service); const staleFlow = await begin(h.service);
    const entry = await h.service.entry(staleSession.header()); staleSession.apply(entry.setCookie);
    const changed = h.make({ ...configuration, sessionHmacKey: "a-rotated-session-key-only-for-this-test" });
    const current = await login(changed); const saved = h.storage.snapshot();
    if (action === "read") assert.equal(await h.service.getVerifiedOwner(staleSession.header()), undefined);
    if (action === "logout") await h.service.signOut(staleSession.header());
    if (action === "revoke") await h.service.revokeAll(staleSession.header());
    if (action === "callback") assert.equal((await h.service.finish({ cookieHeader: staleFlow.jar.header(), parameters: staleFlow.parameters() })).ok, false);
    if (action === "start") assert.equal((await h.service.start({ cookieHeader: staleSession.header(), formToken: entry.formToken })).ok, false);
    assert.deepEqual(h.storage.snapshot(), saved, "A stale service operation must not write its retired generation.");
    assert.ok(await changed.getVerifiedOwner(current.header()));
  });
});

test("Mutating a caller's configuration object cannot silently change the active owner boundary", async () => {
  const mutable = { ...configuration };
  const h = harness({ configuration: mutable });
  const jar = await login(h.service);
  mutable.ownerEmail = "different-owner@gmail.com";
  mutable.publicOrigin = "https://attacker.example.test";
  mutable.sessionHmacKey = "mutated-session-key-only-for-tests";
  const current = await h.service.getVerifiedOwner(jar.header());
  assert.equal(current?.origin, configuration.publicOrigin);
  const flow = await begin(h.service);
  assert.equal((await h.service.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() })).ok, true);
});

test("Failed configuration-activation commit rolls back and allows a retry without restarting the process", async () => {
  const h = harness(); await login(h.service);
  const changed = h.make({ ...configuration, sessionHmacKey: "a-rotated-session-key-only-for-this-test" });
  const entry = await changed.entry(null); const jar = new CookieJar(); jar.apply(entry.setCookie);
  const before = h.storage.snapshot();
  h.storage.failNextCommit = true;
  await assert.rejects(changed.start({ cookieHeader: jar.header(), formToken: entry.formToken }), /Injected auth transaction commit failure/u);
  assert.deepEqual(h.storage.snapshot(), before);
  const retried = await changed.start({ cookieHeader: jar.header(), formToken: entry.formToken });
  assert.equal(retried.ok, true, "A rolled-back activation cannot permanently latch the process into a stale state.");
  if (!retried.ok) throw new Error("Expected activation retry.");
  jar.applyAll(retried.cookies);
  const state = new URL(retried.location).searchParams.get("state")!;
  const completed = await changed.finish({ cookieHeader: jar.header(), parameters: new URLSearchParams({ state, code: "retry-code" }) });
  assert.equal(completed.ok, true);
  jar.applyAll(completed.cookies);
  assert.ok(await changed.getVerifiedOwner(jar.header()));
});

test("Concurrent first-owner binding allows exactly one verified stable subject", async () => {
  const h = harness(); const one = await begin(h.service); const two = await begin(h.service);
  const firstWaiting = deferred<GoogleIdentity | undefined>(); const secondWaiting = deferred<GoogleIdentity | undefined>();
  const firstStarted = deferred(); const secondStarted = deferred();
  h.setExchange(async ({ code }) => {
    if (code === "one") { firstStarted.resolve(); return firstWaiting.promise; }
    secondStarted.resolve(); return secondWaiting.promise;
  });
  const firstParams = one.parameters(); firstParams.set("code", "one");
  const secondParams = two.parameters(); secondParams.set("code", "two");
  const first = h.service.finish({ cookieHeader: one.jar.header(), parameters: firstParams });
  const second = h.make().finish({ cookieHeader: two.jar.header(), parameters: secondParams });
  await Promise.all([firstStarted.promise, secondStarted.promise]);
  firstWaiting.resolve(owner); assert.equal((await first).ok, true);
  secondWaiting.resolve({ ...owner, subject: "a-different-verified-subject" });
  assert.equal((await second).ok, false);
  assert.equal(h.storage.snapshot().owner, hash(`https://accounts.google.com:${owner.subject}`));
  assert.equal(h.storage.snapshot().sessions.length, 1);
});

test("Concurrent logins cannot overbook the last session slot", async () => {
  const h = harness();
  for (let count = 0; count < 15; count += 1) await login(h.service);
  const first = await begin(h.service); const second = await begin(h.service);
  const results = await Promise.all([
    h.service.finish({ cookieHeader: first.jar.header(), parameters: first.parameters() }),
    h.make().finish({ cookieHeader: second.jar.header(), parameters: second.parameters() })
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(h.storage.snapshot().sessions.length, 16);
});

test("Late logout from a rotated session cannot revoke the new browser session", async () => {
  const h = harness(); const jar = await login(h.service); const retired = jar.header();
  await login(h.service, jar);
  await h.service.signOut(retired);
  assert.ok(await h.service.getVerifiedOwner(jar.header()));
  assert.equal(h.storage.snapshot().sessions.length, 1);
});

test("A successful provider response cannot outlive transaction expiry while waiting for final commit", async () => {
  const h = harness(); const flow = await begin(h.service);
  const locked = deferred(); let release!: () => Promise<void>;
  h.setExchange(async () => { release = await h.storage.hold(); locked.resolve(); return owner; });
  const finishing = h.service.finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() });
  await locked.promise;
  h.time.value += 600;
  await release();
  assert.equal((await finishing).ok, false);
  assert.equal(h.storage.snapshot().sessions.length, 0);
});

test("Google action tokens bind purpose, current session, expiry, rotation and durable revocation", async () => {
  const h = harness(); const one = await login(h.service); const two = await login(h.service);
  assert.equal(await h.service.issueActionToken(null, "logout"), undefined);
  const token = await h.service.issueActionToken(one.header(), "logout"); assert.ok(token);
  assert.equal(await h.service.verifyActionToken(one.header(), "logout", token), true);
  assert.equal(await h.service.verifyActionToken(one.header(), "revoke", token), false);
  assert.equal(await h.service.verifyActionToken(two.header(), "logout", token), false);
  assert.equal(await h.service.verifyActionToken(one.header(), "logout", `${token}x`), false);
  h.time.value += 600;
  assert.equal(await h.service.verifyActionToken(one.header(), "logout", token), false);
  const current = await h.service.issueActionToken(one.header(), "revoke"); assert.ok(current);
  await h.service.revokeAll(two.header());
  assert.equal(await h.make().verifyActionToken(one.header(), "revoke", current), false);
});

test("Google browser limiter permits five start/finish attempts per minute and survives restart", async () => {
  const h = harness(); const jar = new CookieJar();
  const entry = await h.service.entry(null); jar.apply(entry.setCookie);
  for (let count = 0; count < 5; count += 1) assert.equal((await h.service.start({ cookieHeader: jar.header(), formToken: entry.formToken })).ok, true);
  const limited = await h.make().start({ cookieHeader: jar.header(), formToken: entry.formToken });
  assert.deepEqual(limited, { ok: false, code: "rate_limited", retryAfter: 60 });
  h.time.value += 60;
  assert.equal((await h.make().start({ cookieHeader: jar.header(), formToken: entry.formToken })).ok, true);
});

test("Invalid-state callbacks count toward the same browser limiter without storing attacker-controlled transaction IDs", async () => {
  const h = harness(); const flow = await begin(h.service);
  for (let count = 0; count < 4; count += 1) {
    const state = Buffer.alloc(32, count + 1).toString("base64url");
    assert.equal((await h.service.finish({ cookieHeader: flow.jar.header(), parameters: new URLSearchParams({ state, code: "attacker-code" }) })).ok, false);
  }
  const before = h.storage.snapshot();
  assert.equal(before.attempts.length, 5);
  assert.equal(before.transactions.length, 1);
  const limited = await h.make().finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() });
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.equal(limited.code, "rate_limited");
  assert.equal(h.exchanges.length, 0);
  h.time.value += 60;
  assert.equal((await h.make().finish({ cookieHeader: flow.jar.header(), parameters: flow.parameters() })).ok, true);
  assert.equal(h.exchanges.length, 1);
});

test("Google global limiter survives new browser bindings and restarts, with bounded retry", async () => {
  const h = harness();
  for (let count = 0; count < 60; count += 1) await begin(h.service);
  const fresh = await h.service.entry(null); const jar = new CookieJar(); jar.apply(fresh.setCookie);
  assert.deepEqual(await h.make().start({ cookieHeader: jar.header(), formToken: fresh.formToken }), { ok: false, code: "rate_limited", retryAfter: 60 });
  assert.equal(h.storage.snapshot().attempts.length, 60);
  h.time.value += 60;
  assert.equal((await h.make().start({ cookieHeader: jar.header(), formToken: fresh.formToken })).ok, true);
});

test("Untrusted-browser floods do not revoke or lock out an already established owner session", async () => {
  const h = harness(); const current = await login(h.service);
  for (let count = 0; count < 58; count += 1) await begin(h.service);
  assert.equal(h.storage.snapshot().attempts.length, 60);
  assert.ok(await h.service.getVerifiedOwner(current.header()));
  assert.ok(await h.make().getVerifiedOwner(current.header()));
  assert.equal(h.storage.snapshot().sessions.length, 1);
});

test("Google outstanding transactions are capped at 128 and expired transactions reclaim capacity", async () => {
  const h = harness();
  for (let count = 0; count < 128; count += 1) {
    if (count > 0 && count % 60 === 0) h.time.value += 60;
    await begin(h.service);
  }
  const entry = await h.service.entry(null); const jar = new CookieJar(); jar.apply(entry.setCookie);
  const denied = await h.service.start({ cookieHeader: jar.header(), formToken: entry.formToken });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "rate_limited");
  assert.equal(h.storage.snapshot().transactions.length, 128);
  h.time.value = epoch + 600;
  await begin(h.make());
  assert.equal(h.storage.snapshot().transactions.length, 69);
});

test("Tampered and swapped encrypted PKCE verifier cannot cause a provider exchange", async () => {
  for (const swap of [false, true]) {
    const h = harness(); const first = await begin(h.service); await begin(h.service);
    await h.storage.transaction(async (store) => {
      const state = await store.get<any>(GOOGLE_AUTH_STATE_KEY);
      state.transactions[0].verifierCiphertext = swap ? state.transactions[1].verifierCiphertext : `${state.transactions[0].verifierCiphertext.slice(0, -2)}AA`;
      await store.put(GOOGLE_AUTH_STATE_KEY, state);
    });
    assert.equal((await h.service.finish({ cookieHeader: first.jar.header(), parameters: first.parameters() })).ok, false);
    assert.equal(h.exchanges.length, 0);
    assert.equal(h.storage.snapshot().sessions.length, 0);
  }
});

test("Legacy password-session namespace and malformed session cookies are never accepted", async () => {
  const h = harness(); const jar = await login(h.service);
  h.storage.data.set("owner-access-v2", { sessions: { "legacy-reference": {} } });
  assert.equal(await h.service.getVerifiedOwner("__Host-personal-consultant-owner=legacy-reference"), undefined);
  assert.equal(await h.service.getVerifiedOwner(`${jar.header()}; ${GOOGLE_SESSION_COOKIE}=${jar.values.get(GOOGLE_SESSION_COOKIE)}`), undefined);
  assert.equal(await h.service.getVerifiedOwner(`${GOOGLE_SESSION_COOKIE}=invalid`), undefined);
  assert.equal(await h.service.getVerifiedOwner(`${GOOGLE_SESSION_COOKIE}=${jar.values.get(GOOGLE_SESSION_COOKIE)}x`), undefined);
  assert.deepEqual(h.storage.data.get("owner-access-v2"), { sessions: { "legacy-reference": {} } });
});
