import { createHash, timingSafeEqual } from "node:crypto";
import type { SettingsStorage } from "../settings/storage.ts";

export type OwnerPasswordConfiguration = Readonly<{
  ownerPassword: string;
  sessionHmacKey: string;
}>;

export type OwnerPasswordConfigurationResult =
  | Readonly<{ ok: true; value: OwnerPasswordConfiguration }>
  | Readonly<{ ok: false; code: "owner_password_not_configured" }>;

export type OwnerPasswordLoginStart = Readonly<{
  formToken: string;
  setCookie: string;
}>;

export type OwnerPasswordLoginResult =
  | Readonly<{ ok: true; setCookie: string; clearCookie: string }>
  | Readonly<{ ok: false; code: "access_denied"; clearCookie: string }>;

const LOGIN_TRANSACTION_COOKIE = "__Host-personal-consultant-login";
const OWNER_SESSION_COOKIE = "__Host-personal-consultant-owner";
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const LOGIN_MAX_AGE_SECONDS = 10 * 60;
const MAX_COOKIE_VALUE_LENGTH = 4_096;
const SESSION_IDLE_SECONDS = 30 * 60;
const ATTEMPT_WINDOW_SECONDS = 60;
const MAX_FAILED_ATTEMPTS = 5;
const MAX_CONSUMED_CHALLENGES = 512;
const MAX_SESSIONS = 16;
const AUTH_STATE_KEY = "owner-access-v2";

type AuthState = {
  v: 2;
  generation: string;
  challengeNotBefore: number;
  consumed: Record<string, number>;
  sessions: Record<string, { expires: number; lastSeen: number }>;
  failures: number[];
};

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function authState(value: unknown, nowSeconds: number, generation: string): AuthState {
  const fresh = (): AuthState => ({ v: 2, generation, challengeNotBefore: 0, consumed: {}, sessions: {}, failures: [] });
  if (value === undefined) return fresh();
  const state = value as AuthState;
  const record = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
  if (!record(value) || state.v !== 2 || typeof state.generation !== "string" || !/^[a-f0-9]{64}$/u.test(state.generation) ||
    !Number.isSafeInteger(state.challengeNotBefore) || !record(state.consumed) || !record(state.sessions) ||
    !Array.isArray(state.failures) || state.failures.length > MAX_FAILED_ATTEMPTS ||
    state.failures.some((time) => !Number.isSafeInteger(time)) ||
    Object.keys(state.consumed).length > MAX_CONSUMED_CHALLENGES ||
    Object.keys(state.sessions).length > MAX_SESSIONS ||
    Object.entries(state.consumed).some(([id, time]) => !/^[a-f0-9]{64}$/u.test(id) || !Number.isSafeInteger(time)) ||
    Object.entries(state.sessions).some(([id, session]) => !/^[a-f0-9]{64}$/u.test(id) ||
      !record(session) || !Number.isSafeInteger(session.expires) || !Number.isSafeInteger(session.lastSeen))) {
    throw new Error("Owner access state is invalid.");
  }
  // A credential rotation cannot leave all session slots occupied by cookies
  // that no longer verify. Never persist the credential or a password verifier.
  if (state.generation !== generation) return fresh();
  return {
    v: 2, generation, challengeNotBefore: state.challengeNotBefore,
    consumed: Object.fromEntries(Object.entries(state.consumed).filter(([, expires]) => expires > nowSeconds)),
    sessions: Object.fromEntries(Object.entries(state.sessions).filter(([, session]) =>
      session.expires > nowSeconds && session.lastSeen + SESSION_IDLE_SECONDS > nowSeconds)),
    failures: state.failures.filter((time) => time + ATTEMPT_WINDOW_SECONDS > nowSeconds)
  };
}

type LoginTransaction = Readonly<{
  v: 1;
  i: number;
  e: number;
  n: string;
}>;

type OwnerSession = Readonly<{
  v: 1;
  e: number;
  s: string;
  o: string;
}>;

type SignedValue<T> = Readonly<{ payload: T; value: string }>;

const asRequiredString = (value: unknown, maximum = 4_096): string | undefined =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum ? value : undefined;

const toBase64Url = (value: Uint8Array): string =>
  btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const fromBase64Url = (value: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const randomValue = (bytes = 32): string => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return toBase64Url(value);
};

function parseCookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1) continue;
    if (segment.slice(0, separator).trim() === name) return segment.slice(separator + 1).trim();
  }
  return undefined;
}

function secureCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

