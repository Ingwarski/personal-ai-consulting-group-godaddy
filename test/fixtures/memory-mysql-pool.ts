import type { MySqlConnection, MySqlPool } from "../../src/godaddy/mysql-storage.ts";

const composite = (values: readonly unknown[]): string => {
  if (typeof values[0] !== "string" || typeof values[1] !== "string") throw new Error("Invalid fixture query.");
  return `${values[0]}:${values[1]}`;
};

class MemoryConnection implements MySqlConnection {
  #working: Map<string, string> | undefined;
  readonly #pool: MemoryMySqlPool;

  constructor(pool: MemoryMySqlPool) { this.#pool = pool; }

  async beginTransaction(): Promise<void> { this.#working = new Map(this.#pool.values); }
  async commit(): Promise<void> {
    if (this.#working === undefined) throw new Error("Transaction not started.");
    this.#pool.values = this.#working;
  }
  async rollback(): Promise<void> { this.#working = undefined; }
  release(): void {}
  async execute(statement: string, values: readonly unknown[]) {
    return this.#pool.executeAgainst(this.#working ?? this.#pool.values, statement, values);
  }
}

export class MemoryMySqlPool implements MySqlPool {
  values = new Map<string, string>();

  async getConnection(): Promise<MySqlConnection> { return new MemoryConnection(this); }
  async execute(statement: string, values: readonly unknown[]) { return this.executeAgainst(this.values, statement, values); }

  async executeAgainst(records: Map<string, string>, statement: string, values: readonly unknown[]) {
    const key = composite(values);
    if (statement.startsWith("SELECT")) {
      const stateValue = records.get(key);
      return [stateValue === undefined ? [] : [{ stateValue }], []] as const;
    }
    if (statement.startsWith("DELETE")) {
      records.delete(key);
      return [{ affectedRows: 1 }, []] as const;
    }
    if (statement.startsWith("INSERT")) {
      if (typeof values[2] !== "string") throw new Error("Invalid fixture value.");
      records.set(key, values[2]);
      return [{ affectedRows: 1 }, []] as const;
    }
    throw new Error(`Unhandled fixture query: ${statement}`);
  }
}
