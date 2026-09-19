export type ArchiveLifecycle = "staged" | "committed";

export type ArchiveRecord = Readonly<{
  archiveId: string;
  lifecycle: ArchiveLifecycle;
  createdAt: string;
  manifest: Readonly<{
    schemaVersion: "v1";
    sessionId: string;
    generation: number;
    messageCount: number;
    plaintextSha256: string;
    algorithm: "AES-GCM-256";
  }>;
  ivBase64: string;
  ciphertextBase64: string;
}>;

/**
 * Production storage maps stage/commit/tombstone to encrypted whole-session
 * records plus a small metadata ledger. It deliberately exposes no
 * per-message mutation operation.
 */
export interface ArchiveStorage {
  get(archiveId: string): Promise<ArchiveRecord | undefined>;
  getTombstone(archiveId: string): Promise<ArchiveTombstone | undefined>;
  stage(record: ArchiveRecord): Promise<void>;
  commit(archiveId: string): Promise<ArchiveRecord | undefined>;
  tombstone(archiveId: string, tombstone: ArchiveTombstone): Promise<boolean>;
}

export type ArchiveTombstone = Readonly<{
  archiveId: string;
  deletedAt: string;
  plaintextSha256: string;
}>;
