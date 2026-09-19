import type { ConfirmedAgentMessage, SessionGeneration } from "../session/registrar-do.ts";
import type { ArchiveRecord, ArchiveStorage, ArchiveTombstone } from "./storage.ts";

export type ArchiveBundle = Readonly<{
  schemaVersion: "v1";
  session: Readonly<{
    sessionId: string;
    generation: number;
    startedAt: string;
    settingsSnapshot: SessionGeneration["settingsSnapshot"];
  }>;
  messages: readonly Readonly<{
    sequence: number;
    role: string;
    visibleTime: string;
    body: string;
    bodyFormat: "markdown";
    addressedTo?: string;
    confirmedAt: string;
  }>[];
}>;

export type ArchiveSealResult =
  | Readonly<{ ok: true; archiveId: string; replayed: boolean; manifest: ArchiveRecord["manifest"] }>
  | Readonly<{ ok: false; code: "invalid_archive_input" | "archive_conflict" | "session_deleted" | "archive_store_failed" }>;

export type ArchiveReadResult =
  | Readonly<{ ok: true; value: ArchiveBundle }>
  | Readonly<{ ok: false; code: "owner_confirmation_required" | "archive_not_found" | "archive_deleted" | "archive_integrity_failed" }>;

export type ArchiveDeleteResult =
  | Readonly<{ ok: true; replayed: boolean }>
  | Readonly<{ ok: false; code: "owner_confirmation_required" | "archive_not_found" | "archive_delete_failed" }>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const asBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function archiveIdFor(session: SessionGeneration): string {
  return `session-${session.sessionId}-${session.generation}`;
}

function validSession(session: SessionGeneration, messages: readonly ConfirmedAgentMessage[]): boolean {
  return session.sessionId.length > 0 && Number.isInteger(session.generation) && session.generation > 0 &&
    messages.length === session.nextSequence - 1 &&
    messages.every((message, index) =>
      message.generation === session.generation && message.sequence === index + 1 && message.body.length > 0
    );
}

/** Intentionally leaves internal event IDs and body hashes out of the export. */
function toBundle(session: SessionGeneration, messages: readonly ConfirmedAgentMessage[]): ArchiveBundle {
  return Object.freeze({
    schemaVersion: "v1" as const,
    session: Object.freeze({
      sessionId: session.sessionId,
      generation: session.generation,
      startedAt: session.startedAt,
      settingsSnapshot: structuredClone(session.settingsSnapshot)
    }),
    messages: Object.freeze(messages.map((message) => Object.freeze({
      sequence: message.sequence,
      role: message.role,
      visibleTime: message.visibleTime,
      body: message.body,
      bodyFormat: message.bodyFormat,
      ...(message.addressedTo === undefined ? {} : { addressedTo: message.addressedTo }),
      confirmedAt: message.confirmedAt
    })))
  });
}

function validKey(key: CryptoKey, requiredUsage: KeyUsage): boolean {
  const algorithm = key.algorithm as AesKeyAlgorithm;
  return key.type === "secret" && algorithm.name === "AES-GCM" && algorithm.length === 256 && key.usages.includes(requiredUsage);
}

function expectedArchiveId(value: string): boolean {
  return /^session-[A-Za-z0-9_-]{1,128}-[1-9][0-9]*$/.test(value);
}

export class ArchiveService {
  readonly #storage: ArchiveStorage;
  readonly #now: () => Date;

  constructor(input: Readonly<{ storage: ArchiveStorage; now: () => Date }>) {
    this.#storage = input.storage;
    this.#now = input.now;
  }

