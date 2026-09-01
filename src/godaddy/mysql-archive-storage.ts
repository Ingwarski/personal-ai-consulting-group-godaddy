import type { ArchiveRecord, ArchiveStorage, ArchiveTombstone } from "../archive/storage.ts";
import type { MySqlConnection, MySqlPool } from "./mysql-storage.ts";

export const GODADDY_ARCHIVES_TABLE = "personal_consultant_archives";
export const GODADDY_ARCHIVE_TOMBSTONES_TABLE = "personal_consultant_archive_tombstones";

type ArchiveRow = Readonly<{
  archiveId?: unknown;
  lifecycle?: unknown;
  createdAt?: unknown;
  manifest?: unknown;
  ivBase64?: unknown;
  ciphertextBase64?: unknown;
}>;

type TombstoneRow = Readonly<{
  archiveId?: unknown;
  deletedAt?: unknown;
  plaintextSha256?: unknown;
}>;

const SELECT_ARCHIVE = `SELECT archive_id AS archiveId, lifecycle, created_at AS createdAt, manifest, iv_base64 AS ivBase64, ciphertext_base64 AS ciphertextBase64
  FROM ${GODADDY_ARCHIVES_TABLE} WHERE archive_id = ? LIMIT 1`;
const SELECT_ARCHIVE_FOR_UPDATE = `${SELECT_ARCHIVE} FOR UPDATE`;
const SELECT_TOMBSTONE = `SELECT archive_id AS archiveId, deleted_at AS deletedAt, plaintext_sha256 AS plaintextSha256
  FROM ${GODADDY_ARCHIVE_TOMBSTONES_TABLE} WHERE archive_id = ? LIMIT 1`;
const SELECT_TOMBSTONE_FOR_UPDATE = `${SELECT_TOMBSTONE} FOR UPDATE`;
const INSERT_ARCHIVE = `INSERT INTO ${GODADDY_ARCHIVES_TABLE}
  (archive_id, lifecycle, created_at, manifest, iv_base64, ciphertext_base64)
  VALUES (?, ?, ?, CAST(? AS JSON), ?, ?)`;
const COMMIT_ARCHIVE = `UPDATE ${GODADDY_ARCHIVES_TABLE} SET lifecycle = 'committed'
  WHERE archive_id = ? AND lifecycle = 'staged'`;
const INSERT_TOMBSTONE = `INSERT INTO ${GODADDY_ARCHIVE_TOMBSTONES_TABLE}
  (archive_id, deleted_at, plaintext_sha256) VALUES (?, ?, ?)`;
const DELETE_ARCHIVE = `DELETE FROM ${GODADDY_ARCHIVES_TABLE} WHERE archive_id = ?`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parsedJson(value: unknown): unknown | undefined {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

function firstRow(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  return isRecord(value[0]) ? value[0] : undefined;
}

function archiveFromRow(value: unknown): ArchiveRecord | undefined {
  if (!isRecord(value)) return undefined;
  const row = value as ArchiveRow;
  const manifest = parsedJson(row.manifest);
  if (
    typeof row.archiveId !== "string" || (row.lifecycle !== "staged" && row.lifecycle !== "committed") ||
    typeof row.createdAt !== "string" || typeof row.ivBase64 !== "string" || typeof row.ciphertextBase64 !== "string" || !isRecord(manifest) ||
    manifest.schemaVersion !== "v1" || typeof manifest.sessionId !== "string" || !Number.isInteger(manifest.generation) ||
    !Number.isInteger(manifest.messageCount) || typeof manifest.plaintextSha256 !== "string" || manifest.algorithm !== "AES-GCM-256"
  ) return undefined;
  return Object.freeze({
    archiveId: row.archiveId,
    lifecycle: row.lifecycle,
    createdAt: row.createdAt,
    manifest: Object.freeze({
      schemaVersion: "v1" as const,
      sessionId: manifest.sessionId,
      generation: manifest.generation as number,
      messageCount: manifest.messageCount as number,
      plaintextSha256: manifest.plaintextSha256,
      algorithm: "AES-GCM-256" as const
    }),
    ivBase64: row.ivBase64,
    ciphertextBase64: row.ciphertextBase64
  });
}

function tombstoneFromRow(value: unknown): ArchiveTombstone | undefined {
  if (!isRecord(value)) return undefined;
  const row = value as TombstoneRow;
  if (typeof row.archiveId !== "string" || typeof row.deletedAt !== "string" || typeof row.plaintextSha256 !== "string") return undefined;
  return Object.freeze({ archiveId: row.archiveId, deletedAt: row.deletedAt, plaintextSha256: row.plaintextSha256 });
}

async function readArchive(executor: Pick<MySqlPool, "execute"> | MySqlConnection, statement: string, archiveId: string): Promise<ArchiveRecord | undefined> {
  const [rows] = await executor.execute(statement, [archiveId]);
  return archiveFromRow(firstRow(rows));
}

async function readTombstone(executor: Pick<MySqlPool, "execute"> | MySqlConnection, statement: string, archiveId: string): Promise<ArchiveTombstone | undefined> {
  const [rows] = await executor.execute(statement, [archiveId]);
  return tombstoneFromRow(firstRow(rows));
}

/**
 * Stores only AES-GCM ciphertext, IV and a content-free manifest. It provides
 * the ArchiveStorage lifecycle without reusing mutable session-state rows or
 * ever copying a plaintext transcript into the database.
 */
export class MySqlArchiveStorage implements ArchiveStorage {
  readonly #pool: MySqlPool;

  constructor(pool: MySqlPool) {
    this.#pool = pool;
  }

  get(archiveId: string): Promise<ArchiveRecord | undefined> {
    return readArchive(this.#pool, SELECT_ARCHIVE, archiveId);
  }

  getTombstone(archiveId: string): Promise<ArchiveTombstone | undefined> {
    return readTombstone(this.#pool, SELECT_TOMBSTONE, archiveId);
  }

  async stage(record: ArchiveRecord): Promise<void> {
    if (record.lifecycle !== "staged") throw new Error("Only a staged archive can enter persistent storage.");
    await this.#pool.execute(INSERT_ARCHIVE, [
      record.archiveId,
      record.lifecycle,
      record.createdAt,
      JSON.stringify(record.manifest),
      record.ivBase64,
      record.ciphertextBase64
    ]);
  }

  async commit(archiveId: string): Promise<ArchiveRecord | undefined> {
    await this.#pool.execute(COMMIT_ARCHIVE, [archiveId]);
    return this.get(archiveId);
  }

  async tombstone(archiveId: string, tombstone: ArchiveTombstone): Promise<boolean> {
    if (tombstone.archiveId !== archiveId) throw new Error("Archive tombstone target must match the archive being deleted.");
    const connection = await this.#pool.getConnection();
    try {
      await connection.beginTransaction();
      if (await readTombstone(connection, SELECT_TOMBSTONE_FOR_UPDATE, archiveId) !== undefined) {
        await connection.commit();
        return true;
      }
      const record = await readArchive(connection, SELECT_ARCHIVE_FOR_UPDATE, archiveId);
      if (record === undefined || record.lifecycle !== "committed") {
        await connection.commit();
        return false;
      }
      await connection.execute(INSERT_TOMBSTONE, [tombstone.archiveId, tombstone.deletedAt, tombstone.plaintextSha256]);
      await connection.execute(DELETE_ARCHIVE, [archiveId]);
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}
