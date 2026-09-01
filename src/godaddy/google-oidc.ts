import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";

type GoogleIdTokenPayload = Readonly<{
  aud?: string | readonly string[];
  email?: string;
  email_verified?: boolean;
  exp?: number;
  iss?: string;
  nonce?: string;
  sub?: string;
}>;

export type GoogleOidcClient = Readonly<{
  generateAuthUrl: (options: Record<string, unknown>) => string;
  generateCodeVerifierAsync: () => Promise<Readonly<{ codeVerifier: string; codeChallenge?: string }>>;
  getToken: (input: Readonly<{ code: string; codeVerifier: string }>) => Promise<Readonly<{ tokens: Readonly<{ id_token?: string }> }>>;
  verifyIdToken: (input: Readonly<{ idToken: string; audience: string }>) => Promise<Readonly<{
    getPayload: () => GoogleIdTokenPayload | undefined;
  }>>;
}>;

export type GoogleOidcConfiguration = Readonly<{
  clientId: string;
  clientSecret: string;
  ownerEmail: string;
  redirectUri: string;
  sessionHmacKey: string;
}>;

export type GoogleOidcConfigurationResult =
  | Readonly<{ ok: true; value: GoogleOidcConfiguration }>
  | Readonly<{ ok: false; code: "google_oidc_not_configured" | "invalid_google_oidc_configuration" }>;

export type GoogleOidcStart = Readonly<{
  authorizationUrl: string;
  setCookie: string;
}>;

export type GoogleOidcCallbackResult =
  | Readonly<{ ok: true; setCookie: string; clearCookie: string }>
  | Readonly<{ ok: false; code: "access_denied"; clearCookie: string }>;

const AUTH_TRANSACTION_COOKIE = "__Host-personal-consultant-oidc";
const OWNER_SESSION_COOKIE = "__Host-personal-consultant-owner";
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const TRANSACTION_MAX_AGE_SECONDS = 10 * 60;
const MAX_COOKIE_VALUE_LENGTH = 4_096;

