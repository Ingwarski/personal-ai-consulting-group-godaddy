import assert from "node:assert/strict";
import test from "node:test";

import { createGoDaddyRegistrarRuntime, GODADDY_REGISTRAR_NAMESPACE } from "../src/godaddy/registrar-runtime.ts";
import type { MySqlConnection, MySqlPool } from "../src/godaddy/mysql-storage.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

/** In-memory SQL responses; real registrar/MySQL transaction and projection code. */
class TransactionalPool implements MySqlPool {
  values = new Map<string, string>();
  outbox = new Map<string, readonly unknown[]>();
  failOutbox = false;
  failFence = false;
  fences = 0;
  rollbacks = 0;

  async executeAgainst(state: Map<string, string>, outbox: Map<string, readonly unknown[]>, sql: string, args: readonly unknown[]) {
    if (sql.includes("registrar:transaction-lock")) return [[], []] as const;
    if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }], []] as const;
    if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }], []] as const;
    if (sql.includes("COUNT(*)")) return [[{ leasedCount: 0 }], []] as const;
    if (sql.startsWith("INSERT INTO personal_consultant_matrix_outbox")) {
      if (this.failOutbox) throw new Error("outbox unavailable");
      const key = `${args[0]}:${args[1]}`;
      assert.equal(outbox.has(key), false, "canonical outbox sequence must be unique");
      outbox.set(key, structuredClone(args));
      return [{ affectedRows: 1 }, []] as const;
    }
    if (sql.startsWith("UPDATE personal_consultant_matrix_outbox")) {
      if (this.failFence) throw new Error("fence unavailable");
      this.fences += 1;
      return [{ affectedRows: 1 }, []] as const;
    }
    const key = `${args[0]}:${args[1]}`;
    if (sql.startsWith("SELECT")) {
      const value = state.get(key);
      return [value === undefined ? [] : [{ stateValue: value }], []] as const;
    }
    assert.equal(typeof args[2], "string");
    state.set(key, args[2] as string);
    return [{ affectedRows: 1 }, []] as const;
  }

  execute(sql: string, args: readonly unknown[]) { return this.executeAgainst(this.values, this.outbox, sql, args); }

  async getConnection(): Promise<MySqlConnection> {
    let state: Map<string, string>;
    let outbox: Map<string, readonly unknown[]>;
    return {
      beginTransaction: async () => { state = new Map(this.values); outbox = new Map(this.outbox); },
      execute: (sql, args) => this.executeAgainst(state, outbox, sql, args),
      commit: async () => { this.values = state; this.outbox = outbox; },
      rollback: async () => { this.rollbacks += 1; },
      release: () => undefined
    };
  }
}

function createFixture(pool = new TransactionalPool()) {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "control-test-source", settingsRevision: 7,
    settings: receipt.defaults, capabilityReceipt: receipt
  }, activeNow);
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) throw new Error("Test snapshot must resolve.");
  const runtime = createGoDaddyRegistrarRuntime({ pool, now: () => activeNow });
  return { pool, registrar: runtime.registrar, snapshot: snapshot.value };
}

test("pre-session controls use a private durable sequence without creating a consultation", async () => {
  const { registrar, snapshot, pool } = createFixture();
  const first = await registrar.appendControlNotice({
    eventId: "control-consent-first", body: "Підтвердьте згоду.", replyToEventId: "$owner-event-first"
  });
  const second = await registrar.appendControlNotice({ eventId: "control-consent-next", body: "Очікую на згоду." });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual([first.value.generation, first.value.sequence, second.value.sequence], [1, 1, 2]);
  assert.equal(first.value.role, "Service");
  assert.equal(first.value.authority, undefined);
  assert.equal(Object.isFrozen(first.value), true);
  assert.equal(await registrar.getActiveSession(), undefined);
  assert.equal(await registrar.getSession(1), undefined);
  assert.deepEqual(await registrar.getConfirmedMessages(1), [first.value, second.value]);
  assert.equal(pool.outbox.get("1:1")?.[3], "control");
  assert.equal(pool.outbox.get("1:1")?.[7], "$owner-event-first");
  assert.deepEqual(await registrar.appendConfirmedMessage({ generation: 1, eventId: "agent-before-session", role: "Головний консультант", body: "Не дозволено." }), { ok: false, code: "no_active_session" });
  const started = await registrar.startSession({ sessionId: "task-after-consent", settingsSnapshot: snapshot });
  assert.equal(started.ok, true);
  if (started.ok) assert.equal(started.value.generation, 2);
});

