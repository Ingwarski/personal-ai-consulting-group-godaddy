import type { RegistrarStorage } from "../../src/session/storage.ts";

export class MemoryRegistrarStorage implements RegistrarStorage {
  #values = new Map<string, unknown>();
  #tail: Promise<unknown> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#values.set(key, structuredClone(value));
  }

  async transaction<T>(operation: (storage: RegistrarStorage) => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      const values = new Map(this.#values);
      const transaction: RegistrarStorage = {
        get: async <V>(key: string) => values.has(key) ? structuredClone(values.get(key)) as V : undefined,
        put: async <V>(key: string, value: V) => { values.set(key, structuredClone(value)); },
        transaction: async <V>(nested: (storage: RegistrarStorage) => Promise<V>) => nested(transaction)
      };
      const output = await operation(transaction);
      this.#values = values;
      return output;
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
