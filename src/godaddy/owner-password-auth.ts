import { timingSafeEqual } from "node:crypto";

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

type LoginTransaction = Readonly<{
  v: 1;
  e: number;
  n: string;
  o: string;
}>;

type OwnerSession = Readonly<{
  v: 1;
  e: number;
  s: string;
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
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0 && url.pathname === "/" && url.search.length === 0 && url.hash.length === 0;
  } catch {
    return false;
  }
}

const validLoginTransaction = (value: LoginTransaction | undefined, nowSeconds: number): value is LoginTransaction =>
  value !== undefined && value.v === 1 && value.e >= nowSeconds &&
  typeof value.n === "string" && /^[A-Za-z0-9_-]{32,255}$/u.test(value.n) &&
  typeof value.o === "string" && isHttpsOrigin(value.o);

const validSession = (value: OwnerSession | undefined, nowSeconds: number): value is OwnerSession =>
  value !== undefined && value.v === 1 && value.e >= nowSeconds &&
  typeof value.s === "string" && /^[A-Za-z0-9_-]{32,255}$/u.test(value.s);

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
  if (ownerPassword === undefined || sessionHmacKey === undefined || ownerPassword.length < 32 || sessionHmacKey.length < 32) {
    return { ok: false, code: "owner_password_not_configured" };
  }
  return { ok: true, value: Object.freeze({ ownerPassword, sessionHmacKey }) };
}

export function createOwnerPasswordService(input: Readonly<{
  configuration: OwnerPasswordConfiguration;
  now?: () => Date;
}>) {
  const now = input.now ?? (() => new Date());
  const keyPromise = signingKey(input.configuration.sessionHmacKey);

  return Object.freeze({
    async start(requestOrigin: string): Promise<OwnerPasswordLoginStart | undefined> {
      if (!isHttpsOrigin(requestOrigin)) return undefined;
      const issuedAt = Math.floor(now().getTime() / 1_000);
      const transaction: LoginTransaction = Object.freeze({
        v: 1,
        e: issuedAt + LOGIN_MAX_AGE_SECONDS,
        n: randomValue(),
        o: requestOrigin
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
      const nowSeconds = Math.floor(now().getTime() / 1_000);
      if (
        !validLoginTransaction(transaction, nowSeconds) ||
        transaction.o !== inputValue.requestOrigin ||
        transaction.n !== inputValue.formToken ||
        !passwordMatches(inputValue.password, input.configuration.ownerPassword)
      ) return denied;

      const session: OwnerSession = Object.freeze({
        v: 1,
        e: nowSeconds + SESSION_MAX_AGE_SECONDS,
        s: randomValue()
      });
      const signed = await sign(await keyPromise, session);
      return Object.freeze({
        ok: true as const,
        setCookie: secureCookie(OWNER_SESSION_COOKIE, signed.value, SESSION_MAX_AGE_SECONDS),
        clearCookie: clearCookie(LOGIN_TRANSACTION_COOKIE)
      });
    },

    async hasVerifiedOwner(cookieHeader: string | null): Promise<boolean> {
      const session = await verify<OwnerSession>(await keyPromise, parseCookie(cookieHeader, OWNER_SESSION_COOKIE));
      return validSession(session, Math.floor(now().getTime() / 1_000));
    },

    signOutCookie(): string {
      return clearCookie(OWNER_SESSION_COOKIE);
    }
  });
}
