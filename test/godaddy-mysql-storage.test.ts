import assert from "node:assert/strict";
import test from "node:test";

import {
  GODADDY_STATE_DATABASE_ROLE,
  MySqlKeyValueStorage,
  parseGodaddyDatabaseConfiguration,
  type MySqlConnection,
  type MySqlPool
} from "../src/godaddy/mysql-storage.ts";

class MemoryConnection implements MySqlConnection {
  readonly #pool: MemoryPool;
  #working: Map<string, string> | undefined;
  committed = 0;
  rolledBack = 0;
  released = 0;

  constructor(pool: MemoryPool) {
    this.#pool = pool;
  }

  async beginTransaction() {
    this.#working = new Map(this.#pool.values);
  }

  async commit() {
    if (this.#working === undefined) throw new Error("transaction not started");
    this.#pool.values = this.#working;
    this.committed += 1;
  }

  async rollback() {
    this.rolledBack += 1;
  }

  release() {
    this.released += 1;
  }

  async execute(statement: string, values: readonly unknown[]) {
    return this.#pool.executeAgainst(this.#working ?? this.#pool.values, statement, values);
  }
}

class MemoryPool implements MySqlPool {
  values = new Map<string, string>();
  connections: MemoryConnection[] = [];

  async getConnection() {
    const connection = new MemoryConnection(this);
    this.connections.push(connection);
    return connection;
  }

  async execute(statement: string, values: readonly unknown[]) {
    return this.executeAgainst(this.values, statement, values);
  }

  async executeAgainst(valuesByKey: Map<string, string>, statement: string, values: readonly unknown[]) {
    const namespace = values[0];
    const key = values[1];
    if (typeof namespace !== "string" || typeof key !== "string") throw new Error("invalid fixture call");
    const compositeKey = `${namespace}:${key}`;
    if (statement.startsWith("SELECT")) {
      const stateValue = valuesByKey.get(compositeKey);
      return [stateValue === undefined ? [] : [{ stateValue }], []] as const;
    }
    if (statement.startsWith("DELETE")) {
      valuesByKey.delete(compositeKey);
      return [{ affectedRows: 1 }, []] as const;
    }
    const payload = values[2];
    if (typeof payload !== "string") throw new Error("invalid fixture payload");
    valuesByKey.set(compositeKey, payload);
    return [{ affectedRows: 1 }, []] as const;
  }
}

test("GoDaddy state storage is unavailable without an explicit published role", () => {
  assert.deepEqual(parseGodaddyDatabaseConfiguration({}), {
    ok: false,
    code: "state_database_not_enabled"
  });
  assert.deepEqual(parseGodaddyDatabaseConfiguration({
    RUNTIME_MODE: "production",
    GODADDY_STATE_DATABASE_ROLE: GODADDY_STATE_DATABASE_ROLE,
    DB_HOST: "db.internal",
    DB_PORT: "not-a-port",
    DB_NAME: "personal_consultant",
    DB_USER: "application",
    DB_PASSWORD: "private"
  }), {
    ok: false,
    code: "invalid_state_database_configuration"
  });
  assert.deepEqual(parseGodaddyDatabaseConfiguration({
    RUNTIME_MODE: "production",
    GODADDY_STATE_DATABASE_ROLE: GODADDY_STATE_DATABASE_ROLE,
    DB_HOST: "db.internal",
    DB_PORT: "3306",
    DB_NAME: "personal_consultant",
    DB_USER: "application",
    DB_PASSWORD: "private"
  }), {
    ok: true,
    value: {
      host: "db.internal",
      port: 3306,
      database: "personal_consultant",
      user: "application",
      password: "private",
        connectionLimit: 8
    }
  });
  assert.deepEqual(parseGodaddyDatabaseConfiguration({
    RUNTIME_MODE: "development",
    GODADDY_STATE_DATABASE_ROLE: GODADDY_STATE_DATABASE_ROLE,
    DB_HOST: "db.internal",
    DB_PORT: "3306",
    DB_NAME: "personal_consultant",
    DB_USER: "application",
    DB_PASSWORD: "private"
  }), {
    ok: false,
    code: "state_database_not_enabled"
  });
});

test("MySQL storage commits only whole transactions and never creates schema", async () => {
  const pool = new MemoryPool();
  const storage = new MySqlKeyValueStorage({ executor: pool, namespace: "owner-settings-v1" });

  await storage.transaction(async (transaction) => {
    await transaction.put("document", { revision: 1 });
    await transaction.put("ledger", ["request"]);
  });
  assert.deepEqual(await storage.get("document"), { revision: 1 });
  assert.deepEqual(await storage.get("ledger"), ["request"]);
  assert.equal(pool.connections[0]?.committed, 1);
  assert.equal(pool.connections[0]?.released, 1);

  await assert.rejects(storage.transaction(async (transaction) => {
    await transaction.put("document", { revision: 2 });
    throw new Error("rollback");
  }), /rollback/);
  assert.deepEqual(await storage.get("document"), { revision: 1 });
  assert.equal(pool.connections[1]?.rolledBack, 1);
  assert.equal(pool.connections[1]?.released, 1);

  await storage.delete("ledger");
  assert.equal(await storage.get("ledger"), undefined);
});
