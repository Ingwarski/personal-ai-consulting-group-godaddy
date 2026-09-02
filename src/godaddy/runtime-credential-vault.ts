import { webcrypto } from "node:crypto";

const VAULT_VERSION = "v1";
const MAX_CREDENTIAL_BYTES = 64 * 1024;

export interface RuntimeCredentialStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export type RuntimeCredentialVault = Readonly<{
  read: (key: string) => Promise<Uint8Array | undefined>;
  write: (key: string, value: Uint8Array) => Promise<void>;
}>;

type SealedCredential = Readonly<{
  version: typeof VAULT_VERSION;
  ivBase64: string;
  ciphertextBase64: string;
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const safeKey = (value: string): boolean => /^[a-z0-9_-]{3,128}$/u.test(value);

const safeRootSecret = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 32 && value.length <= 4096;

const encodeBase64 = (value: Uint8Array): string => Buffer.from(value).toString("base64");

function decodeBase64(value: unknown, maximum = MAX_CREDENTIAL_BYTES + 64): Uint8Array | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maximum * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.byteLength <= maximum ? new Uint8Array(decoded) : undefined;
  } catch {
    return undefined;
  }
}

function parseSealedCredential(value: unknown): SealedCredential | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const iv = decodeBase64(record.ivBase64, 16);
  const ciphertext = decodeBase64(record.ciphertextBase64);
  if (record.version !== VAULT_VERSION || iv === undefined || iv.byteLength !== 12 || ciphertext === undefined || ciphertext.byteLength < 17) {
    return undefined;
  }
  return Object.freeze({
    version: VAULT_VERSION,
    ivBase64: record.ivBase64 as string,
    ciphertextBase64: record.ciphertextBase64 as string
  });
}

async function deriveKey(rootSecret: string, credentialKey: string): Promise<CryptoKey> {
  const material = await webcrypto.subtle.importKey("raw", encoder.encode(rootSecret), "HKDF", false, ["deriveKey"]);
  return webcrypto.subtle.deriveKey({
    name: "HKDF",
    hash: "SHA-256",
    salt: encoder.encode("personal-consultant-godaddy-runtime-v1"),
    info: encoder.encode(`credential:${credentialKey}`)
  }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/**
 * Seals short-lived runtime credentials before the only persistent Node-hosting
 * state store sees them.  The root is the existing, independently random CSRF
 * secret; HKDF derives a different AES-GCM key for each credential purpose.
 * Neither raw credentials nor the root key are ever serialized, logged, or
 * exposed through a response.
 */
export function createRuntimeCredentialVault(input: Readonly<{
  storage: RuntimeCredentialStorage;
  rootSecret: unknown;
}>): RuntimeCredentialVault | undefined {
  if (!safeRootSecret(input.rootSecret)) return undefined;
  const rootSecret = input.rootSecret;

  return Object.freeze({
    async read(key: string): Promise<Uint8Array | undefined> {
      if (!safeKey(key)) return undefined;
      const sealed = parseSealedCredential(await input.storage.get<unknown>(key));
      if (sealed === undefined) return undefined;
      const iv = decodeBase64(sealed.ivBase64, 16);
      const ciphertext = decodeBase64(sealed.ciphertextBase64);
      if (iv === undefined || ciphertext === undefined) return undefined;
      try {
        const cryptoKey = await deriveKey(rootSecret, key);
        const plaintext = new Uint8Array(await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext));
        return plaintext.byteLength <= MAX_CREDENTIAL_BYTES ? plaintext : undefined;
      } catch {
        return undefined;
      }
    },
    async write(key: string, value: Uint8Array): Promise<void> {
      if (!safeKey(key) || value.byteLength === 0 || value.byteLength > MAX_CREDENTIAL_BYTES) {
        throw new Error("Runtime credential is invalid.");
      }
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const cryptoKey = await deriveKey(rootSecret, key);
      const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, value));
      await input.storage.put<SealedCredential>(key, Object.freeze({
        version: VAULT_VERSION,
        ivBase64: encodeBase64(iv),
        ciphertextBase64: encodeBase64(ciphertext)
      }));
    }
  });
}

export const runtimeCredentialVaultPurpose = (): string => "encrypted-credential-store";

export const runtimeCredentialVaultText = (value: Uint8Array): string => decoder.decode(value);
