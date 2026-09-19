import type { ArchiveRecord, ArchiveStorage, ArchiveTombstone } from "../../src/archive/storage.ts";

export class MemoryArchiveStorage implements ArchiveStorage {
  readonly records = new Map<string, ArchiveRecord>();
  readonly tombstones = new Map<string, ArchiveTombstone>();

  async get(archiveId: string): Promise<ArchiveRecord | undefined> {
    const value = this.records.get(archiveId);
    return value === undefined ? undefined : structuredClone(value);
  }
  async getTombstone(archiveId: string): Promise<ArchiveTombstone | undefined> {
    const value = this.tombstones.get(archiveId);
    return value === undefined ? undefined : structuredClone(value);
  }
  async stage(record: ArchiveRecord): Promise<void> {
    if (this.records.has(record.archiveId)) throw new Error("Duplicate archive.");
    this.records.set(record.archiveId, structuredClone(record));
  }
  async commit(archiveId: string): Promise<ArchiveRecord | undefined> {
    const value = this.records.get(archiveId);
    if (value?.lifecycle !== "staged") return undefined;
    const committed = { ...value, lifecycle: "committed" as const };
    this.records.set(archiveId, committed);
    return structuredClone(committed);
  }
  async tombstone(archiveId: string, tombstone: ArchiveTombstone): Promise<boolean> {
    if (!this.records.has(archiveId)) return false;
    this.records.delete(archiveId);
    this.tombstones.set(archiveId, structuredClone(tombstone));
    return true;
  }
}
