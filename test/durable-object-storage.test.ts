import assert from "node:assert/strict";
import test from "node:test";

import { DurableObjectKeyValueStorage } from "../src/cloudflare/durable-object-storage.ts";

type KeyValueStore = Readonly<{
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}>;

class FakeTransactionStore implements KeyValueStore {
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

class FakeDurableObjectStorage implements KeyValueStore {
  #values = new Map<string, unknown>();
  transactionCalls = 0;

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#values.set(key, structuredClone(value));
  }

  async transaction<T>(operation: (transaction: FakeTransactionStore) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const workingCopy = structuredClone(this.#values) as Map<string, unknown>;
    const result = await operation(new FakeTransactionStore(workingCopy));
    this.#values = workingCopy;
    return result;
  }
}

function asDurableStorage(storage: FakeDurableObjectStorage): DurableObjectStorage {
  return storage as unknown as DurableObjectStorage;
}

test("Durable Object adapter exposes one atomic transaction boundary to the domain", async () => {
  const rawStorage = new FakeDurableObjectStorage();
  const storage = new DurableObjectKeyValueStorage(asDurableStorage(rawStorage));

  await storage.transaction(async (transaction) => {
    await transaction.put("settings", { revision: 2 });
    await transaction.put("audit:2", { actor: "owner" });
  });

  assert.equal(rawStorage.transactionCalls, 1);
  assert.deepEqual(await storage.get("settings"), { revision: 2 });
  assert.deepEqual(await storage.get("audit:2"), { actor: "owner" });
});

test("Durable Object adapter reuses a nested transaction instead of committing an intermediate state", async () => {
  const rawStorage = new FakeDurableObjectStorage();
  const storage = new DurableObjectKeyValueStorage(asDurableStorage(rawStorage));

  await storage.transaction(async (transaction) => {
    await transaction.put("first", "saved only with outer transaction");
    await transaction.transaction(async (nested) => {
      await nested.put("second", "same transaction");
    });
  });

  assert.equal(rawStorage.transactionCalls, 1);
  assert.equal(await storage.get<string>("first"), "saved only with outer transaction");
  assert.equal(await storage.get<string>("second"), "same transaction");
});
