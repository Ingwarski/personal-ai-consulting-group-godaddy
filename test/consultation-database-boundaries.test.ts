import assert from "node:assert/strict";
import test from "node:test";
import { createConsultationLeadership } from "../src/godaddy/consultation-leadership.ts";
import { MySqlMatrixOutbox } from "../src/godaddy/mysql-matrix-outbox.ts";
import type { MySqlConnection, MySqlPool } from "../src/godaddy/mysql-storage.ts";

function fixture() {
  const statements: string[] = [];
  let acquired: unknown = 1, owned: unknown = 1, released: unknown = 1;
  let fail: "acquire" | "check" | "release" | undefined;
  let borrows = 0, returns = 0, destroys = 0;
  const connection: MySqlConnection = {
    async execute(statement, values) {
      statements.push(statement);
      assert.deepEqual(values, ["personal-consultant:consultation-worker:v1"]);
      const operation = statement.includes("GET_LOCK") ? "acquire" : statement.includes("IS_USED_LOCK") ? "check" : "release";
      if (fail === operation) throw new Error("Private database diagnostic must not escape.");
      return [[operation === "acquire" ? { acquired } : operation === "check" ? { owned } : { released }], []];
    },
    async beginTransaction() { throw new Error("Must not hold a transaction during provider work."); },
    async commit() {}, async rollback() {},
    release() { returns++; }, destroy() { destroys++; }
  };
  const pool: MySqlPool = {
    async execute() { throw new Error("Lock must use a dedicated connection."); },
    async getConnection() { borrows++; return connection; }
  };
  return {
    leadership: createConsultationLeadership(pool), statements,
    counts: () => ({ borrows, returns, destroys }),
    setAcquired(value: unknown) { acquired = value; },
    setOwned(value: unknown) { owned = value; },
    setReleased(value: unknown) { released = value; },
    fail(operation: typeof fail) { fail = operation; }
  };
}

test("consultation executor holds one connection-owned lock and releases it exactly once", async () => {
  const f = fixture();
  assert.equal(await f.leadership.check(), false);
  assert.equal(await f.leadership.acquire(), true);
  assert.equal(await f.leadership.acquire(), true);
  assert.equal(await f.leadership.check(), true);
  assert.equal(f.counts().borrows, 1);
  await f.leadership.release();
  await f.leadership.release();
  assert.deepEqual(f.counts(), { borrows: 1, returns: 1, destroys: 0 });
  assert.equal(await f.leadership.check(), false);
});

test("busy consultation lock returns its unused connection without starting a second executor", async () => {
  const f = fixture(); f.setAcquired(0);
  assert.equal(await f.leadership.acquire(), false);
  await f.leadership.release();
  assert.deepEqual(f.counts(), { borrows: 1, returns: 1, destroys: 0 });
});

test("uncertain lock acquisition destroys the connection and exposes only a safe error", async () => {
  const f = fixture(); f.fail("acquire");
  await assert.rejects(f.leadership.acquire(), { message: "Consultation leadership is unavailable." });
  assert.deepEqual(f.counts(), { borrows: 1, returns: 0, destroys: 1 });
});

test("lost or unreadable ownership fails closed", async () => {
  const f = fixture(); await f.leadership.acquire();
  f.setOwned(null); assert.equal(await f.leadership.check(), false);
  f.setOwned(0); assert.equal(await f.leadership.check(), false);
  f.fail("check"); assert.equal(await f.leadership.check(), false);
  f.fail(undefined); await f.leadership.release();
});

test("uncertain lock release never returns a potentially locked connection to the pool", async () => {
  for (const mode of ["error", "not-owned", "null"] as const) {
    const f = fixture(); await f.leadership.acquire();
    if (mode === "error") f.fail("release");
    else f.setReleased(mode === "null" ? null : 0);
    await f.leadership.release();
    assert.deepEqual(f.counts(), { borrows: 1, returns: 0, destroys: 1 });
    assert.equal(await f.leadership.check(), false);
  }
});

test("native bot reply resolves only one accepted delivery through a parameterized bounded query", async () => {
  const seen: string[] = [];
  let result: unknown = [{ generation: 7 }];
  const pool: MySqlPool = {
    async getConnection() { throw new Error("Read-only lookup does not require a transaction."); },
    async execute(statement, values) {
      seen.push(statement);
      assert.deepEqual(values, ["$accepted-bot-event"]);
      assert.match(statement, /state IN \('accepted', 'device_delivered', 'read'\) LIMIT 2/);
      assert.match(statement, /WHERE matrix_event_id = \?/);
      return [result, []];
    }
  };
  const outbox = new MySqlMatrixOutbox(pool);
  assert.equal(await outbox.resolveAcceptedGeneration("$accepted-bot-event"), 7);
  for (const invalid of [[], [{ generation: 0 }], [{ generation: -1 }], [{ generation: 1.5 }],
    [{ generation: "7" }], [{ generation: "not-a-number" }], [{ generation: Number.MAX_SAFE_INTEGER + 1 }],
    [{ generation: 1 }, { generation: 2 }]]) {
    result = invalid;
    assert.equal(await outbox.resolveAcceptedGeneration("$accepted-bot-event"), undefined);
  }
  const queryCount = seen.length;
  for (const invalidId of ["", "$short", "not-an-event", "$event' OR 1=1", "$" + "a".repeat(256)]) {
    assert.equal(await outbox.resolveAcceptedGeneration(invalidId), undefined);
  }
  assert.equal(seen.length, queryCount);
});