const clearCookie = (name: string): string =>
  `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function sign<T>(key: CryptoKey, payload: T): Promise<SignedValue<T>> {
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return Object.freeze({ payload, value: `${body}.${toBase64Url(signature)}` });
}

async function verify<T>(key: CryptoKey, value: string | undefined): Promise<T | undefined> {
  if (value === undefined || value.length === 0 || value.length > MAX_COOKIE_VALUE_LENGTH) return undefined;
  const [body, encodedSignature, extra] = value.split(".");
  if (body === undefined || encodedSignature === undefined || extra !== undefined) return undefined;
  const signature = fromBase64Url(encodedSignature);
  const bytes = fromBase64Url(body);
  if (signature === undefined || bytes === undefined) return undefined;
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) as ArrayBuffer,
    new TextEncoder().encode(body)
  ).catch(() => false);
  if (!valid) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return undefined;
  }
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0 && url.origin === value;
  } catch {
    return false;
  }
}

const validLoginTransaction = (value: LoginTransaction | undefined, nowSeconds: number): value is LoginTransaction =>
  value !== undefined && value !== null && value.v === 1 && Number.isSafeInteger(value.i) && value.i <= nowSeconds &&
  Number.isSafeInteger(value.e) && value.e === value.i + LOGIN_MAX_AGE_SECONDS && value.e > nowSeconds &&
  typeof value.n === "string" && /^[A-Za-z0-9_-]{32,255}$/u.test(value.n);

const validSession = (value: OwnerSession | undefined, nowSeconds: number): value is OwnerSession =>
  value !== undefined && value !== null && value.v === 1 && Number.isSafeInteger(value.e) && value.e > nowSeconds &&
  typeof value.s === "string" && /^[A-Za-z0-9_-]{32,255}$/u.test(value.s) &&
  typeof value.o === "string" && isHttpsOrigin(value.o);

function passwordMatches(candidate: string, expected: string): boolean {
  if (candidate.length > 4_096) return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  const sameLength = candidateBytes.length === expectedBytes.length;
  const comparedBytes = sameLength ? candidateBytes : Buffer.alloc(expectedBytes.length);
  return timingSafeEqual(comparedBytes, expectedBytes) && sameLength;
}

/** Parse names only. Secret values are never included in diagnostics or sessions. */
export function parseOwnerPasswordConfiguration(environment: Record<string, unknown>): OwnerPasswordConfigurationResult {
  const ownerPassword = asRequiredString(environment.SETTINGS_OWNER_PASSWORD);
  const sessionHmacKey = asRequiredString(environment.SETTINGS_SESSION_HMAC_KEY);
  if (ownerPassword === undefined || sessionHmacKey === undefined || ownerPassword.length < 32 || sessionHmacKey.length < 32 || ownerPassword === sessionHmacKey) {
    return { ok: false, code: "owner_password_not_configured" };
  }
  return { ok: true, value: Object.freeze({ ownerPassword, sessionHmacKey }) };
}

export function createOwnerPasswordService(input: Readonly<{
  configuration: OwnerPasswordConfiguration;
  storage: SettingsStorage;
  now?: () => Date;
}>) {
  const now = input.now ?? (() => new Date());
  // Binding signatures to both credentials invalidates all old challenges and
  // sessions after either Secret rotates, without persisting either Secret.
  const credentialsPromise = signingKey(input.configuration.sessionHmacKey).then(async (key) => {
    const derived = new Uint8Array(await crypto.subtle.sign("HMAC", key,
      new TextEncoder().encode(`owner-access-v2\0${input.configuration.ownerPassword}`)));
    return { key: await signingKey(toBase64Url(derived)), generation: digest(toBase64Url(derived)) };
  });
  const keyPromise = credentialsPromise.then(({ key }) => key);
  const verifiedOwnerOrigin = async (cookieHeader: string | null): Promise<string | undefined> => {
    const session = await verify<OwnerSession>(await keyPromise, parseCookie(cookieHeader, OWNER_SESSION_COOKIE));
    if (!validSession(session, Math.floor(now().getTime() / 1_000))) return undefined;
    const { generation } = await credentialsPromise;
    return input.storage.transaction(async (storage) => {
      const stored = await storage.get(AUTH_STATE_KEY);
      const nowSeconds = Math.floor(now().getTime() / 1_000);
      if (!validSession(session, nowSeconds)) return undefined;
      const state = authState(stored, nowSeconds, generation);
      const id = digest(session.s);
      const saved = state.sessions[id];
      if (saved === undefined || saved.expires !== session.e) return undefined;
      saved.lastSeen = nowSeconds;
      await storage.put(AUTH_STATE_KEY, state);
      return session.o;
    });
  };

  return Object.freeze({
    async start(): Promise<OwnerPasswordLoginStart> {
      const issuedAt = Math.floor(now().getTime() / 1_000);
      const transaction: LoginTransaction = Object.freeze({
        v: 1,
        i: issuedAt,
        e: issuedAt + LOGIN_MAX_AGE_SECONDS,
        n: randomValue()
      });
      const signed = await sign(await keyPromise, transaction);
      return Object.freeze({
        formToken: transaction.n,
        setCookie: secureCookie(LOGIN_TRANSACTION_COOKIE, signed.value, LOGIN_MAX_AGE_SECONDS)
      });
    },

    async finish(inputValue: Readonly<{
      cookieHeader: string | null;
      password: string | undefined;
      requestOrigin: string;
      formToken: string | undefined;
    }>): Promise<OwnerPasswordLoginResult> {
      const denied = Object.freeze({ ok: false as const, code: "access_denied" as const, clearCookie: clearCookie(LOGIN_TRANSACTION_COOKIE) });
      if (!isHttpsOrigin(inputValue.requestOrigin) || inputValue.password === undefined || inputValue.formToken === undefined) return denied;
      const transaction = await verify<LoginTransaction>(await keyPromise, parseCookie(inputValue.cookieHeader, LOGIN_TRANSACTION_COOKIE));
      if (
        !validLoginTransaction(transaction, Math.floor(now().getTime() / 1_000)) ||
        transaction.n !== inputValue.formToken
      ) return denied;
      const { key, generation } = await credentialsPromise;
      const previous = await verify<OwnerSession>(key, parseCookie(inputValue.cookieHeader, OWNER_SESSION_COOKIE));
      return input.storage.transaction(async (storage) => {
        const stored = await storage.get(AUTH_STATE_KEY);
        const nowSeconds = Math.floor(now().getTime() / 1_000);
        if (!validLoginTransaction(transaction, nowSeconds)) return denied;
        const state = authState(stored, nowSeconds, generation);
        const challengeId = digest(transaction.n);
        if (transaction.i < state.challengeNotBefore || Object.hasOwn(state.consumed, challengeId)) return denied;
        if (state.failures.length >= MAX_FAILED_ATTEMPTS || Object.keys(state.consumed).length >= MAX_CONSUMED_CHALLENGES) {
          // Invalidate the entire issued cohort without storing unbounded IDs
          // for submissions which were never allowed a password comparison.
          state.challengeNotBefore = nowSeconds + 1;
          state.consumed = {};
          await storage.put(AUTH_STATE_KEY, state);
          return denied;
        }
        // Consume atomically even on wrong-password or throttled submissions.
        // Refreshing the page, a second process or a restart cannot reset this.
        state.consumed[challengeId] = transaction.e;
        if (!passwordMatches(inputValue.password!, input.configuration.ownerPassword)) {
          state.failures.push(nowSeconds);
          await storage.put(AUTH_STATE_KEY, state);
          return denied;
        }
        if (validSession(previous, nowSeconds)) delete state.sessions[digest(previous.s)];
        if (Object.keys(state.sessions).length >= MAX_SESSIONS) {
          await storage.put(AUTH_STATE_KEY, state);
          return denied;
        }
        const session: OwnerSession = Object.freeze({
          v: 1, e: nowSeconds + SESSION_MAX_AGE_SECONDS, s: randomValue(), o: inputValue.requestOrigin
        });
        state.sessions[digest(session.s)] = { expires: session.e, lastSeen: nowSeconds };
        state.failures = [];
        const signed = await sign(key, session);
        await storage.put(AUTH_STATE_KEY, state);
        return Object.freeze({
          ok: true as const,
          setCookie: secureCookie(OWNER_SESSION_COOKIE, signed.value, SESSION_MAX_AGE_SECONDS),
          clearCookie: clearCookie(LOGIN_TRANSACTION_COOKIE)
        });
      });
    },

    async getVerifiedOwnerOrigin(cookieHeader: string | null): Promise<string | undefined> {
      return verifiedOwnerOrigin(cookieHeader);
    },

    async hasVerifiedOwner(cookieHeader: string | null): Promise<boolean> {
      return (await verifiedOwnerOrigin(cookieHeader)) !== undefined;
    },

    async signOutCookie(cookieHeader: string | null): Promise<string> {
      const session = await verify<OwnerSession>(await keyPromise, parseCookie(cookieHeader, OWNER_SESSION_COOKIE));
      const nowSeconds = Math.floor(now().getTime() / 1_000);
      if (validSession(session, nowSeconds)) {
        const { generation } = await credentialsPromise;
        await input.storage.transaction(async (storage) => {
          const stored = await storage.get(AUTH_STATE_KEY);
          const state = authState(stored, Math.floor(now().getTime() / 1_000), generation);
          delete state.sessions[digest(session.s)];
          await storage.put(AUTH_STATE_KEY, state);
        });
      }
      return clearCookie(OWNER_SESSION_COOKIE);
    }
  });
}
