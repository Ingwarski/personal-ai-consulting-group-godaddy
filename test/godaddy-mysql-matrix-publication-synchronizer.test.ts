import assert from "node:assert/strict";
import test from "node:test";

import {
  MatrixPublicationSynchronizationError,
  MySqlMatrixPublicationSynchronizer
} from "../src/godaddy/mysql-matrix-publication-synchronizer.ts";
import type { MySqlConnection, MySqlPool } from "../src/godaddy/mysql-storage.ts";

class LockConnection implements MySqlConnection {
  readonly calls: string[] = [];
  acquired = 1;
  released = 1;
  leasedCount: number | string = 0;
  releaseCalls = 0;
  destroyCalls = 0;

  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  release() { this.releaseCalls += 1; }
  destroy() { this.destroyCalls += 1; }

  async execute(statement: string, _values: readonly unknown[]) {
    if (statement.includes("GET_LOCK")) {
      this.calls.push("acquire");
      return [[{ acquired: this.acquired }], []] as const;
    }
    if (statement.includes("RELEASE_LOCK")) {
      this.calls.push("release-lock");
      return [[{ released: this.released }], []] as const;
    }
    if (statement.includes("COUNT(*)")) {
      this.calls.push("inspect-leases");
      return [[{ leasedCount: this.leasedCount }], []] as const;
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }
}

class LockPool implements MySqlPool {
  readonly connection = new LockConnection();
  async getConnection() { return this.connection; }
  async execute(): Promise<readonly [unknown, unknown]> { throw new Error("unused"); }
}

test("publication permit holds the cross-process lock through Matrix acceptance persistence", async () => {
  const pool = new LockPool();
  const synchronizer = new MySqlMatrixPublicationSynchronizer(pool, 1);
  const value = await synchronizer.withPublicationPermit(async () => {
    pool.connection.calls.push("send");
    pool.connection.calls.push("mark-accepted");
    return "accepted";
  });
  assert.equal(value, "accepted");
  assert.deepEqual(pool.connection.calls, ["acquire", "send", "mark-accepted", "release-lock"]);
  assert.equal(pool.connection.releaseCalls, 1);
});

test("generation fence refuses an unresolved lease and never invokes cancellation", async () => {
  const pool = new LockPool();
  pool.connection.leasedCount = "1";
  let fenced = false;
  await assert.rejects(
    new MySqlMatrixPublicationSynchronizer(pool, 1).withGenerationFence({ generation: 7 }, async () => {
      fenced = true;
    }),
    (error: unknown) => error instanceof MatrixPublicationSynchronizationError && error.code === "publication_unresolved"
  );
  assert.equal(fenced, false);
  assert.deepEqual(pool.connection.calls, ["acquire", "inspect-leases", "release-lock"]);
});

test("generation fence runs pending-only cancellation while still holding the lock", async () => {
  const pool = new LockPool();
  await new MySqlMatrixPublicationSynchronizer(pool, 1).withGenerationFence({ generation: 4 }, async () => {
    pool.connection.calls.push("fence-pending");
  });
  assert.deepEqual(pool.connection.calls, ["acquire", "inspect-leases", "fence-pending", "release-lock"]);
});

test("lock timeout fails closed without running the callback", async () => {
  const pool = new LockPool();
  pool.connection.acquired = 0;
  let published = false;
  await assert.rejects(
    new MySqlMatrixPublicationSynchronizer(pool, 1).withPublicationPermit(async () => { published = true; }),
    (error: unknown) => error instanceof MatrixPublicationSynchronizationError && error.code === "publication_lock_unavailable"
  );
  assert.equal(published, false);
  assert.equal(pool.connection.releaseCalls, 1);
  assert.equal(pool.connection.destroyCalls, 0);
});

test("an indeterminate acquisition response destroys the connection", async () => {
  const pool = new LockPool();
  pool.connection.acquired = 2;
  await assert.rejects(
    new MySqlMatrixPublicationSynchronizer(pool, 1).withPublicationPermit(async () => undefined),
    (error: unknown) => error instanceof MatrixPublicationSynchronizationError && error.code === "publication_lock_unavailable"
  );
  assert.equal(pool.connection.releaseCalls, 0);
  assert.equal(pool.connection.destroyCalls, 1);
});

test("a failed lock release destroys the connection instead of pooling a held lock", async () => {
  const pool = new LockPool();
  pool.connection.released = 0;
  await assert.rejects(
    new MySqlMatrixPublicationSynchronizer(pool, 1).withPublicationPermit(async () => undefined),
    (error: unknown) => error instanceof MatrixPublicationSynchronizationError && error.code === "publication_lock_release_failed"
  );
  assert.equal(pool.connection.releaseCalls, 0);
  assert.equal(pool.connection.destroyCalls, 1);
});