test("control deduplication survives a new registrar and binds both body and native reply", async () => {
  const { registrar, pool, snapshot } = createFixture();
  const input = { eventId: "control-stable-event", body: "Запит отримано.", replyToEventId: "$owner-event-first" };
  const original = await registrar.appendControlNotice(input);
  await registrar.startSession({ sessionId: "task-retry", settingsSnapshot: snapshot });
  const restarted = createFixture(pool).registrar;
  const retry = await restarted.appendControlNotice(input);
  assert.equal(original.ok, true);
  assert.equal(retry.ok, true);
  if (original.ok && retry.ok) { assert.equal(retry.replayed, true); assert.deepEqual(retry.value, original.value); }
  assert.equal(pool.outbox.size, 1);
  for (const changed of [{ ...input, body: "Інший текст." }, { ...input, replyToEventId: "$owner-event-second" }]) {
    assert.deepEqual(await restarted.appendControlNotice(changed), { ok: false, code: "idempotency_conflict" });
  }
});

test("controls preserve active, stopped and closed phases while ordinary messages stay fenced", async () => {
  for (const phase of ["active", "stopped", "closed"] as const) {
    const { registrar, snapshot } = createFixture();
    await registrar.startSession({ sessionId: `task-${phase}`, settingsSnapshot: snapshot });
    if (phase === "stopped") await registrar.stopSession(1);
    if (phase === "closed") await registrar.closeSession(1);
    const control = await registrar.appendControlNotice({ eventId: `control-${phase}`, body: "Службове повідомлення." });
    assert.equal(control.ok, true);
    if (!control.ok) continue;
    assert.equal(control.value.generation, 1);
    assert.equal(control.value.sequence, 1);
    assert.equal((await registrar.getActiveSession())?.phase, phase);
    assert.equal((await registrar.getSession(1))?.nextSequence, 2);
    const normal = await registrar.appendConfirmedMessage({ generation: 1, eventId: `agent-${phase}`, role: "Консультант", body: "Репліка." });
    if (phase === "active") assert.equal(normal.ok, true);
    else assert.deepEqual(normal, { ok: false, code: "session_not_active" });
  }
});

test("a control cannot carry model authority or borrow an ordinary message event", async () => {
  const { registrar, snapshot } = createFixture();
  await registrar.startSession({ sessionId: "task-controls", settingsSnapshot: snapshot });
  await registrar.appendConfirmedMessage({ generation: 1, eventId: "ordinary-system-event", role: "Система", body: "Текст." });
  assert.deepEqual(await registrar.appendControlNotice({ eventId: "ordinary-system-event", body: "Текст." }), { ok: false, code: "idempotency_conflict" });
  await registrar.appendControlNotice({ eventId: "control-only-event", body: "Текст." });
  assert.deepEqual(await registrar.appendConfirmedMessage({ generation: 1, eventId: "control-only-event", role: "Система", body: "Текст." }), { ok: false, code: "idempotency_conflict" });
  for (const invalid of [
    { eventId: "invalid-authority", body: "Текст.", authority: { agentId: "agent-critic", provider: "codex", runtimeSessionRef: "critic-session", kind: "critique" } },
    { eventId: "invalid-role", body: "Текст.", role: "Критик" },
    { eventId: "invalid-empty", body: "" },
    { eventId: "invalid-long", body: "ї".repeat(32_769) },
    { eventId: "invalid-reply", body: "Текст.", replyToEventId: "https://example.invalid" }
  ]) assert.deepEqual(await registrar.appendControlNotice(invalid), { ok: false, code: "invalid_event" });
  assert.equal(await registrar.getDesignatedCritic(1), undefined);
  assert.equal(await registrar.getCriticReview(1), undefined);
});

