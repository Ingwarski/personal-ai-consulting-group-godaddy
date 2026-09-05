import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SettingsStorage } from "../settings/storage.ts";
import { createGoogleIdentityProvider, type GoogleIdentityProvider } from "./google-identity-provider.ts";

export type OwnerGoogleConfiguration = Readonly<{
  clientId: string; clientSecret: string; publicOrigin: string; ownerEmail: string;
  sessionHmacKey: string; csrfHmacKey: string; transactionKey: string;
}>;
export const GOOGLE_AUTH_STATE_KEY = "owner-google-access-v1";
export const GOOGLE_BROWSER_COOKIE = "__Host-personal-consultant-google-browser";
export const GOOGLE_TRANSACTION_COOKIE = "__Host-personal-consultant-google-transaction";
export const GOOGLE_SESSION_COOKIE = "__Host-personal-consultant-google-owner";
const FLOW_TTL = 600;
const ABSOLUTE_TTL = 43_200;
const IDLE_TTL = 1_800;
const MAX_SESSIONS = 16;
const MAX_PENDING = 128;
const ID = /^[A-Za-z0-9_-]{43}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const random = (): string => Buffer.from(randomBytes(32)).toString("base64url");
const mac = (key: string, value: string): string => createHmac("sha256", key).update(value).digest("base64url");
const equal = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const seconds = (value: Date): number => Math.floor(value.getTime() / 1_000);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const cookie = (name: string, value: string, ttl: number): string => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${ttl}`;
const clearTransaction = (): string => cookie(GOOGLE_TRANSACTION_COOKIE, "", 0);
const clearSession = (): string => cookie(GOOGLE_SESSION_COOKIE, "", 0);

function readCookie(header: string | null, name: string): string | undefined {
  if (header === null || header.length > 16_384) return undefined;
  const matches = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]?.slice(name.length + 1) : undefined;
}
function sign(key: string, purpose: string, value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${mac(key, `${purpose}.${payload}`)}`;
}
function verify(key: string, purpose: string, value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined || value.length > 2_048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(value)) return undefined;
  const [payload, signature] = value.split(".");
  if (payload === undefined || signature === undefined || !equal(mac(key, `${purpose}.${payload}`), signature)) return undefined;
  try { const result: unknown = JSON.parse(Buffer.from(payload, "base64url").toString()); return record(result) ? result : undefined; } catch { return undefined; }
}

export function parseOwnerGoogleConfiguration(environment: Record<string, unknown>):
  Readonly<{ ok: true; value: OwnerGoogleConfiguration }> | Readonly<{ ok: false; code: string }> {
  const secret = (value: unknown): value is string => typeof value === "string" && value.length >= 32 && value.length <= 4_096;
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, SETTINGS_PUBLIC_ORIGIN: publicOrigin,
    SETTINGS_OWNER_GOOGLE_EMAIL: email, SETTINGS_SESSION_HMAC_KEY: sessionHmacKey,
    SETTINGS_CSRF_HMAC_KEY: csrfHmacKey, SETTINGS_OAUTH_TRANSACTION_KEY: transactionKey } = environment;
  if (environment.SETTINGS_OWNER_ENABLED !== "true" || typeof clientId !== "string" ||
    !/^[A-Za-z0-9_-]{10,200}\.apps\.googleusercontent\.com$/u.test(clientId) ||
    typeof clientSecret !== "string" || clientSecret.length < 16 || clientSecret.length > 4_096 || /[\s\u0000-\u001f\u007f]/u.test(clientSecret) ||
    typeof publicOrigin !== "string" || publicOrigin.length > 255 || typeof email !== "string" ||
    !/^[^\s@]{1,64}@gmail\.com$/iu.test(email.trim()) || !secret(sessionHmacKey) || !secret(csrfHmacKey) || !secret(transactionKey) ||
    new Set([sessionHmacKey, csrfHmacKey, transactionKey]).size !== 3) return { ok: false, code: "owner_google_not_configured" };
  try {
    const origin = new URL(publicOrigin);
    if (origin.protocol !== "https:" || origin.origin !== publicOrigin || origin.username || origin.password) return { ok: false, code: "owner_google_not_configured" };
  } catch { return { ok: false, code: "owner_google_not_configured" }; }
  return { ok: true, value: Object.freeze({ clientId, clientSecret, publicOrigin, ownerEmail: email.trim().toLowerCase(), sessionHmacKey, csrfHmacKey, transactionKey }) };
}

