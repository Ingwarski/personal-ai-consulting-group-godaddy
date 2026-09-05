import type { MySqlConnection, MySqlPool } from "../../src/godaddy/mysql-storage.ts";

/** Credential-free transactional auth namespace; any application-data access fails. */
export class OwnerAuthPool implements MySqlPool {
  values = new Map<string, string>();
  #tail: Promise<void> = Promise.resolve();

  async execute(statement: string, parameters: readonly unknown[]): Promise<readonly [unknown, unknown]> {
    return this.#execute(this.values, statement, parameters);
  }

  async getConnection(): Promise<MySqlConnection> {
    const prior = this.#tail;
    let unlock!: () => void;
    this.#tail = new Promise<void>((resolve) => { unlock = resolve; });
    await prior;
    let working = new Map(this.values);
    return {
      beginTransaction: async () => { working = new Map(this.values); },
      execute: async (statement, parameters) => this.#execute(working, statement, parameters),
      commit: async () => { this.values = working; },
      rollback: async () => {},
      release: unlock
    };
  }

  #execute(values: Map<string, string>, statement: string, parameters: readonly unknown[]): readonly [unknown, unknown] {
    if (parameters[0] !== "owner-access-v2" || typeof parameters[1] !== "string") {
      throw new Error("Unauthenticated fixture must not touch application state.");
    }
    const key = parameters[1];
    if (statement.startsWith("SELECT")) {
      const stateValue = values.get(key);
      return [stateValue === undefined ? [] : [{ stateValue }], []];
    }
    if (statement.startsWith("INSERT") && typeof parameters[2] === "string") {
      values.set(key, parameters[2]);
      return [{ affectedRows: 1 }, []];
    }
    throw new Error("Unexpected auth SQL statement.");
  }
}
