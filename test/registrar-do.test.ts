import assert from "node:assert/strict";
import test from "node:test";

import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";

const firstEvent = "agent-message-event-0001";
const secondEvent = "agent-message-event-0002";

function createRegistrar() {
  let now = new Date(activeNow);
  const snapshot = resolveEffectiveSessionSnapshot(
    {
      sessionId: "settings-snapshot-source",
      settingsRevision: 7,
      settings: createCapabilityReceipt().defaults,
      capabilityReceipt: createCapabilityReceipt()
    },
    now
  );
  if (!snapshot.ok) throw new Error("Test snapshot must resolve.");

  const registrar = new RegistrarDO({
    storage: new MemoryRegistrarStorage(),
    now: () => now
  });

  return {
    registrar,
    snapshot: snapshot.value,
    advanceClock(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    }
  };
}

test("starts exactly one generation with an immutable settings snapshot", async () => {
  const { registrar, snapshot } = createRegistrar();
  const started = await registrar.startSession({ sessionId: "task-1", settingsSnapshot: snapshot });
  const retry = await registrar.startSession({ sessionId: "task-1", settingsSnapshot: snapshot });

  assert.equal(started.ok, true);
  assert.equal(retry.ok, true);
  if (!started.ok || !retry.ok) return;
  assert.equal(started.value.generation, 1);
  assert.equal(retry.replayed, true);
  assert.equal(Object.isFrozen(started.value.settingsSnapshot), true);
  assert.throws(() => {
    (started.value.settingsSnapshot.settings as { speedPreset: string }).speedPreset = "швидко";
  }, TypeError);
});

test("appends only one verbatim confirmed message for an idempotent event", async () => {
  const { registrar, snapshot } = createRegistrar();
  await registrar.startSession({ sessionId: "task-1", settingsSnapshot: snapshot });
  const message = await registrar.appendConfirmedMessage({
    generation: 1,
    eventId: firstEvent,
    role: "Фінансовий консультант",
    body: "Повний текст **без скорочення**.",
    addressedTo: "Головний консультант"
  });
  const retry = await registrar.appendConfirmedMessage({
    generation: 1,
    eventId: firstEvent,
    role: "Фінансовий консультант",
    body: "Повний текст **без скорочення**.",
    addressedTo: "Головний консультант"
  });

  assert.equal(message.ok, true);
  assert.equal(retry.ok, true);
  if (!message.ok || !retry.ok) return;
  assert.equal(message.value.sequence, 1);
  assert.match(message.value.visibleTime, /^\d{2}:\d{2}$/);
  assert.equal(message.value.body, "Повний текст **без скорочення**.");
  assert.equal(retry.replayed, true);
  assert.deepEqual(await registrar.getConfirmedMessages(1), [message.value]);
  assert.deepEqual(await registrar.getLocalDeliveryRecordForTest(1, 1), {
    generation: 1,
    sequence: 1,
    deliveryId: `pc-1-1-${message.value.bodyHash.slice(0, 24)}`,
    kind: "message",
    message: message.value,
    createdAt: message.value.confirmedAt
  });
});

test("rolls back confirmation and sequence when the transaction-local delivery projection fails", async () => {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "rollback-source",
    settingsRevision: 7,
    settings: receipt.defaults,
    capabilityReceipt: receipt
  }, activeNow);
  if (!snapshot.ok) throw new Error("Test snapshot must resolve.");
  const registrar = new RegistrarDO({
    storage: new MemoryRegistrarStorage(),
    now: () => activeNow,
    projectConfirmedMessage: async () => { throw new Error("delivery unavailable"); }
  });
  await registrar.startSession({ sessionId: "task-rollback", settingsSnapshot: snapshot.value });
  await assert.rejects(registrar.appendConfirmedMessage({
    generation: 1,
    eventId: firstEvent,
    role: "Критик",
    body: "Не може бути підтверджено частково."
  }), /delivery unavailable/);
  assert.deepEqual(await registrar.getConfirmedMessages(1), []);
  assert.equal((await registrar.getActiveSession())?.nextSequence, 1);
});