test("concurrent controls, duplicate delivery and consultation allocation share the MySQL registrar gate", async () => {
  const { registrar, snapshot, pool } = createFixture();
  const other = createFixture(pool).registrar;
  const first = await registrar.appendControlNotice({ eventId: "control-initial", body: "Початок." });
  assert.equal(first.ok, true);
  const notices = Array.from({ length: 24 }, (_, index) => ({ eventId: `control-concurrent-${index}`, body: `Повідомлення ${index}.` }));
  const results = await Promise.all([
    ...notices.flatMap((notice) => [registrar.appendControlNotice(notice), other.appendControlNotice(notice)]),
    registrar.startSession({ sessionId: "task-concurrent", settingsSnapshot: snapshot })
  ]);
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(results.filter((result) => result.ok && result.replayed).length, 24);
  assert.equal(pool.outbox.size, 25);
  const keys = [...pool.outbox.keys()].map((key) => key.split(":").map(Number));
  for (const generation of new Set(keys.map(([generation]) => generation))) {
    const sequences = keys.filter(([value]) => value === generation).map(([, sequence]) => sequence).sort((a, b) => a! - b!);
    assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, index) => index + 1));
  }
  assert.equal((await registrar.getActiveSession())?.generation, 2);
});

test("failed control projection rolls back generation, ledger, transcript and sequence together", async () => {
  for (const withSession of [false, true]) {
    const { registrar, pool, snapshot } = createFixture();
    if (withSession) await registrar.startSession({ sessionId: "task-rollback", settingsSnapshot: snapshot });
    const before = new Map(pool.values);
    pool.failOutbox = true;
    const input = { eventId: "control-rollback-event", body: "Атомарна репліка." };
    await assert.rejects(registrar.appendControlNotice(input), /outbox unavailable/);
    assert.deepEqual(pool.values, before);
    assert.equal(pool.outbox.size, 0);
    assert.equal(pool.rollbacks, 1);
    pool.failOutbox = false;
    const retry = await registrar.appendControlNotice(input);
    assert.equal(retry.ok, true);
    if (retry.ok) { assert.equal(retry.replayed, false); assert.deepEqual([retry.value.generation, retry.value.sequence], [1, 1]); }
    assert.equal(pool.values.has(`${GODADDY_REGISTRAR_NAMESPACE}:registrar:event:${input.eventId}`), true);
  }
});

test("normal close preserves pending output and is distinct from Stop or Critic approval", async () => {
  const { registrar, snapshot, pool } = createFixture();
  assert.deepEqual(await registrar.closeSession(1), { ok: false, code: "no_active_session" });
  await registrar.startSession({ sessionId: "task-direct", settingsSnapshot: snapshot });
  await registrar.appendConfirmedMessage({ generation: 1, eventId: "direct-final-event", role: "Головний консультант", body: "Пряма відповідь." });
  const before = new Map(pool.outbox);
  const closed = await registrar.closeSession(1);
  assert.equal(closed.ok, true);
  if (closed.ok) { assert.equal(closed.value.phase, "closed"); assert.equal(closed.value.closedAt, activeNow.toISOString()); }
  const retried = await registrar.closeSession(1);
  assert.equal(retried.ok, true);
  if (retried.ok) assert.equal(retried.replayed, true);
  assert.deepEqual(pool.outbox, before);
  assert.equal(pool.fences, 0);
  assert.equal((await registrar.getConfirmedMessages(1)).length, 1);
  assert.equal(await registrar.getCriticReview(1), undefined);
  assert.deepEqual(await registrar.appendConfirmedMessage({ generation: 1, eventId: "direct-late-event", role: "Головний консультант", body: "Пізня репліка." }), { ok: false, code: "session_not_active" });
  await registrar.startSession({ sessionId: "task-next", settingsSnapshot: snapshot });
  assert.deepEqual(await registrar.closeSession(1), { ok: false, code: "obsolete_generation" });
  assert.equal((await registrar.getSession(1))?.phase, "closed");
  await registrar.stopSession(2);
  assert.deepEqual(await registrar.closeSession(2), { ok: false, code: "session_not_active" });
});

