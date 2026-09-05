import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createGodaddyMySqlPool } from "../src/godaddy/mysql-pool.ts";
import { GODADDY_REGISTRAR_NAMESPACE, createGoDaddyRegistrarRuntime } from "../src/godaddy/registrar-runtime.ts";
import type { MySqlConnection, MySqlPool } from "../src/godaddy/mysql-storage.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

class MemoryConnection implements MySqlConnection {
  readonly #pool: MemoryPool;
  #working: Map<string, string> | undefined;
  #workingOutbox: Map<string, readonly unknown[]> | undefined;

  constructor(pool: MemoryPool) {
    this.#pool = pool;
  }

  async beginTransaction() {
    this.#working = new Map(this.#pool.values);
    this.#workingOutbox = new Map(this.#pool.outboxRows);
  }

  async commit() {
    if (this.#working === undefined) throw new Error("transaction not started");
    this.#pool.values = this.#working;
    this.#pool.outboxRows = this.#workingOutbox ?? new Map();
  }

  async rollback() {}
  release() {}

  execute(statement: string, values: readonly unknown[]) {
    return this.#pool.executeAgainst(
      this.#working ?? this.#pool.values,
      this.#workingOutbox ?? this.#pool.outboxRows,
      statement,
      values
    );
  }
}

class MemoryPool implements MySqlPool {
  values = new Map<string, string>();
  outboxRows = new Map<string, readonly unknown[]>();
  failOutbox = false;
  deadlocksRemaining = 0;
  fenceCalls = 0;
  readonly statements: string[] = [];

  async getConnection() {
    return new MemoryConnection(this);
  }

  execute(statement: string, values: readonly unknown[]) {
    return this.executeAgainst(this.values, this.outboxRows, statement, values);
  }

  async executeAgainst(
    valuesByKey: Map<string, string>,
    outboxRows: Map<string, readonly unknown[]>,
    statement: string,
    values: readonly unknown[]
  ) {
    this.statements.push(statement);
    if (statement.includes("GET_LOCK")) return [[{ acquired: 1 }], []] as const;
    if (statement.includes("RELEASE_LOCK")) return [[{ released: 1 }], []] as const;
    if (statement.includes("COUNT(*)") && statement.includes("state = 'leased'")) {
      return [[{ leasedCount: 0 }], []] as const;
    }
    if (statement.includes("registrar:transaction-lock")) {
      const namespace = values[0];
      if (typeof namespace !== "string") throw new Error("invalid lock fixture call");
      if (statement.startsWith("SELECT") && this.deadlocksRemaining > 0) {
        this.deadlocksRemaining -= 1;
        throw Object.assign(new Error("deadlock victim"), { code: "ER_LOCK_DEADLOCK", errno: 1_213 });
      }
      valuesByKey.set(`${namespace}:registrar:transaction-lock`, JSON.stringify({ version: 1 }));
      return [statement.startsWith("SELECT") ? [{ stateKey: "registrar:transaction-lock" }] : { affectedRows: 1 }, []] as const;
    }
    if (statement.startsWith("INSERT INTO personal_consultant_matrix_outbox")) {
      if (this.failOutbox) throw new Error("outbox insert failed");
      const key = `${values[0]}:${values[1]}`;
      if (outboxRows.has(key)) throw new Error("duplicate outbox row");
      outboxRows.set(key, values);
      return [{ affectedRows: 1 }, []] as const;
    }
    if (statement.startsWith("UPDATE personal_consultant_matrix_outbox")) {
      this.fenceCalls += 1;
      return [{ affectedRows: 1 }, []] as const;
    }
    const namespace = values[0];
    const key = values[1];
    if (typeof namespace !== "string" || typeof key !== "string") throw new Error("invalid fixture call");
    const compositeKey = `${namespace}:${key}`;
    if (statement.startsWith("SELECT")) {
      const stateValue = valuesByKey.get(compositeKey);
      return [stateValue === undefined ? [] : [{ stateValue }], []] as const;
    }
    const payload = values[2];
    if (typeof payload !== "string") throw new Error("invalid fixture payload");
    valuesByKey.set(compositeKey, payload);
    return [{ affectedRows: 1 }, []] as const;
  }
}

