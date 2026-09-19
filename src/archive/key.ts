function decodeKey(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || value.length < 43 || value.length > 64) return undefined;
  try {
    const bytes = /^[a-f0-9]{64}$/iu.test(value)
      ? Buffer.from(value, "hex")
      : Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    return bytes.byteLength === 32 ? new Uint8Array(bytes) : undefined;
  } catch {
    return undefined;
  }
}

/** Imports the application-owned archive key without making it extractable. */
export async function importArchiveEncryptionKey(value: unknown): Promise<CryptoKey | undefined> {
  const bytes = decodeKey(value);
  if (bytes === undefined) return undefined;
  try {
    const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally {
    bytes.fill(0);
  }
}
