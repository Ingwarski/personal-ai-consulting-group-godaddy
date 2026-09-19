import { createHash, createPublicKey, timingSafeEqual } from "node:crypto";
import { OAuth2Client } from "google-auth-library";

export type GoogleIdentity = Readonly<{
  issuer: string;
  subject: string;
  email: string;
  emailVerified: true;
}>;

export type GoogleIdentityProvider = Readonly<{
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): string;
  exchange(input: { code: string; codeVerifier: string; nonceHash: string; createdAt: number }): Promise<GoogleIdentity | undefined>;
}>;

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const RESPONSE_LIMIT = 64 * 1_024;
const TOKEN_LIMIT = 16 * 1_024;
const NETWORK_TIMEOUT_MS = 10_000;
const KEY_CACHE_LIMIT_SECONDS = 3_600;
const KEY_REFRESH_INTERVAL_SECONDS = 30;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const KID = /^[A-Za-z0-9_-]{1,128}$/u;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Never attach provider errors as a cause: library errors can include the JWT,
// response body or a request configuration containing the client secret.
const unavailable = (): Error => new Error("Google identity verification unavailable.");

function base64url(value: unknown, minimum: number, maximum: number): Buffer | undefined {
  if (typeof value !== "string" || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= minimum && decoded.length <= maximum && decoded.toString("base64url") === value ? decoded : undefined;
}

function parseToken(token: unknown): { jwt: string; kid: string; claims: Record<string, unknown> } | undefined {
  if (typeof token !== "string" || token.length > TOKEN_LIMIT) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const headerBytes = base64url(parts[0], 1, 2_048);
  const payloadBytes = base64url(parts[1], 1, 12_288);
  if (!headerBytes || !payloadBytes || !base64url(parts[2], 256, 1_024)) return undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const header: unknown = JSON.parse(decoder.decode(headerBytes));
  const claims: unknown = JSON.parse(decoder.decode(payloadBytes));
  if (!record(header) || !record(claims) || header.alg !== "RS256" || typeof header.kid !== "string" || !KID.test(header.kid) ||
    (header.typ !== undefined && header.typ !== "JWT") || Object.keys(header).some((key) => !["alg", "kid", "typ"].includes(key))) return undefined;
  return { jwt: token, kid: header.kid, claims };
}

async function deadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  let rejectAborted: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = () => reject(unavailable());
    controller.signal.addEventListener("abort", rejectAborted, { once: true });
  });
  try {
    // The explicit race also bounds a test/custom transport that ignores abort.
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", rejectAborted);
    controller.abort();
  }
}

async function boundedJson(response: Response, endpoint: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const cancelBody = (): void => { void response.body?.cancel().catch(() => {}); };
  const length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || (response.url !== "" && response.url !== endpoint) ||
    !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
    (length !== null && (!/^\d{1,10}$/u.test(length) || Number(length) > RESPONSE_LIMIT)) || !response.body || signal.aborted) {
    cancelBody();
    throw unavailable();
  }
  const reader = response.body.getReader();
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (signal.aborted) throw unavailable();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > RESPONSE_LIMIT) throw unavailable();
      chunks.push(part.value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
    if (!record(value)) throw unavailable();
    return value;
  } finally {
    cancel();
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function trustedKeys(value: Record<string, unknown>): Record<string, string> {
  if (!Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 16) throw unavailable();
  const keys: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const candidate of value.keys) {
    if (!record(candidate) || candidate.kty !== "RSA" || candidate.alg !== "RS256" || candidate.use !== "sig" ||
      typeof candidate.kid !== "string" || !KID.test(candidate.kid) || Object.hasOwn(keys, candidate.kid) ||
      Object.keys(candidate).some((key) => !["kty", "kid", "use", "alg", "n", "e", "key_ops"].includes(key)) ||
      (candidate.key_ops !== undefined && (!Array.isArray(candidate.key_ops) || candidate.key_ops.length !== 1 || candidate.key_ops[0] !== "verify")) ||
      !base64url(candidate.n, 256, 1_024) || !base64url(candidate.e, 1, 8)) throw unavailable();
    const publicKey = createPublicKey({ key: { kty: "RSA", n: candidate.n as string, e: candidate.e as string }, format: "jwk" });
    const bits = publicKey.asymmetricKeyDetails?.modulusLength;
    const exponent = publicKey.asymmetricKeyDetails?.publicExponent;
    if (publicKey.asymmetricKeyType !== "rsa" || !bits || bits < 2_048 || bits > 8_192 ||
      exponent === undefined || exponent < 3n || exponent > 4_294_967_295n || exponent % 2n !== 1n) throw unavailable();
    keys[candidate.kid] = publicKey.export({ format: "pem", type: "spki" }).toString();
  }
  return keys;
}

function cacheLifetime(headers: Headers): number {
  const cacheControl = headers.get("cache-control") ?? "";
  if (/(?:^|,)\s*(?:no-cache|no-store)(?:\s*(?:,|=)|$)/iu.test(cacheControl)) return 0;
  const matches = [...cacheControl.matchAll(/(?:^|,)\s*max-age\s*=\s*(\d+)(?=\s*(?:,|$))/giu)];
  const age = headers.get("age") ?? "0";
  if (matches.length !== 1 || !/^\d{1,10}$/u.test(age)) return 0;
  const maximum = Number(matches[0]?.[1]);
  return Number.isSafeInteger(maximum) ? Math.max(0, Math.min(maximum - Number(age), KEY_CACHE_LIMIT_SECONDS)) : 0;
}