type Session = { referenceHash: string; browserHash: string; createdAt: number; lastSeen: number; expiresAt: number; revocation: number };
type Transaction = {
  stateHash: string; browserHash: string; transactionHash: string; nonceHash: string;
  createdAt: number; expiresAt: number; revocation: number; status: "pending" | "claimed" | "consumed";
  verifierCiphertext: string; claim?: string;
};
type State = {
  version: 1; generation: string; identityGeneration: string; revocation: number; owner?: string;
  sessions: Session[]; transactions: Transaction[]; attempts: { browserHash: string; at: number }[];
};
function checkedState(value: unknown): State {
  const invalid = (): never => { throw new Error("Owner access state is invalid."); };
  if (!record(value) || value.version !== 1 || typeof value.generation !== "string" || !HASH.test(value.generation) ||
    typeof value.identityGeneration !== "string" || !HASH.test(value.identityGeneration) || !integer(value.revocation) ||
    (value.owner !== undefined && (typeof value.owner !== "string" || !HASH.test(value.owner))) ||
    !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS ||
    !Array.isArray(value.transactions) || value.transactions.length > MAX_PENDING ||
    !Array.isArray(value.attempts) || value.attempts.length > 60) return invalid();
  for (const session of value.sessions) {
    if (!record(session) || typeof session.referenceHash !== "string" || !HASH.test(session.referenceHash) ||
      typeof session.browserHash !== "string" || !HASH.test(session.browserHash) ||
      !integer(session.createdAt) || !integer(session.lastSeen) || !integer(session.expiresAt) || !integer(session.revocation) ||
      session.createdAt > session.lastSeen || session.lastSeen >= session.expiresAt || session.expiresAt - session.createdAt !== ABSOLUTE_TTL) return invalid();
  }
  for (const transaction of value.transactions) {
    if (!record(transaction) || !["pending", "claimed", "consumed"].includes(String(transaction.status)) ||
      ![transaction.stateHash, transaction.browserHash, transaction.transactionHash, transaction.nonceHash].every((entry) => typeof entry === "string" && HASH.test(entry)) ||
      !integer(transaction.createdAt) || !integer(transaction.expiresAt) || transaction.expiresAt - transaction.createdAt !== FLOW_TTL ||
      !integer(transaction.revocation) || typeof transaction.verifierCiphertext !== "string" || transaction.verifierCiphertext.length > 256 ||
      (transaction.status !== "consumed" && !/^[A-Za-z0-9_-]{95}$/u.test(transaction.verifierCiphertext)) ||
      (transaction.claim !== undefined && (typeof transaction.claim !== "string" || !ID.test(transaction.claim)))) return invalid();
  }
  for (const attempt of value.attempts) {
    if (!record(attempt) || typeof attempt.browserHash !== "string" || !HASH.test(attempt.browserHash) || !integer(attempt.at)) return invalid();
  }
  return value as State;
}

