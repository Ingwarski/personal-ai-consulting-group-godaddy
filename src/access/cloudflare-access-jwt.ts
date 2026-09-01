/**
 * Cloudflare Access origin validation. The edge policy is useful but is not a
 * substitute for validating the signed assertion at the Worker origin.
 *
 * Only RS256 is accepted because this is the signing algorithm documented for
 * the Access application token. No identity, token, claim or verification
 * failure reason is returned to a caller.
 */
export type AccessPrincipal = Readonly<{ kind: "owner" }>;

export type AccessJwk = JsonWebKey & Readonly<{
  kid?: string;
  alg?: string;
  use?: string;
}>;

export type AccessJwksProvider = Readonly<{
  load: () => Promise<readonly AccessJwk[]>;
}>;

export type AccessJwtValidatorOptions = Readonly<{
  issuer: string;
  audience: string;
  ownerEmail: string;
  jwks: AccessJwksProvider;
  now: () => Date;
  clockSkewSeconds?: number;
  jwksTtlMilliseconds?: number;
}>;

type CachedJwks = Readonly<{
  expiresAt: number;
  keys: readonly AccessJwk[];
}>;

type JwtHeader = Readonly<{
  alg: string;
  kid: string;
}>;

type JwtClaims = Readonly<{
  iss: string;
  aud: string | readonly string[];
  exp: number;
  nbf?: number;
  email: string;
}>;

const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const DEFAULT_JWKS_TTL_MILLISECONDS = 300_000;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;

function base64UrlToBytes(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function parseJsonSegment<T>(segment: string): T | undefined {
  const bytes = base64UrlToBytes(segment);
  if (bytes === undefined) return undefined;

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as T : undefined;
  } catch {
    return undefined;
  }
}

function asJwtHeader(value: unknown): JwtHeader | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.alg !== "RS256" || typeof candidate.kid !== "string" || candidate.kid.length === 0) return undefined;
  return { alg: candidate.alg, kid: candidate.kid };
}

function asJwtClaims(value: unknown): JwtClaims | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const audience = candidate.aud;
  const validAudience = typeof audience === "string" || (Array.isArray(audience) && audience.every((item) => typeof item === "string"));
  if (
    typeof candidate.iss !== "string" ||
    !validAudience ||
    typeof candidate.exp !== "number" ||
    !Number.isFinite(candidate.exp) ||
    (candidate.nbf !== undefined && (typeof candidate.nbf !== "number" || !Number.isFinite(candidate.nbf))) ||
    typeof candidate.email !== "string"
  ) {
    return undefined;
  }

  return {
    iss: candidate.iss,
    aud: audience as string | readonly string[],
    exp: candidate.exp,
    ...(candidate.nbf === undefined ? {} : { nbf: candidate.nbf as number }),
    email: candidate.email
  };
}

function normaliseExactEmail(email: string): string {
  return email.trim().normalize("NFC").toLowerCase();
}

function includesAudience(audience: string | readonly string[], expected: string): boolean {
  return typeof audience === "string" ? audience === expected : audience.includes(expected);
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class CloudflareAccessJwtValidator {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #ownerEmail: string;
  readonly #jwks: AccessJwksProvider;
  readonly #now: () => Date;
  readonly #clockSkewSeconds: number;
  readonly #jwksTtlMilliseconds: number;
  #cached: CachedJwks | undefined;

  constructor(options: AccessJwtValidatorOptions) {
    this.#issuer = options.issuer;
    this.#audience = options.audience;
    this.#ownerEmail = normaliseExactEmail(options.ownerEmail);
    this.#jwks = options.jwks;
    this.#now = options.now;
    this.#clockSkewSeconds = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    this.#jwksTtlMilliseconds = options.jwksTtlMilliseconds ?? DEFAULT_JWKS_TTL_MILLISECONDS;
  }

  async verifyRequest(request: Request): Promise<AccessPrincipal | undefined> {
    const token = request.headers.get(ACCESS_ASSERTION_HEADER);
    if (token === null || token.length === 0 || token.length > MAX_ACCESS_TOKEN_LENGTH) return undefined;
    return this.verifyToken(token);
  }

  async verifyToken(token: string): Promise<AccessPrincipal | undefined> {
    const segments = token.split(".");
    if (segments.length !== 3) return undefined;
    const [headerSegment, claimsSegment, signatureSegment] = segments;
    if (headerSegment === undefined || claimsSegment === undefined || signatureSegment === undefined) return undefined;

    const header = asJwtHeader(parseJsonSegment<unknown>(headerSegment));
    const claims = asJwtClaims(parseJsonSegment<unknown>(claimsSegment));
    const signature = base64UrlToBytes(signatureSegment);
    if (header === undefined || claims === undefined || signature === undefined) return undefined;

    const key = await this.#getKey(header.kid);
    if (key === undefined) return undefined;

    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await crypto.subtle.importKey(
        "jwk",
        key,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
    } catch {
      return undefined;
    }

    const signingInput = new TextEncoder().encode(`${headerSegment}.${claimsSegment}`);
    const signatureValid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      cryptoKey,
      asArrayBuffer(signature),
      signingInput
    ).catch(() => false);
    if (!signatureValid) return undefined;

    const now = Math.floor(this.#now().getTime() / 1000);
    if (
      claims.iss !== this.#issuer ||
      !includesAudience(claims.aud, this.#audience) ||
      claims.exp + this.#clockSkewSeconds < now ||
      (claims.nbf !== undefined && claims.nbf - this.#clockSkewSeconds > now) ||
      normaliseExactEmail(claims.email) !== this.#ownerEmail
    ) {
      return undefined;
    }

    return Object.freeze({ kind: "owner" });
  }

  async #getKey(kid: string): Promise<AccessJwk | undefined> {
    const now = this.#now().getTime();
    const cached = this.#cached;
    if (cached !== undefined && cached.expiresAt > now) {
      const cachedKey = cached.keys.find((key) => key.kid === kid);
      if (cachedKey !== undefined) return cachedKey;
      // A key may rotate while a still-live cache is held. Refresh once.
      return this.#refreshAndFind(kid, now);
    }
    // An absent or expired cache already requires a fresh upstream read. A
    // second immediate fetch cannot observe a meaningful rotation window.
    return this.#refreshAndFind(kid, now);
  }

  async #refreshAndFind(kid: string, now: number): Promise<AccessJwk | undefined> {
    try {
      const keys = await this.#jwks.load();
      this.#cached = Object.freeze({
        keys: Object.freeze([...keys]),
        expiresAt: now + this.#jwksTtlMilliseconds
      });
      return this.#cached.keys.find((key) => key.kid === kid);
    } catch {
      return undefined;
    }
  }
}

export function createCloudflareAccessJwksProvider(
  issuer: string,
  request: typeof fetch = fetch
): AccessJwksProvider {
  const certificateUrl = new URL("/cdn-cgi/access/certs", issuer);
  return Object.freeze({
    async load(): Promise<readonly AccessJwk[]> {
      const response = await request(certificateUrl, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("Cloudflare Access signing keys are unavailable");
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { keys?: unknown }).keys)) {
        throw new Error("Cloudflare Access signing keys are invalid");
      }

      return (payload as { keys: unknown[] }).keys.filter(
        (key): key is AccessJwk =>
          typeof key === "object" &&
          key !== null &&
          (key as AccessJwk).kty === "RSA" &&
          (key as AccessJwk).alg === "RS256" &&
          typeof (key as AccessJwk).kid === "string"
      );
    }
  });
}