test("owner revision advances only the technical generation and preserves immutable session context", async () => {
  const { registrar, snapshot, pool } = createFixture();
  const original = await registrar.startSession({ sessionId: "task-revised", settingsSnapshot: snapshot });
  assert.equal(original.ok, true);
  if (!original.ok) return;
  const message = await registrar.appendConfirmedMessage({ generation: 1, eventId: "revision-prior-message", role: "Головний консультант", body: "Попередня репліка." });
  const changedClock = createGoDaddyRegistrarRuntime({ pool, now: () => new Date(activeNow.getTime() + 60_000) }).registrar;
  const revised = await changedClock.reviseSession({ generation: 1, revisionId: "owner-clarification-1" });
  assert.equal(revised.ok, true);
  if (!revised.ok) return;
  assert.equal(revised.value.generation, 2);
  assert.equal(revised.value.previousGeneration, 1);
  assert.equal(revised.value.sessionId, original.value.sessionId);
  assert.equal(revised.value.startedAt, original.value.startedAt);
  assert.deepEqual(revised.value.settingsSnapshot, original.value.settingsSnapshot);
  assert.equal(Object.isFrozen(revised.value.settingsSnapshot), true);
  assert.equal(revised.value.nextSequence, 1);
  assert.equal(revised.value.closedAt, undefined);
  assert.equal(pool.fences, 1);
  assert.equal((await registrar.getSession(1))?.phase, "closed");
  assert.equal((await registrar.getActiveSession())?.generation, 2);
  assert.equal(await registrar.getDesignatedCritic(2), undefined);
  assert.equal(await registrar.getCriticReview(2), undefined);
  if (message.ok) assert.deepEqual(await registrar.getConfirmedMessages(1), [message.value]);
  assert.deepEqual(await registrar.appendConfirmedMessage({ generation: 1, eventId: "revision-late-message", role: "Головний консультант", body: "Запізніла репліка." }), { ok: false, code: "obsolete_generation" });
});

test("revision idempotency survives concurrency and later session closure without reopening it", async () => {
  const { registrar, snapshot, pool } = createFixture();
  await registrar.startSession({ sessionId: "task-revision-dedup", settingsSnapshot: snapshot });
  await registrar.closeSession(1);
  const other = createFixture(pool).registrar;
  const input = { generation: 1, revisionId: "owner-revision-stable" };
  const [first, second] = await Promise.all([registrar.reviseSession(input), other.reviseSession(input)]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(first.value.generation, 2);
    assert.equal(second.value.generation, 2);
  }
  assert.equal(pool.fences, 1);
  assert.deepEqual(await registrar.reviseSession({ generation: 2, revisionId: input.revisionId }), { ok: false, code: "idempotency_conflict" });
  await registrar.stopSession(2);
  const retryAfterStop = await other.reviseSession(input);
  assert.equal(retryAfterStop.ok, true);
  if (retryAfterStop.ok) assert.equal(retryAfterStop.value.phase, "stopped");
  assert.equal((await registrar.getActiveSession())?.phase, "stopped");
  assert.deepEqual(await registrar.reviseSession({ generation: 2, revisionId: "owner-revision-after-stop" }), { ok: false, code: "session_not_active" });
});

test("revision rejects missing, stale and invalid requests and rolls back a failed generation fence", async () => {
  const { registrar, snapshot, pool } = createFixture();
  assert.deepEqual(await registrar.reviseSession({ generation: 1, revisionId: "revision-no-session" }), { ok: false, code: "no_active_session" });
  assert.deepEqual(await registrar.reviseSession({ generation: 0, revisionId: "revision-invalid-generation" }), { ok: false, code: "invalid_event" });
  assert.deepEqual(await registrar.reviseSession({ generation: 1, revisionId: "$native-event-not-internal" }), { ok: false, code: "invalid_event" });
  await registrar.startSession({ sessionId: "task-revision-rollback", settingsSnapshot: snapshot });
  const before = new Map(pool.values);
  pool.failFence = true;
  const input = { generation: 1, revisionId: "revision-rollback" };
  await assert.rejects(registrar.reviseSession(input), /fence unavailable/);
  assert.deepEqual(pool.values, before);
  assert.equal(pool.rollbacks, 1);
  pool.failFence = false;
  const retry = await registrar.reviseSession(input);
  assert.equal(retry.ok, true);
  if (retry.ok) { assert.equal(retry.value.generation, 2); assert.equal(retry.replayed, false); }
  assert.deepEqual(await registrar.reviseSession({ generation: 1, revisionId: "revision-other-stale" }), { ok: false, code: "obsolete_generation" });
});