test("long transcripts preserve order with the real finite pool queue and competing reads", async () => {
  // Exercise mysql2's actual four-connection/32-waiter scheduler without a
  // socket. Only the connections' query responses are in-memory fixtures.
  const pool = createGodaddyMySqlPool({
    host: "unused.invalid", port: 1, database: "fixture", user: "fixture", password: "fixture-only"
  });
  type FixtureConnection = {
    _pool: unknown;
    execute: (sql: string, values: readonly unknown[], callback: (error: Error | null, rows?: unknown, fields?: unknown) => void) => EventEmitter;
    release: () => void;
    _realEnd: (callback: () => void) => void;
  };
  const core = (pool as unknown as { pool: {
    _allConnections: { push: (connection: FixtureConnection) => void };
    _freeConnections: { push: (connection: FixtureConnection) => void };
    releaseConnection: (connection: FixtureConnection) => void;
  } }).pool;
  const memory = new MemoryPool();
  const count = 128;
  memory.values.set(`${GODADDY_REGISTRAR_NAMESPACE}:registrar:session:1`, JSON.stringify({ nextSequence: count + 1 }));
  for (let sequence = 1; sequence <= count; sequence += 1) {
    memory.values.set(`${GODADDY_REGISTRAR_NAMESPACE}:registrar:message:1:${sequence}`, JSON.stringify({ sequence, body: `Message ${sequence}` }));
  }
  for (let index = 0; index < 4; index += 1) {
    const connection: FixtureConnection = {
      _pool: core,
      execute(sql, values, callback) {
        const command = new EventEmitter();
        setImmediate(() => {
          void memory.execute(sql, values).then(
            ([rows, fields]) => { callback(null, rows, fields); },
            (error: unknown) => { callback(error instanceof Error ? error : new Error("Fixture query failed")); }
          ).finally(() => { command.emit("end"); });
        });
        return command;
      },
      release() { core.releaseConnection(connection); },
      _realEnd(callback) { callback(); }
    };
    core._allConnections.push(connection);
    core._freeConnections.push(connection);
  }
  try {
    const runtime = createGoDaddyRegistrarRuntime({ pool, now: () => activeNow });
    const transcript = runtime.registrar.getConfirmedMessages(1);
    const competitors = Array.from({ length: 32 }, () => pool.execute(
      "SELECT state_value AS stateValue FROM personal_consultant_state WHERE state_namespace = ? AND state_key = ?",
      [GODADDY_REGISTRAR_NAMESPACE, "registrar:session:1"]
    ));
    const [messages, otherReads] = await Promise.all([transcript, Promise.all(competitors)]);
    assert.deepEqual(messages.map((message) => message.sequence), Array.from({ length: count }, (_, index) => index + 1));
    assert.equal(otherReads.length, 32);
    assert.equal(Object.isFrozen(messages), true);
    assert.equal(Object.isFrozen(messages[127]), true);
  } finally {
    await pool.end();
  }
});

test("GoDaddy registrar stores the canonical active session in its own MySQL namespace", async () => {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "registrar-source",
    settingsRevision: 7,
    settings: receipt.defaults,
    capabilityReceipt: receipt
  }, activeNow);
  if (!snapshot.ok) throw new Error("Expected a valid test snapshot.");

  const pool = new MemoryPool();
  let wakeCount = 0;
  const runtime = createGoDaddyRegistrarRuntime({
    pool,
    now: () => activeNow,
    wakeMatrixOutbox: () => { wakeCount += 1; }
  });
  const started = await runtime.registrar.startSession({ sessionId: "registrar-task", settingsSnapshot: snapshot.value });
  assert.equal(started.ok, true);
  assert.equal(pool.values.has(`${GODADDY_REGISTRAR_NAMESPACE}:registrar:active-session`), true);

  assert.deepEqual(await runtime.getActiveSessionSummary(), {
    settingsRevision: 7,
    catalogVersion: receipt.catalogVersion,
    startedAt: activeNow.toISOString(),
    effectiveSettings: receipt.defaults
  });

  const appended = await runtime.registrar.appendConfirmedMessage({
    generation: 1,
    eventId: "runtime-message-event-0001",
    role: "Стратег",
    body: "Підтверджений текст."
  });
  assert.equal(appended.ok, true);
  assert.equal(pool.outboxRows.size, 1);
  const outbox = pool.outboxRows.get("1:1");
  assert.equal(typeof outbox?.[2], "string");
  assert.match(String(outbox?.[2]), /^pc-1-1-/);
  assert.match(String(outbox?.[6]), /^[a-f0-9]{64}$/u);
  assert.notEqual(outbox?.[6], outbox?.[5]);
  if (appended.ok) await runtime.afterConfirmed(appended.value);
  assert.equal(wakeCount, 1);
  const ensureLock = pool.statements.findIndex((statement) => statement.includes("INSERT IGNORE") && statement.includes("transaction-lock"));
  const activeRead = pool.statements.findIndex((statement) => statement.includes("state_value") && statement.includes("FOR UPDATE"));
  assert.equal(ensureLock >= 0 && activeRead > ensureLock, true);
});

