import assert from "node:assert/strict";
import test from "node:test";

import { R2ArchiveStorage } from "../src/cloudflare/r2-archive-storage.ts";
import type { ArchiveRecord, ArchiveTombstone } from "../src/archive/storage.ts";

function fakeBucket() {
  const objects = new Map<string, string>();
  const bucket = {
    get: async (key: string) => {
      const body = objects.get(key);
      return body === undefined ? null : { json: async <T>() => JSON.parse(body) as T };
    },
    put: async (key: string, body: string) => {
      objects.set(key, body);
      return {};
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    }
  };
  return { objects, bucket: bucket as unknown as R2Bucket };
}

const staged: ArchiveRecord = {
  archiveId: "session-test-1",
  lifecycle: "staged",
  createdAt: "2026-08-16T18:00:00.000Z",
  manifest: {
    schemaVersion: "v1", sessionId: "test", generation: 1, messageCount: 2,
    plaintextSha256: "a".repeat(64), algorithm: "AES-GCM-256"
  },
  ivBase64: "AAAAAAAAAAAAAAAA",
  ciphertextBase64: "AQID"
};

test("maps staged, committed and tombstoned whole-session archive records to separate R2 paths", async () => {
  const fake = fakeBucket();
  const storage = new R2ArchiveStorage(fake.bucket);
  await storage.stage(staged);
  assert.equal((await storage.get(staged.archiveId)), undefined);
  assert.match([...fake.objects.keys()][0] ?? "", /archive-staging/);
  assert.equal((await storage.commit(staged.archiveId))?.lifecycle, "committed");
  assert.equal((await storage.get(staged.archiveId))?.lifecycle, "committed");
  assert.equal([...fake.objects.keys()].some((key) => key.includes("archive-staging")), false);

  const tombstone: ArchiveTombstone = {
    archiveId: staged.archiveId,
    deletedAt: "2026-08-16T18:01:00.000Z",
    plaintextSha256: staged.manifest.plaintextSha256
  };
  assert.equal(await storage.tombstone(staged.archiveId, tombstone), true);
  assert.equal(await storage.get(staged.archiveId), undefined);
  assert.deepEqual(await storage.getTombstone(staged.archiveId), tombstone);
  assert.equal([...fake.objects.keys()].every((key) => !key.includes("archive/test-1.json")), true);
});
