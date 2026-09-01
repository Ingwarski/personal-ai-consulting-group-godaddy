import type { ArchiveRecord, ArchiveStorage, ArchiveTombstone } from "../archive/storage.ts";

const archiveKey = (archiveId: string): string => `personal-ai-consulting-group/v1/archive/${archiveId}.json`;
const stagedKey = (archiveId: string): string => `personal-ai-consulting-group/v1/archive-staging/${archiveId}.json`;
const tombstoneKey = (archiveId: string): string => `personal-ai-consulting-group/v1/archive-tombstone/${archiveId}.json`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArchiveRecord(value: unknown): ArchiveRecord | undefined {
  if (!isRecord(value) || typeof value.archiveId !== "string" || (value.lifecycle !== "staged" && value.lifecycle !== "committed") ||
    typeof value.createdAt !== "string" || typeof value.ivBase64 !== "string" || typeof value.ciphertextBase64 !== "string" || !isRecord(value.manifest)) return undefined;
  const manifest = value.manifest;
  if (manifest.schemaVersion !== "v1" || typeof manifest.sessionId !== "string" || !Number.isInteger(manifest.generation) ||
    !Number.isInteger(manifest.messageCount) || typeof manifest.plaintextSha256 !== "string" || manifest.algorithm !== "AES-GCM-256") return undefined;
  return value as ArchiveRecord;
}

function asTombstone(value: unknown): ArchiveTombstone | undefined {
  if (!isRecord(value) || typeof value.archiveId !== "string" || typeof value.deletedAt !== "string" || typeof value.plaintextSha256 !== "string") return undefined;
  return value as ArchiveTombstone;
}

async function readJson<T>(bucket: R2Bucket, key: string, parser: (value: unknown) => T | undefined): Promise<T | undefined> {
  const object = await bucket.get(key);
  if (object === null) return undefined;
  return parser(await object.json<unknown>());
}

/**
 * R2 is the encrypted-blob store only. A single Registrar/close coordinator
 * serializes a session's lifecycle; this adapter never exposes a message edit.
 */
export class R2ArchiveStorage implements ArchiveStorage {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  get(archiveId: string): Promise<ArchiveRecord | undefined> {
    return readJson(this.#bucket, archiveKey(archiveId), asArchiveRecord);
  }

  getTombstone(archiveId: string): Promise<ArchiveTombstone | undefined> {
    return readJson(this.#bucket, tombstoneKey(archiveId), asTombstone);
  }

  async stage(record: ArchiveRecord): Promise<void> {
    const existing = await this.#bucket.get(stagedKey(record.archiveId));
    if (existing !== null) throw new Error("archive staging object already exists");
    await this.#bucket.put(stagedKey(record.archiveId), JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" }
    });
  }

  async commit(archiveId: string): Promise<ArchiveRecord | undefined> {
    const existing = await this.get(archiveId);
    if (existing !== undefined) return existing;
    const staged = await readJson(this.#bucket, stagedKey(archiveId), asArchiveRecord);
    if (staged === undefined || staged.lifecycle !== "staged") return undefined;
    const committed: ArchiveRecord = Object.freeze({ ...staged, lifecycle: "committed" });
    await this.#bucket.put(archiveKey(archiveId), JSON.stringify(committed), {
      httpMetadata: { contentType: "application/json" }
    });
    await this.#bucket.delete(stagedKey(archiveId));
    return committed;
  }

  async tombstone(archiveId: string, tombstone: ArchiveTombstone): Promise<boolean> {
    const existing = await this.getTombstone(archiveId);
    if (existing !== undefined) return true;
    const record = await this.get(archiveId);
    if (record === undefined || record.lifecycle !== "committed") return false;
    await this.#bucket.put(tombstoneKey(archiveId), JSON.stringify(tombstone), {
      httpMetadata: { contentType: "application/json" }
    });
    await this.#bucket.delete([archiveKey(archiveId), stagedKey(archiveId)]);
    return true;
  }
}
