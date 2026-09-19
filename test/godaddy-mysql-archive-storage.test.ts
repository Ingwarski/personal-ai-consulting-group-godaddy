import assert from "node:assert/strict";
import test from "node:test";

import type { ArchiveRecord } from "../src/archive/storage.ts";
import { MySqlArchiveStorage } from "../src/godaddy/mysql-archive-storage.ts";
import type { MySqlConnection, MySqlPool } from "../src/godaddy/mysql-storage.ts";

type State = {
  archives: Map<string, Record<string, unknown>>;
  tombstones: Map<string, Record<string, unknown>>;
};

class MemoryConnection implements MySqlConnection {
  readonly #pool: MemoryPool;
  #working: State | undefined;

  constructor(pool: MemoryPool) {
    this.#pool = pool;
  }

  async beginTransaction() {
    this.#working = {
      archives: new Map(this.#pool.state.archives),
      tombstones: new Map(this.#pool.state.tombstones)
    };
  }

  async commit() {
    if (this.#working === undefined) throw new Error("transaction not started");
    this.#pool.state = this.#working;
  }

  async rollback() {}
  release() {}

  execute(statement: string, values: readonly unknown[]) {
    return this.#pool.executeAgainst(this.#working ?? this.#pool.state, statement, values);
  }
}

class MemoryPool implements MySqlPool {
  state: State = { archives: new Map(), tombstones: new Map() };

  async getConnection() {
    return new MemoryConnection(this);
  }

  execute(statement: string, values: readonly unknown[]) {
    return this.executeAgainst(this.state, statement, values);
  }

  async executeAgainst(state: State, statement: string, values: readonly unknown[]) {
    const archiveId = values[0];
    if (typeof archiveId !== "string") throw new Error("invalid archive fixture call");
    const tombstoneStatement = statement.includes("personal_consultant_archive_tombstones");
    const archiveStatement = statement.includes("personal_consultant_archives");
    if (statement.startsWith("SELECT")) {
      const row = tombstoneStatement ? state.tombstones.get(archiveId) : state.archives.get(archiveId);
      return [row === undefined ? [] : [row], []] as const;
    }
    if (statement.startsWith("INSERT") && archiveStatement) {
      state.archives.set(archiveId, {
        archiveId,
        lifecycle: values[1],
        createdAt: values[2],
        manifest: values[3],
        ivBase64: values[4],
        ciphertextBase64: values[5]
      });
      return [{ affectedRows: 1 }, []] as const;
    }
    if (statement.startsWith("UPDATE")) {
      const row = state.archives.get(archiveId);
      if (row !== undefined && row.lifecycle === "staged") row.lifecycle = "committed";
      return [{ affectedRows: row === undefined ? 0 : 1 }, []] as const;
    }
    if (statement.startsWith("INSERT") && tombstoneStatement) {
      state.tombstones.set(archiveId, { archiveId, deletedAt: values[1], plaintextSha256: values[2] });
      return [{ affectedRows: 1 }, []] as const;
    }
    if (statement.startsWith("DELETE")) {
      state.archives.delete(archiveId);
      return [{ affectedRows: 1 }, []] as const;
    }
    throw new Error(`Unhandled fixture statement: ${statement}`);
  }
}

const staged: ArchiveRecord = Object.freeze({
  archiveId: "session-archive-session-1",
  lifecycle: "staged",
  createdAt: "2026-09-02T12:00:00.000Z",
  manifest: Object.freeze({
    schemaVersion: "v1",
    sessionId: "archive-session",
    generation: 1,
    messageCount: 1,
    plaintextSha256: "a".repeat(64),
    algorithm: "AES-GCM-256"
  }),
  ivBase64: "aXYtdGVzdC1ieXRlcw==",
  ciphertextBase64: "encrypted-ciphertext-only"
});

test("GoDaddy archive storage commits ciphertext then irreversibly replaces it with a tombstone", async () => {
  const storage = new MySqlArchiveStorage(new MemoryPool());
  await storage.stage(staged);
  assert.deepEqual(await storage.get(staged.archiveId), staged);

  const committed = await storage.commit(staged.archiveId);
  assert.deepEqual(committed, { ...staged, lifecycle: "committed" });
  const tombstone = {
    archiveId: staged.archiveId,
    deletedAt: "2026-09-02T13:00:00.000Z",
    plaintextSha256: staged.manifest.plaintextSha256
  } as const;
  assert.equal(await storage.tombstone(staged.archiveId, tombstone), true);
  assert.equal(await storage.get(staged.archiveId), undefined);
  assert.deepEqual(await storage.getTombstone(staged.archiveId), tombstone);
  assert.equal(await storage.tombstone(staged.archiveId, tombstone), true);
});