export function createOwnerGoogleService(input: Readonly<{
  configuration: OwnerGoogleConfiguration; storage: SettingsStorage; provider?: GoogleIdentityProvider; now?: () => Date;
}>) {
  const { storage } = input;
  const config = Object.freeze({ ...input.configuration });
  const now = (): number => seconds((input.now ?? (() => new Date()))());
  // Client/identity/origin/key changes invalidate grants. Revocation is a separate durable epoch.
  const identityGeneration = hash(`owner-google-identity-v1:${config.ownerEmail}`);
  const generation = hash(mac(config.sessionHmacKey, JSON.stringify([
    "owner-google-access-v1", true, config.clientId, config.clientSecret, config.publicOrigin,
    config.ownerEmail, config.csrfHmacKey, config.transactionKey
  ])));
  const encryptionKey = createHash("sha256").update(config.transactionKey).digest();
  const provider = input.provider ?? createGoogleIdentityProvider({
    clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: `${config.publicOrigin}/auth/google/callback`,
    ...(input.now === undefined ? {} : { now: input.now })
  });
  const fresh = (owner?: string): State => ({ version: 1, generation, identityGeneration, revocation: 0,
    ...(owner === undefined ? {} : { owner }), sessions: [], transactions: [], attempts: [] });
  let activated = false;
  const transact = async <T>(operation: (state: State, at: number) => T | Promise<T>, onStale?: () => T, activate = false): Promise<T> => {
    let wrote = false;
    const result = await storage.transaction(async (locked) => {
    const raw = await locked.get<unknown>(GOOGLE_AUTH_STATE_KEY);
    const stored = raw === undefined ? undefined : checkedState(raw);
    const at = now(); // Never use a clock snapshot taken before waiting for the database lock.
    if (!integer(at)) throw new Error("Owner access clock is invalid.");
    if (stored !== undefined && stored.generation !== generation && (!activate || activated)) {
      // An old process or in-flight callback must never roll configuration back
      // or erase sessions created by the replacement process.
      if (onStale !== undefined) return onStale();
      throw new Error("Owner access configuration is stale.");
    }
    const state = stored === undefined ? fresh() : stored.generation === generation ? stored : fresh(stored.identityGeneration === identityGeneration ? stored.owner : undefined);
    state.sessions = state.sessions.filter((session) => session.expiresAt > at && session.lastSeen + IDLE_TTL > at && session.revocation === state.revocation);
    state.transactions = state.transactions.filter((transaction) => transaction.expiresAt > at && transaction.status !== "consumed" && transaction.revocation === state.revocation);
    state.attempts = state.attempts.filter((attempt) => attempt.at + 60 > at);
    const result = await operation(state, at);
    await locked.put(GOOGLE_AUTH_STATE_KEY, state);
    wrote = true;
    return result;
    });
    // Failed commits must not leave this process permanently activated against
    // a generation that was rolled back by the database.
    if (wrote) activated = true;
    return result;
  };
  const browser = (header: string | null, at: number): string | undefined => {
    const data = verify(config.csrfHmacKey, "google-browser", readCookie(header, GOOGLE_BROWSER_COOKIE));
    return data?.g === generation && typeof data.b === "string" && ID.test(data.b) && integer(data.e) && data.e > at && data.e <= at + FLOW_TTL ? data.b : undefined;
  };
  const sessionData = (header: string | null, at: number): { s: string; r: number; e: number } | undefined => {
    const data = verify(config.sessionHmacKey, "google-session", readCookie(header, GOOGLE_SESSION_COOKIE));
    return data?.g === generation && typeof data.s === "string" && ID.test(data.s) && integer(data.e) && data.e > at && integer(data.r)
      ? { s: data.s, r: data.r, e: data.e } : undefined;
  };
  const sessionIn = (header: string | null, state: State, at: number): Session | undefined => {
    const data = sessionData(header, at);
    return data === undefined || data.r !== state.revocation || state.owner === undefined ? undefined :
      state.sessions.find((session) => session.referenceHash === hash(data.s) && session.expiresAt === data.e && session.lastSeen <= at);
  };
  const audience = (session: Session): string => `owner-google-settings-v1:${generation}:${session.revocation}:${session.referenceHash}`;
  const rate = (state: State, browserHash: string, at: number): number | undefined => {
    const relevant = state.attempts.length >= 60 ? state.attempts : state.attempts.filter((attempt) => attempt.browserHash === browserHash);
    if (state.attempts.length >= 60 || relevant.length >= 5) return Math.max(1, (relevant[0]?.at ?? at) + 60 - at);
    state.attempts.push({ browserHash, at });
    return undefined;
  };
  const aad = (transaction: Transaction): Buffer => Buffer.from(`${generation}:${transaction.revocation}:${transaction.stateHash}`);
  const encrypt = (verifier: string, transaction: Transaction): string => {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv); cipher.setAAD(aad(transaction));
    const ciphertext = Buffer.concat([cipher.update(verifier, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  };
  const decrypt = (transaction: Transaction): string => {
    const data = Buffer.from(transaction.verifierCiphertext, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, data.subarray(0, 12));
    decipher.setAAD(aad(transaction)); decipher.setAuthTag(data.subarray(12, 28));
    const result = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString();
    if (!ID.test(result)) throw new Error("Invalid OAuth transaction.");
    return result;
  };
  type Denied = { ok: false; code: "access_denied" | "rate_limited"; retryAfter?: number };
  const denied = (): Denied => ({ ok: false, code: "access_denied" });
  const getVerifiedOwner = (header: string | null): Promise<{ origin: string; csrfAudience: string } | undefined> => {
    if (sessionData(header, now()) === undefined) return Promise.resolve(undefined);
    return transact((state, at) => {
      const session = sessionIn(header, state, at); if (session === undefined) return undefined;
      session.lastSeen = at;
      return { origin: config.publicOrigin, csrfAudience: audience(session) };
    }, () => undefined);
  };
  return {
    async entry(header: string | null): Promise<{ formToken: string; setCookie: string }> {
      const at = now(); const b = browser(header, at) ?? random();
      const signed = sign(config.csrfHmacKey, "google-browser", { b, e: at + FLOW_TTL, g: generation });
      return { formToken: mac(config.csrfHmacKey, `google-start:${generation}:${b}`), setCookie: cookie(GOOGLE_BROWSER_COOKIE, signed, FLOW_TTL) };
    },
    async start(request: { cookieHeader: string | null; formToken: string }): Promise<{ ok: true; location: string; cookies: readonly string[] } | Denied> {
      const entryBrowser = browser(request.cookieHeader, now());
      if (entryBrowser === undefined || !ID.test(request.formToken) || !equal(request.formToken, mac(config.csrfHmacKey, `google-start:${generation}:${entryBrowser}`))) return denied();
      return transact((state, at) => {
        const b = browser(request.cookieHeader, at);
        if (b === undefined || !ID.test(request.formToken) || !equal(request.formToken, mac(config.csrfHmacKey, `google-start:${generation}:${b}`))) return denied();
        const retryAfter = rate(state, hash(b), at);
        if (retryAfter !== undefined) return { ok: false, code: "rate_limited", retryAfter };
        if (state.transactions.length >= MAX_PENDING) return { ok: false, code: "rate_limited", retryAfter: FLOW_TTL };
        const rawState = random(); const nonce = random(); const verifier = random(); const binding = random();
        const transaction: Transaction = { stateHash: hash(rawState), browserHash: hash(b), transactionHash: hash(binding), nonceHash: hash(nonce), createdAt: at,
          expiresAt: at + FLOW_TTL, revocation: state.revocation, status: "pending", verifierCiphertext: "" };
        transaction.verifierCiphertext = encrypt(verifier, transaction);
        state.transactions.push(transaction);
        const location = provider.authorizationUrl({ state: rawState, nonce, codeChallenge: createHash("sha256").update(verifier).digest("base64url") });
        return { ok: true, location, cookies: [cookie(GOOGLE_TRANSACTION_COOKIE, sign(config.csrfHmacKey, "google-transaction", { b: binding, e: at + FLOW_TTL, g: generation }), FLOW_TTL)] };
      }, denied, true);
    },
    async finish(request: { cookieHeader: string | null; parameters: URLSearchParams }): Promise<({ ok: true } | Denied) & { cookies: readonly string[] }> {
      const failure = (result: Denied = denied()) => ({ ...result, cookies: [clearTransaction()] });
      const params = request.parameters;
      // Google's ordinary callback metadata is bounded but not trusted. Protocol duplicates are rejected.
      const allowed = new Set(["state", "code", "error", "error_description", "error_uri", "scope", "authuser", "prompt", "hd", "iss"]);
      if (params.toString().length > 8_192 || [...params.keys()].some((key) => !allowed.has(key) || params.getAll(key).length !== 1)) return failure();
      // Google advertises RFC 9207 issuer metadata in its authorization response.
      // Compare the decoded value exactly with Google's discovery issuer, before
      // exchanging any code. Keep support for older responses without metadata;
      // the fixed token endpoint and signed ID-token issuer checks still apply.
      if (params.has("iss") && params.get("iss") !== "https://accounts.google.com") return failure();
      const rawState = params.get("state"); const code = params.get("code"); const error = params.get("error");
      if (rawState === null || !ID.test(rawState) || (code === null) === (error === null) ||
        (code !== null && (code.length < 1 || code.length > 4_096 || /[\s\u0000-\u001f\u007f]/u.test(code))) ||
        (error !== null && !/^[a-z_]{1,64}$/u.test(error))) return failure();
      const stateHash = hash(rawState);
      const claim = await transact((state, at) => {
        const b = browser(request.cookieHeader, at);
        const binding = verify(config.csrfHmacKey, "google-transaction", readCookie(request.cookieHeader, GOOGLE_TRANSACTION_COOKIE));
        if (b === undefined || binding?.g !== generation || typeof binding.b !== "string" || !ID.test(binding.b) || !integer(binding.e) || binding.e <= at) return denied();
        const retryAfter = rate(state, hash(b), at);
        if (retryAfter !== undefined) return { ok: false as const, code: "rate_limited" as const, retryAfter };
        const transaction = state.transactions.find((item) => item.stateHash === stateHash && item.browserHash === hash(b) && item.transactionHash === hash(binding.b as string));
        if (transaction === undefined || transaction.status !== "pending") return denied();
        transaction.status = error === null ? "claimed" : "consumed";
        transaction.claim = random();
        if (error !== null) { transaction.verifierCiphertext = ""; return denied(); }
        try { return { ok: true as const, transaction: { ...transaction }, verifier: decrypt(transaction) }; }
        catch { transaction.status = "consumed"; transaction.verifierCiphertext = ""; return denied(); }
      }, denied);
      if (!claim.ok) return failure(claim);
      // Claim has committed. Never hold a database transaction during Google's network calls.
      let identity;
      try { identity = await provider.exchange({ code: code!, codeVerifier: claim.verifier, nonceHash: claim.transaction.nonceHash, createdAt: claim.transaction.createdAt }); }
      catch { identity = undefined; }
      return transact((state, at) => {
        const transaction = state.transactions.find((item) => item.stateHash === stateHash && item.claim === claim.transaction.claim && item.status === "claimed");
        if (transaction === undefined || transaction.revocation !== state.revocation) return failure();
        transaction.status = "consumed"; transaction.verifierCiphertext = "";
        if (identity === undefined || identity === null || identity.emailVerified !== true || typeof identity.email !== "string" || identity.email.toLowerCase() !== config.ownerEmail ||
          !["https://accounts.google.com", "accounts.google.com"].includes(identity.issuer) || typeof identity.subject !== "string" ||
          identity.subject.length === 0 || identity.subject.length > 255) return failure();
        const owner = hash(`https://accounts.google.com:${identity.subject}`);
        if (state.owner !== undefined && state.owner !== owner) return failure();
        const previous = sessionIn(request.cookieHeader, state, at);
        const retained = state.sessions.filter((item) => item !== previous && item.browserHash !== transaction.browserHash);
        if (retained.length >= MAX_SESSIONS) return failure();
        const reference = random(); const expiresAt = at + ABSOLUTE_TTL;
        state.owner = owner;
        state.sessions = [...retained, { referenceHash: hash(reference), browserHash: transaction.browserHash, createdAt: at, lastSeen: at, expiresAt, revocation: state.revocation }];
        return { ok: true as const, cookies: [clearTransaction(), cookie(GOOGLE_SESSION_COOKIE,
          sign(config.sessionHmacKey, "google-session", { g: generation, s: reference, r: state.revocation, e: expiresAt }), ABSOLUTE_TTL)] };
      }, failure);
    },
    getVerifiedOwner,
    async issueActionToken(header: string | null, purpose: string): Promise<string | undefined> {
      const owner = await getVerifiedOwner(header);
      return owner === undefined ? undefined : sign(config.csrfHmacKey, "google-action", { p: purpose, a: owner.csrfAudience, e: now() + FLOW_TTL });
    },
    async verifyActionToken(header: string | null, purpose: string, token: string): Promise<boolean> {
      const value = verify(config.csrfHmacKey, "google-action", token);
      if (value?.p !== purpose || !integer(value.e) || value.e <= now() || value.e > now() + FLOW_TTL) return false;
      const owner = await getVerifiedOwner(header);
      return owner !== undefined && value.a === owner.csrfAudience && value.e > now();
    },
    async signOut(header: string | null): Promise<string> {
      await transact((state, at) => { const current = sessionIn(header, state, at); state.sessions = state.sessions.filter((item) => item !== current); }, () => undefined);
      return clearSession();
    },
    async revokeAll(header: string | null): Promise<string> {
      await transact((state, at) => {
        if (sessionIn(header, state, at) === undefined) return;
        if (state.revocation >= Number.MAX_SAFE_INTEGER) throw new Error("Owner access generation is exhausted.");
        state.revocation += 1; state.sessions = []; state.transactions = [];
      }, () => undefined);
      return clearSession();
    }
  };
}
