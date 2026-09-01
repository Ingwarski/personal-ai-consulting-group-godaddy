import assert from "node:assert/strict";
import test from "node:test";

import { GODADDY_REGISTRAR_NAMESPACE, createGoDaddyRegistrarRuntime } from "../src/godaddy/registrar-runtime.ts";
import type { MySqlConnection, MySqlPool } from "../src/godaddy/mysql-storage.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

class MemoryConnection implements MySqlConnection {
  readonly #pool: MemoryPool;
  #working: Map<string, string> | undefined;

  constructor(pool: MemoryPool) {
    this.#pool = pool;
  }

  async beginTransaction() {
    this.#working = new Map(this.#pool.values);
  }

  async commit() {
    if (this.#working === undefined) throw new Error("transaction not started");
    this.#pool.values = this.#working;
  }

  async rollback() {}
  release() {}

  execute(statement: string, values: readonly unknown[]) {
    return this.#pool.executeAgainst(this.#working ?? this.#pool.values, statement, values);
  }
}

class MemoryPool implements MySqlPool {
  values = new Map<string, string>();

  async getConnection() {
    return new MemoryConnection(this);
  }

  execute(statement: string, values: readonly unknown[]) {
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
    const payload = values[2];
    if (typeof payload !== "string") throw new Error("invalid fixture payload");
    valuesByKey.set(compositeKey, payload);
    return [{ affectedRows: 1 }, []] as const;
  }
}

test("GoDaddy registrar stores the canonical active session in its own MySQL namespace", async () => {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "registrar-source",
    settingsRevision: 7,
    settings: receipt.defaults,
    capabilityReceipt: receipt
  }, activeNow);
  if (!snapshot.ok) throw new Error("Expected a valid test snapshot.");

  const pool = new MemoryPool();
  const runtime = createGoDaddyRegistrarRuntime({ pool, now: () => activeNow });
  const started = await runtime.registrar.startSession({ sessionId: "registrar-task", settingsSnapshot: snapshot.value });
  assert.equal(started.ok, true);
  assert.equal(pool.values.has(`${GODADDY_REGISTRAR_NAMESPACE}:registrar:active-session`), true);

  assert.deepEqual(await runtime.getActiveSessionSummary(), {
    settingsRevision: 7,
    catalogVersion: receipt.catalogVersion,
    startedAt: activeNow.toISOString(),
    effectiveSettings: receipt.defaults
  });
});
