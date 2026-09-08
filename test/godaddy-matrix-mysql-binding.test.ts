import assert from "node:assert/strict";
import test from "node:test";
import { checkLegacyMatrixStoreAuthority, matrixMySqlStoreId, readMySqlMatrixStoreBinding } from "../src/godaddy/matrix-mysql-binding.ts";
import type { GoDaddyMatrixConfiguration } from "../src/godaddy/matrix-service-config.ts";
import type { MySqlPool } from "../src/godaddy/mysql-storage.ts";

const configuration = {
  homeserverOrigin: "https://matrix.org",
  roomId: "!private-room:matrix.org",
  botMxid: "@consultant-bot:matrix.org",
  botDeviceId: "BOT_DEVICE_1"
} as GoDaddyMatrixConfiguration;

function poolReturning(rows: unknown, inspect?: (statement: string, values: readonly unknown[]) => void): MySqlPool {
  return {
    execute: async (statement, values) => { inspect?.(statement, values); return [rows, []]; },
    getConnection: async () => { throw new Error("binding lookup must not open transactions"); }
  };
}

function poolThrowing(error: unknown): MySqlPool {
  return { ...poolReturning([]), execute: async () => { throw error; } };
}

test("MySQL namespace matches pinned Rust JSON-tuple coordinates, not owner or secrets", () => {
  assert.equal(matrixMySqlStoreId(configuration).toString("hex"), "bffc6137918f06551a73123b566c15ef");
  assert.deepEqual(matrixMySqlStoreId({ ...configuration, ownerMxid: "@different:matrix.org" } as GoDaddyMatrixConfiguration), matrixMySqlStoreId(configuration));
  for (const field of ["roomId", "botMxid", "botDeviceId", "homeserverOrigin"] as const) {
    assert.notDeepEqual(matrixMySqlStoreId({ ...configuration, [field]: `${configuration[field]}-different` }), matrixMySqlStoreId(configuration));
  }
});

test("MySQL binding reads only exact store ID and validates activation fingerprint", async () => {
  const result = await readMySqlMatrixStoreBinding(poolReturning([{ fingerprint: "AB".repeat(32) }], (statement, values) => {
    assert.match(statement, /WHERE store_id = \? AND schema_version = 1/u);
    assert.deepEqual(values, [matrixMySqlStoreId(configuration)]);
  }), configuration);
  assert.deepEqual(result, { ok: true, value: { deviceId: configuration.botDeviceId, storeFingerprint: "ab".repeat(32) } });
  for (const fingerprint of [null, undefined, "", "f".repeat(63), 123]) {
    assert.deepEqual(await readMySqlMatrixStoreBinding(poolReturning([{ fingerprint }]), configuration), { ok: false, code: "store_binding_invalid" });
  }
  assert.deepEqual(await readMySqlMatrixStoreBinding(poolReturning([]), configuration), { ok: false, code: "store_binding_missing" });
  // MySQL mode never falls back even when the new table has not been installed.
  assert.deepEqual(await readMySqlMatrixStoreBinding(poolThrowing({ code: "ER_NO_SUCH_TABLE" }), configuration), { ok: false, code: "store_binding_transient" });
});

test("legacy SQLite may start only before candidate provisioning and exact missing-table error is allowed", async () => {
  for (const rows of [[]]) {
    assert.deepEqual(await checkLegacyMatrixStoreAuthority(poolReturning(rows, (statement, values) => {
      assert.match(statement, /WHERE store_id = \?$/u);
      assert.doesNotMatch(statement, /schema_version/u);
      assert.deepEqual(values, [matrixMySqlStoreId(configuration)]);
    }), configuration), { ok: true });
  }
  assert.deepEqual(await checkLegacyMatrixStoreAuthority(poolThrowing({ code: "ER_NO_SUCH_TABLE" }), configuration), { ok: true });
});

test("inactive, activated or malformed MySQL registry forbids stale SQLite rollback", async () => {
  for (const rows of [[{ fingerprint: null }], [{ fingerprint: "aa".repeat(32) }], [{ fingerprint: "invalid" }], [{}], [null], [[], []], undefined, {}]) {
    assert.deepEqual(await checkLegacyMatrixStoreAuthority(poolReturning(rows), configuration), { ok: false, code: "store_binding_invalid" });
  }
});

test("DB outage, permission, unknown-column and lookalike errors never authorize SQLite", async () => {
  for (const error of [
    { code: "ETIMEDOUT" }, { code: "ECONNREFUSED" }, { code: "ER_ACCESS_DENIED_ERROR" },
    { code: "ER_BAD_FIELD_ERROR" }, { code: 1146 }, { code: "er_no_such_table" },
    new Error("ER_NO_SUCH_TABLE"), null
  ]) {
    assert.deepEqual(await checkLegacyMatrixStoreAuthority(poolThrowing(error), configuration), { ok: false, code: "store_binding_transient" });
  }
});
