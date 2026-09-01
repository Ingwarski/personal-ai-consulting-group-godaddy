import type { RegistrarStorage } from "../session/storage.ts";
import type { SettingsStorage } from "../settings/storage.ts";

/**
 * Thin adapter over a Durable Object's transactional KV API.
 *
 * The domain layer deliberately knows nothing about Cloudflare.  Both settings
 * and the session registrar use the same two-operation storage contract, and
 * this adapter makes each domain transaction one Durable Object transaction.
 * Nested domain transactions reuse the existing transaction rather than
 * opening an independent write boundary.
 */
export class DurableObjectKeyValueStorage implements SettingsStorage, RegistrarStorage {
  readonly #root: DurableObjectStorage;
  readonly #transaction: DurableObjectTransaction | undefined;

  constructor(root: DurableObjectStorage, transaction?: DurableObjectTransaction) {
    this.#root = root;
    this.#transaction = transaction;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.#activeStore().get<T>(key);
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.#activeStore().put(key, value);
  }

  async transaction<T>(
    operation: (storage: SettingsStorage & RegistrarStorage) => Promise<T>
  ): Promise<T> {
    if (this.#transaction !== undefined) {
      return operation(this);
    }

    return this.#root.transaction(async (transaction) =>
      operation(new DurableObjectKeyValueStorage(this.#root, transaction))
    );
  }

  #activeStore(): DurableObjectStorage | DurableObjectTransaction {
    return this.#transaction ?? this.#root;
  }
}
