import type { RegistrarStorage } from "../../src/session/storage.ts";

export class MemoryRegistrarStorage implements RegistrarStorage {
  #values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#values.set(key, structuredClone(value));
  }

  async transaction<T>(operation: (storage: RegistrarStorage) => Promise<T>): Promise<T> {
    const prior = this.#values;
    this.#values = new Map(prior);
    try {
      return await operation(this);
    } catch (error) {
      this.#values = prior;
      throw error;
    }
  }
}