type OAuthTransaction = Readonly<{
  v: 1;
  e: number;
  n: string;
  s: string;
  c: string;
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
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

const clearCookie = (name: string): string =>
  `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

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

const validTransaction = (value: OAuthTransaction | undefined, nowSeconds: number): value is OAuthTransaction =>
  value !== undefined && value.v === 1 && value.e >= nowSeconds &&
  typeof value.n === "string" && typeof value.s === "string" && typeof value.c === "string" &&
  value.n.length >= 32 && value.s.length >= 32 && value.c.length >= 43;

const validSession = (value: OwnerSession | undefined, nowSeconds: number): value is OwnerSession =>
  value !== undefined && value.v === 1 && value.e >= nowSeconds &&
  typeof value.s === "string" && /^[A-Za-z0-9_-]{1,255}$/u.test(value.s);

function sameString(value: unknown, expected: string): boolean {
  return typeof value === "string" && value === expected;
}

function hasAudience(value: string | readonly string[] | undefined, expected: string): boolean {
  return value === expected || Array.isArray(value) && value.length === 1 && value[0] === expected;
}

function configuredRedirectUri(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0 || url.hash.length > 0 || url.search.length > 0) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Parse configuration by names only. Values are intentionally never returned in diagnostics. */
export function parseGoogleOidcConfiguration(environment: Record<string, unknown>): GoogleOidcConfigurationResult {
  const clientId = asRequiredString(environment.GOOGLE_OAUTH_CLIENT_ID);
  const clientSecret = asRequiredString(environment.GOOGLE_OAUTH_CLIENT_SECRET);
  const ownerEmail = asRequiredString(environment.GOOGLE_OWNER_EMAIL, 320);
  const redirectUri = asRequiredString(environment.GOOGLE_REDIRECT_URI);
  const sessionHmacKey = asRequiredString(environment.GOOGLE_SESSION_HMAC_KEY);
  if (
    clientId === undefined || clientSecret === undefined || ownerEmail === undefined ||
    redirectUri === undefined || sessionHmacKey === undefined
  ) return { ok: false, code: "google_oidc_not_configured" };
  const configuredRedirect = configuredRedirectUri(redirectUri);
  if (
    configuredRedirect === undefined || sessionHmacKey.length < 32 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(ownerEmail)
  ) return { ok: false, code: "invalid_google_oidc_configuration" };
  return {
    ok: true,
    value: Object.freeze({ clientId, clientSecret, ownerEmail, redirectUri: configuredRedirect, sessionHmacKey })
  };
}

export function createGoogleOidcService(input: Readonly<{
  configuration: GoogleOidcConfiguration;
  createClient?: (configuration: GoogleOidcConfiguration) => GoogleOidcClient;
  now?: () => Date;
}>) {
  const client = input.createClient?.(input.configuration) ?? new OAuth2Client({
    clientId: input.configuration.clientId,
    clientSecret: input.configuration.clientSecret,
    redirectUri: input.configuration.redirectUri
  });
  const now = input.now ?? (() => new Date());
  const redirectOrigin = new URL(input.configuration.redirectUri).origin;
  const keyPromise = signingKey(input.configuration.sessionHmacKey);

  return Object.freeze({
    async start(requestOrigin: string): Promise<GoogleOidcStart | undefined> {
      if (requestOrigin !== redirectOrigin) return undefined;
      const verifier = await client.generateCodeVerifierAsync();
      if (verifier.codeChallenge === undefined || verifier.codeVerifier.length < 43) return undefined;
      const issuedAt = Math.floor(now().getTime() / 1_000);
      const transaction: OAuthTransaction = Object.freeze({
        v: 1,
        e: issuedAt + TRANSACTION_MAX_AGE_SECONDS,
        n: randomValue(),
        s: randomValue(),
        c: verifier.codeVerifier
      });
      const signed = await sign(await keyPromise, transaction);
      return Object.freeze({
        authorizationUrl: client.generateAuthUrl({
          access_type: "online",
          code_challenge: verifier.codeChallenge,
          code_challenge_method: CodeChallengeMethod.S256,
          nonce: transaction.n,
          prompt: "select_account",
          redirect_uri: input.configuration.redirectUri,
          response_type: "code",
          scope: ["openid", "email"],
          state: transaction.s
        }),
        setCookie: secureCookie(AUTH_TRANSACTION_COOKIE, signed.value, TRANSACTION_MAX_AGE_SECONDS)
      });
    },

    async finish(inputValue: Readonly<{
      cookieHeader: string | null;
      code: string | null;
      requestOrigin: string;
      state: string | null;
    }>): Promise<GoogleOidcCallbackResult> {
      const empty = Object.freeze({ ok: false as const, code: "access_denied" as const, clearCookie: clearCookie(AUTH_TRANSACTION_COOKIE) });
      if (inputValue.requestOrigin !== redirectOrigin || inputValue.code === null || inputValue.state === null) return empty;
      const transaction = await verify<OAuthTransaction>(await keyPromise, parseCookie(inputValue.cookieHeader, AUTH_TRANSACTION_COOKIE));
      const nowSeconds = Math.floor(now().getTime() / 1_000);
      if (!validTransaction(transaction, nowSeconds) || inputValue.state !== transaction.s) return empty;
      try {
        const result = await client.getToken({ code: inputValue.code, codeVerifier: transaction.c });
        const idToken = result.tokens.id_token;
        if (typeof idToken !== "string" || idToken.length === 0) return empty;
        const ticket = await client.verifyIdToken({ idToken, audience: input.configuration.clientId });
        const payload = ticket.getPayload();
        if (
          payload === undefined || !sameString(payload.iss, "https://accounts.google.com") ||
          !hasAudience(payload.aud, input.configuration.clientId) || payload.exp === undefined || payload.exp < nowSeconds ||
          payload.nonce !== transaction.n || payload.email_verified !== true ||
          payload.email !== input.configuration.ownerEmail || typeof payload.sub !== "string" ||
          !/^[A-Za-z0-9_-]{1,255}$/u.test(payload.sub)
        ) return empty;
        const session: OwnerSession = Object.freeze({ v: 1, e: nowSeconds + SESSION_MAX_AGE_SECONDS, s: payload.sub });
        const signed = await sign(await keyPromise, session);
        return Object.freeze({
          ok: true as const,
          setCookie: secureCookie(OWNER_SESSION_COOKIE, signed.value, SESSION_MAX_AGE_SECONDS),
          clearCookie: clearCookie(AUTH_TRANSACTION_COOKIE)
        });
      } catch {
        return empty;
      }
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