  async seal(input: Readonly<{
    session: SessionGeneration;
    messages: readonly ConfirmedAgentMessage[];
    key: CryptoKey;
  }>): Promise<ArchiveSealResult> {
    if (!validSession(input.session, input.messages) || !validKey(input.key, "encrypt")) {
      return { ok: false, code: "invalid_archive_input" };
    }
    const archiveId = archiveIdFor(input.session);
    const existingTombstone = await this.#storage.getTombstone(archiveId);
    if (existingTombstone !== undefined) return { ok: false, code: "session_deleted" };

    const bundle = toBundle(input.session, input.messages);
    const plaintext = JSON.stringify(bundle);
    const plaintextSha256 = await sha256(plaintext);
    const existing = await this.#storage.get(archiveId);
    if (existing !== undefined) {
      if (existing.manifest.plaintextSha256 !== plaintextSha256) return { ok: false, code: "archive_conflict" };
      if (existing.lifecycle !== "committed") return { ok: false, code: "archive_store_failed" };
      return { ok: true, archiveId, replayed: true, manifest: existing.manifest };
    }

    const manifest: ArchiveRecord["manifest"] = Object.freeze({
      schemaVersion: "v1",
      sessionId: input.session.sessionId,
      generation: input.session.generation,
      messageCount: input.messages.length,
      plaintextSha256,
      algorithm: "AES-GCM-256"
    });
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(JSON.stringify(manifest)) },
      input.key,
      encoder.encode(plaintext)
    );
    const staged: ArchiveRecord = Object.freeze({
      archiveId,
      lifecycle: "staged",
      createdAt: this.#now().toISOString(),
      manifest,
      ivBase64: asBase64(iv),
      ciphertextBase64: asBase64(new Uint8Array(ciphertext))
    });
    try {
      await this.#storage.stage(staged);
      const committed = await this.#storage.commit(archiveId);
      if (committed === undefined || committed.lifecycle !== "committed" || committed.manifest.plaintextSha256 !== plaintextSha256) {
        return { ok: false, code: "archive_store_failed" };
      }
      return { ok: true, archiveId, replayed: false, manifest };
    } catch {
      return { ok: false, code: "archive_store_failed" };
    }
  }

  async exportWholeSession(input: Readonly<{ archiveId: string; key: CryptoKey; ownerConfirmed: boolean }>): Promise<ArchiveReadResult> {
    if (!input.ownerConfirmed) return { ok: false, code: "owner_confirmation_required" };
    if (!expectedArchiveId(input.archiveId) || !validKey(input.key, "decrypt")) return { ok: false, code: "archive_integrity_failed" };
    if (await this.#storage.getTombstone(input.archiveId) !== undefined) return { ok: false, code: "archive_deleted" };
    const record = await this.#storage.get(input.archiveId);
    if (record === undefined || record.lifecycle !== "committed") return { ok: false, code: "archive_not_found" };
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: asArrayBuffer(fromBase64(record.ivBase64)), additionalData: encoder.encode(JSON.stringify(record.manifest)) },
        input.key,
        asArrayBuffer(fromBase64(record.ciphertextBase64))
      );
      const text = decoder.decode(plaintext);
      if (await sha256(text) !== record.manifest.plaintextSha256) return { ok: false, code: "archive_integrity_failed" };
      const bundle = JSON.parse(text) as ArchiveBundle;
      if (bundle.schemaVersion !== "v1" || bundle.session.sessionId !== record.manifest.sessionId ||
        bundle.session.generation !== record.manifest.generation || bundle.messages.length !== record.manifest.messageCount) {
        return { ok: false, code: "archive_integrity_failed" };
      }
      return { ok: true, value: bundle };
    } catch {
      return { ok: false, code: "archive_integrity_failed" };
    }
  }

  async deleteWholeSession(input: Readonly<{ archiveId: string; ownerConfirmed: boolean }>): Promise<ArchiveDeleteResult> {
    if (!input.ownerConfirmed) return { ok: false, code: "owner_confirmation_required" };
    if (!expectedArchiveId(input.archiveId)) return { ok: false, code: "archive_not_found" };
    const existingTombstone = await this.#storage.getTombstone(input.archiveId);
    if (existingTombstone !== undefined) return { ok: true, replayed: true };
    const record = await this.#storage.get(input.archiveId);
    if (record === undefined || record.lifecycle !== "committed") return { ok: false, code: "archive_not_found" };
    const tombstone: ArchiveTombstone = Object.freeze({
      archiveId: input.archiveId,
      deletedAt: this.#now().toISOString(),
      plaintextSha256: record.manifest.plaintextSha256
    });
    try {
      return await this.#storage.tombstone(input.archiveId, tombstone)
        ? { ok: true, replayed: false }
        : { ok: false, code: "archive_delete_failed" };
    } catch {
      return { ok: false, code: "archive_delete_failed" };
    }
  }
}