test("GoDaddy registrar bounds deadlock retries while taking the stable transaction lock first", async () => {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "registrar-deadlock-source", settingsRevision: 7,
    settings: receipt.defaults, capabilityReceipt: receipt
  }, activeNow);
  if (!snapshot.ok) throw new Error("Expected a valid test snapshot.");
  const pool = new MemoryPool();
  pool.deadlocksRemaining = 2;
  const runtime = createGoDaddyRegistrarRuntime({ pool, now: () => activeNow });
  const started = await runtime.registrar.startSession({ sessionId: "registrar-deadlock", settingsSnapshot: snapshot.value });
  assert.equal(started.ok, true);
  assert.equal(pool.deadlocksRemaining, 0);
  assert.equal(pool.statements.filter((statement) => statement.includes("SELECT state_key")).length, 3);
});

test("Stop fences pending and blocked message rows before adding its explicit control row", async () => {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "registrar-stop-source", settingsRevision: 7,
    settings: receipt.defaults, capabilityReceipt: receipt
  }, activeNow);
  if (!snapshot.ok) throw new Error("Expected a valid test snapshot.");
  const pool = new MemoryPool();
  const runtime = createGoDaddyRegistrarRuntime({ pool, now: () => activeNow });
  await runtime.registrar.startSession({ sessionId: "registrar-stop", settingsSnapshot: snapshot.value });
  await runtime.registrar.appendConfirmedMessage({
    generation: 1, eventId: "runtime-stop-message-0001", role: "Стратег", body: "Неопублікована репліка."
  });
  await runtime.registrar.stopSession(1, { publishControl: true });
  assert.equal(pool.fenceCalls, 1);
  const fenceStatement = pool.statements.find((statement) =>
    statement.startsWith("UPDATE personal_consultant_matrix_outbox") && statement.includes("state = 'cancelled'"));
  assert.match(fenceStatement ?? "", /state IN \('pending', 'blocked'\)/u);
  assert.equal(pool.outboxRows.size, 2);
  assert.equal(pool.outboxRows.get("1:2")?.[3], "control");
});

test("GoDaddy registrar rolls back its MySQL confirmation when the outbox insert fails", async () => {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "registrar-rollback-source",
    settingsRevision: 7,
    settings: receipt.defaults,
    capabilityReceipt: receipt
  }, activeNow);
  if (!snapshot.ok) throw new Error("Expected a valid test snapshot.");
  const pool = new MemoryPool();
  const runtime = createGoDaddyRegistrarRuntime({ pool, now: () => activeNow });
  await runtime.registrar.startSession({ sessionId: "registrar-rollback", settingsSnapshot: snapshot.value });
  pool.failOutbox = true;
  await assert.rejects(runtime.registrar.appendConfirmedMessage({
    generation: 1,
    eventId: "runtime-message-event-rollback",
    role: "Стратег",
    body: "Цей текст не повинен commit-итися."
  }), /outbox insert failed/);
  assert.deepEqual(await runtime.registrar.getConfirmedMessages(1), []);
  assert.equal((await runtime.registrar.getActiveSession())?.nextSequence, 1);
  assert.equal(pool.outboxRows.size, 0);
});

test("GoDaddy registrar rolls back content that exceeds the actual Matrix plaintext or formatted envelope", async () => {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "registrar-envelope-source", settingsRevision: 7,
    settings: receipt.defaults, capabilityReceipt: receipt
  }, activeNow);
  if (!snapshot.ok) throw new Error("Expected a valid test snapshot.");
  const pool = new MemoryPool();
  const runtime = createGoDaddyRegistrarRuntime({ pool, now: () => activeNow });
  await runtime.registrar.startSession({ sessionId: "registrar-envelope", settingsSnapshot: snapshot.value });
  for (const [eventId, body] of [
    ["runtime-message-plaintext-envelope", "a".repeat(65_536)],
    ["runtime-message-formatted-envelope", "<".repeat(40_000)]
  ] as const) {
    await assert.rejects(runtime.registrar.appendConfirmedMessage({
      generation: 1, eventId, role: "Стратег", body
    }), /Matrix runtime delivery envelope limits/);
  }
  assert.deepEqual(await runtime.registrar.getConfirmedMessages(1), []);
  assert.equal((await runtime.registrar.getActiveSession())?.nextSequence, 1);
  assert.equal(pool.outboxRows.size, 0);
});
