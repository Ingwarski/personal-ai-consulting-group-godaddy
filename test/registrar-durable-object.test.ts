import assert from "node:assert/strict";
import test from "node:test";

import { RegistrarDurableObject } from "../src/cloudflare/registrar-durable-object.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

class FakeTransactionStorage {
  readonly #values: Map<string, unknown>;

  constructor(values: Map<string, unknown>) {
    this.#values = values;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#values.set(key, structuredClone(value));
  }
}

class FakeDurableObjectStorage {
  #values = new Map<string, unknown>();
  transactionCalls = 0;

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#values.set(key, structuredClone(value));
  }

  async transaction<T>(operation: (transaction: FakeTransactionStorage) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const workingCopy = structuredClone(this.#values) as Map<string, unknown>;
    const result = await operation(new FakeTransactionStorage(workingCopy));
    this.#values = workingCopy;
    return result;
  }
}

function asState(storage: FakeDurableObjectStorage): DurableObjectState {
  return { storage } as unknown as DurableObjectState;
}

function sessionSnapshot() {
  const receipt = createCapabilityReceipt();
  const result = resolveEffectiveSessionSnapshot({
    sessionId: "durable-registrar-settings",
    settingsRevision: 1,
    settings: receipt.defaults,
    capabilityReceipt: receipt
  }, activeNow);
  if (!result.ok) throw new Error("Test snapshot must resolve.");
  return result.value;
}

test("uses one durable per-owner ledger across Durable Object instance lifetimes", async () => {
  const storage = new FakeDurableObjectStorage();
  const firstInstance = new RegistrarDurableObject(asState(storage));
  const started = await firstInstance.startSession({
    sessionId: "task-from-matrix-1",
    settingsSnapshot: sessionSnapshot()
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const appended = await firstInstance.appendConfirmedMessage({
    generation: started.value.generation,
    eventId: "matrix-agent-event-0001",
    role: "Стратег",
    body: "Повний підтверджений текст."
  });
  assert.equal(appended.ok, true);
  if (!appended.ok) return;

  const restoredInstance = new RegistrarDurableObject(asState(storage));
  const active = await restoredInstance.getActiveSession();
  const messages = await restoredInstance.getConfirmedMessages(started.value.generation);
  const replay = await restoredInstance.appendConfirmedMessage({
    generation: started.value.generation,
    eventId: "matrix-agent-event-0001",
    role: "Стратег",
    body: "Повний підтверджений текст."
  });

  assert.equal(active?.generation, 1);
  assert.deepEqual(messages.map(({ sequence, role, body }) => ({ sequence, role, body })), [{
    sequence: 1,
    role: "Стратег",
    body: "Повний підтверджений текст."
  }]);
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.replayed, true);
  assert.equal(storage.transactionCalls, 3);
});
