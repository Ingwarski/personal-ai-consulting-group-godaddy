import type { SettingsStorage } from "../../src/settings/storage.ts";

export class MemorySettingsStorage implements SettingsStorage {
  readonly #values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#values.set(key, structuredClone(value));
  }

  async transaction<T>(operation: (storage: SettingsStorage) => Promise<T>): Promise<T> {
    return operation(this);
  }
}