export function createGoogleIdentityProvider(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetcher?: typeof fetch;
  now?: () => Date;
}): GoogleIdentityProvider {
  const { clientId, clientSecret, redirectUri } = input;
  try {
    if (typeof clientId !== "string" || typeof clientSecret !== "string" || typeof redirectUri !== "string") throw unavailable();
    const redirect = new URL(redirectUri);
    if (!clientId || clientId.length > 512 || /\s/u.test(clientId) ||
      !clientSecret || clientSecret.length > 4_096 || /[\s\u0000-\u001f\u007f]/u.test(clientSecret) ||
      redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.search || redirect.hash ||
      redirect.pathname !== "/auth/google/callback" || redirect.href !== redirectUri) throw unavailable();
  } catch {
    throw unavailable();
  }
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? (() => new Date());
  const seconds = (): number => Math.floor(now().getTime() / 1_000);
  const verifier = new OAuth2Client({ clientId });
  let cache: { keys: Record<string, string>; expiresAt: number } | undefined;
  let refreshing: Promise<Record<string, string> | undefined> | undefined;
  let nextRefreshAt = 0;

  const keyFor = async (kid: string): Promise<string | undefined> => {
    const time = seconds();
    if (!Number.isSafeInteger(time)) return undefined;
    if (cache && cache.expiresAt > time && Object.hasOwn(cache.keys, kid)) return cache.keys[kid];
    if (!refreshing) {
      // Unknown keys, failures and concurrent callbacks cannot cause a JWKS
      // request storm. A new flow can retry after this bounded cooldown.
      if (time < nextRefreshAt) return undefined;
      nextRefreshAt = time + KEY_REFRESH_INTERVAL_SECONDS;
      refreshing = deadline(async (signal) => {
        const response = await fetcher(JWKS_ENDPOINT, {
          method: "GET", redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
          headers: { Accept: "application/json" }, signal
        });
        const keys = trustedKeys(await boundedJson(response, JWKS_ENDPOINT, signal));
        // Count retrieval time against freshness, rather than extending the
        // server's cache lifetime by however long the response took to arrive.
        const expiresAt = time + cacheLifetime(response.headers);
        cache = { keys, expiresAt };
        return keys;
      }).catch(() => undefined).finally(() => { refreshing = undefined; });
    }
    const keys = await refreshing;
    return keys && Object.hasOwn(keys, kid) ? keys[kid] : undefined;
  };

  const claimsMatch = (claims: Record<string, unknown>, nonceHash: string, createdAt: number): boolean => {
    const time = seconds();
    return Number.isSafeInteger(time) && Number.isSafeInteger(createdAt) && createdAt <= time && createdAt + 600 > time &&
      typeof claims.iss === "string" && ISSUERS.includes(claims.iss) && claims.aud === clientId &&
      (claims.azp === undefined || claims.azp === clientId) &&
      Number.isSafeInteger(claims.exp) && Number.isSafeInteger(claims.iat) &&
      (claims.exp as number) > time && (claims.exp as number) > (claims.iat as number) &&
      (claims.iat as number) <= time + 60 && (claims.iat as number) >= createdAt - 60 &&
      (claims.nbf === undefined || (Number.isSafeInteger(claims.nbf) && (claims.nbf as number) <= time)) &&
      typeof claims.sub === "string" && /^[\u0021-\u007e]{1,255}$/u.test(claims.sub) &&
      typeof claims.email === "string" && claims.email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(claims.email) &&
      claims.email_verified === true && typeof claims.nonce === "string" && RANDOM_VALUE.test(claims.nonce) && HASH.test(nonceHash) &&
      timingSafeEqual(createHash("sha256").update(claims.nonce).digest(), Buffer.from(nonceHash, "hex"));
  };

  return Object.freeze({
    authorizationUrl({ state, nonce, codeChallenge }) {
      if (!RANDOM_VALUE.test(state) || !RANDOM_VALUE.test(nonce) || !RANDOM_VALUE.test(codeChallenge)) throw unavailable();
      const url = new URL(AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email",
        prompt: "select_account", state, nonce, code_challenge: codeChallenge, code_challenge_method: "S256"
      }).toString();
      return url.href;
    },
    async exchange(exchangeInput) {
      try {
        const { code, codeVerifier, nonceHash, createdAt } = exchangeInput;
        if (typeof code !== "string" || code.length < 1 || code.length > 4_096 || /[\s\u0000-\u001f\u007f]/u.test(code) ||
          typeof codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/u.test(codeVerifier) || !HASH.test(nonceHash) ||
          !Number.isSafeInteger(createdAt) || createdAt > seconds() || createdAt + 600 <= seconds()) return undefined;
        return await deadline(async (signal) => {
          const response = await fetcher(TOKEN_ENDPOINT, {
            method: "POST", redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal,
            headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
              grant_type: "authorization_code", code, code_verifier: codeVerifier
            })
          });
          const tokenResponse = await boundedJson(response, TOKEN_ENDPOINT, signal);
          if (Object.hasOwn(tokenResponse, "error")) return undefined;
          const token = parseToken(tokenResponse.id_token);
          if (!token || !claimsMatch(token.claims, nonceHash, createdAt)) return undefined;
          const key = await keyFor(token.kid);
          if (!key || signal.aborted) return undefined;
          // Only the matched key from the fixed Google endpoint is supplied;
          // the library never performs discovery, a retry or its own transport.
          await verifier.verifySignedJwtWithCertsAsync(token.jwt, { [token.kid]: key }, clientId, ISSUERS);
          // Network/key verification time cannot extend expiry or flow lifetime.
          if (signal.aborted || !claimsMatch(token.claims, nonceHash, createdAt)) return undefined;
          return Object.freeze({
            issuer: ISSUERS[0]!, subject: token.claims.sub as string,
            email: (token.claims.email as string).toLowerCase(), emailVerified: true as const
          });
        });
      } catch {
        return undefined;
      }
    }
  });
}