test("rejects a duplicate event with a changed body", async () => {
  const { registrar, snapshot } = createRegistrar();
  await registrar.startSession({ sessionId: "task-1", settingsSnapshot: snapshot });
  await registrar.appendConfirmedMessage({ generation: 1, eventId: firstEvent, role: "Стратег", body: "Перша репліка." });
  const changed = await registrar.appendConfirmedMessage({ generation: 1, eventId: firstEvent, role: "Стратег", body: "Змінена репліка." });

  assert.deepEqual(changed, { ok: false, code: "idempotency_conflict" });
});

test("includes the native reply relation in the idempotency fingerprint", async () => {
  const { registrar, snapshot } = createRegistrar();
  await registrar.startSession({ sessionId: "task-1", settingsSnapshot: snapshot });
  const first = await registrar.appendConfirmedMessage({
    generation: 1, eventId: firstEvent, role: "Стратег", body: "Відповідь.", replyToEventId: "$owner-event-A"
  });
  const changedRelation = await registrar.appendConfirmedMessage({
    generation: 1, eventId: firstEvent, role: "Стратег", body: "Відповідь.", replyToEventId: "$owner-event-B"
  });
  assert.equal(first.ok, true);
  assert.deepEqual(changedRelation, { ok: false, code: "idempotency_conflict" });
});

test("enforces the 64 KiB UTF-8 confirmed-body boundary before storage", async () => {
  const { registrar, snapshot } = createRegistrar();
  await registrar.startSession({ sessionId: "task-1", settingsSnapshot: snapshot });
  const exact = await registrar.appendConfirmedMessage({
    generation: 1, eventId: "agent-message-event-exact-limit", role: "Стратег", body: "ї".repeat(32_768)
  });
  const oversized = await registrar.appendConfirmedMessage({
    generation: 1, eventId: "agent-message-event-over-limit", role: "Стратег", body: "ї".repeat(32_769)
  });
  assert.equal(exact.ok, true);
  assert.deepEqual(oversized, { ok: false, code: "invalid_event" });
});

test("stop and new task fence late output from the obsolete generation", async () => {
  const { registrar, snapshot, advanceClock } = createRegistrar();
  await registrar.startSession({ sessionId: "task-1", settingsSnapshot: snapshot });
  await registrar.appendConfirmedMessage({ generation: 1, eventId: firstEvent, role: "Маркетолог", body: "Початкова репліка." });
  const stopped = await registrar.stopSession(1, { publishControl: true });
  advanceClock(60_000);
  const lateAfterStop = await registrar.appendConfirmedMessage({ generation: 1, eventId: secondEvent, role: "Маркетолог", body: "Запізніла репліка." });
  const secondTask = await registrar.startNewTask({ sessionId: "task-2", settingsSnapshot: snapshot });
  const lateAfterNewTask = await registrar.appendConfirmedMessage({ generation: 1, eventId: "agent-message-event-0003", role: "Маркетолог", body: "Ще пізніше." });

  assert.equal(stopped.ok, true);
  const stoppedMessages = await registrar.getConfirmedMessages(1);
  assert.equal(stoppedMessages.at(-1)?.internalEventId, "control-stop-event-1");
  assert.equal((await registrar.getLocalDeliveryRecordForTest(1, 2))?.kind, "control");
  assert.deepEqual(lateAfterStop, { ok: false, code: "session_not_active" });
  assert.equal(secondTask.ok, true);
  if (secondTask.ok) assert.equal(secondTask.value.generation, 2);
  assert.deepEqual(lateAfterNewTask, { ok: false, code: "obsolete_generation" });
});

test("canonical order is monotonic and returned messages cannot be edited", async () => {
  const { registrar, snapshot, advanceClock } = createRegistrar();
  await registrar.startSession({ sessionId: "task-1", settingsSnapshot: snapshot });
  const first = await registrar.appendConfirmedMessage({ generation: 1, eventId: firstEvent, role: "Головний консультант", body: "Старт." });
  advanceClock(60_000);
  const second = await registrar.appendConfirmedMessage({ generation: 1, eventId: secondEvent, role: "Критик", body: "Критика." });
  const messages = await registrar.getConfirmedMessages(1);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(messages.map((message) => message.sequence), [1, 2]);
  assert.equal(Object.isFrozen(messages), true);
  assert.throws(() => {
    (messages[0] as { body: string }).body = "Виправлено заднім числом.";
  }, TypeError);
});
