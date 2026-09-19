export type CsrfBinding = Readonly<{
  principal: "owner";
  audience: string;
  origin: string;
}>;

export type CsrfTokenService = Readonly<{
  issue: (binding: CsrfBinding, expiresAt: Date) => Promise<string>;
  verify: (token: string | null, binding: CsrfBinding) => Promise<boolean>;
}>;

type TokenPayload = Readonly<{
  v: 1;
  p: "owner";
  a: string;
  o: string;
  e: number;
}>;

const MAX_TOKEN_LENGTH = 4096;

function toBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function payloadFor(binding: CsrfBinding, expiresAt: Date): TokenPayload {
  return Object.freeze({
    v: 1,
    p: binding.principal,
    a: binding.audience,
    o: binding.origin,
    e: Math.floor(expiresAt.getTime() / 1000)
  });
}

function parsePayload(value: Uint8Array): TokenPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.v !== 1 ||
      candidate.p !== "owner" ||
      typeof candidate.a !== "string" ||
      typeof candidate.o !== "string" ||
      typeof candidate.e !== "number" ||
      !Number.isFinite(candidate.e)
    ) {
      return undefined;
    }
    return { v: 1, p: "owner", a: candidate.a, o: candidate.o, e: candidate.e };
  } catch {
    return undefined;
  }
}

export function createCsrfTokenService(input: Readonly<{ key: CryptoKey; now: () => Date }>): CsrfTokenService {
  return Object.freeze({
    async issue(binding: CsrfBinding, expiresAt: Date): Promise<string> {
      const payload = new TextEncoder().encode(JSON.stringify(payloadFor(binding, expiresAt)));
      const payloadSegment = toBase64Url(payload);
      const signature = await crypto.subtle.sign("HMAC", input.key, new TextEncoder().encode(payloadSegment));
      return `${payloadSegment}.${toBase64Url(new Uint8Array(signature))}`;
    },

    async verify(token: string | null, binding: CsrfBinding): Promise<boolean> {
      if (token === null || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
      const segments = token.split(".");
      if (segments.length !== 2) return false;
      const [payloadSegment, signatureSegment] = segments;
      if (payloadSegment === undefined || signatureSegment === undefined) return false;
      const payloadBytes = fromBase64Url(payloadSegment);
      const signature = fromBase64Url(signatureSegment);
      if (payloadBytes === undefined || signature === undefined) return false;

      const signatureValid = await crypto.subtle.verify(
        "HMAC",
        input.key,
        signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) as ArrayBuffer,
        new TextEncoder().encode(payloadSegment)
      ).catch(() => false);
      if (!signatureValid) return false;

      const payload = parsePayload(payloadBytes);
      const now = Math.floor(input.now().getTime() / 1000);
      return payload !== undefined &&
        payload.e >= now &&
        payload.p === binding.principal &&
        payload.a === binding.audience &&
        payload.o === binding.origin;
    }
  });
}

export async function importCsrfHmacKey(secret: string): Promise<CryptoKey | undefined> {
  if (secret.length < 32) return undefined;
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  ).catch(() => undefined);
}
