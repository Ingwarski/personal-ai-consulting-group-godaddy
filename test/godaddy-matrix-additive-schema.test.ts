import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createMissingMatrixTables, inspectMatrixSchema, MATRIX_ADDITIVE_TABLES } from "../src/godaddy/matrix-additive-schema.ts";
import { MatrixSchemaPool } from "./fixtures/matrix-schema-pool.ts";

test("additive operation executes exactly the two canonical CREATE blocks and retries without changes", async () => {
  const pool = new MatrixSchemaPool();
  assert.deepEqual((await inspectMatrixSchema(pool)).missing, MATRIX_ADDITIVE_TABLES);
  assert.equal(pool.creates.length, 0);
  const canonical = await readFile(new URL("../scripts/godaddy-state-schema.sql", import.meta.url), "utf8");
  await createMissingMatrixTables(pool);
  assert.equal(pool.creates.length, 2);
  for (const [index, name] of MATRIX_ADDITIVE_TABLES.entries()) {
    const start = canonical.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
    assert.ok(start > 0);
    assert.equal(pool.creates[index], canonical.slice(start, canonical.indexOf(";", start) + 1));
  }
  assert.deepEqual((await createMissingMatrixTables(pool)).missing, []);
  assert.equal(pool.creates.length, 2, "Existing tables are not changed or re-created");
  assert.ok(pool.schemaStatements.every(sql => /^(SELECT|CREATE TABLE IF NOT EXISTS) /.test(sql)));
});

test("partial DDL failure preserves the created table and retry creates only the remaining one", async () => {
  const pool = new MatrixSchemaPool(); pool.failCreateAt = 1;
  await assert.rejects(createMissingMatrixTables(pool));
  assert.deepEqual([...pool.tables], [MATRIX_ADDITIVE_TABLES[0]]);
  pool.failCreateAt = -1;
  await createMissingMatrixTables(pool);
  assert.equal(pool.creates.length, 2);
  assert.deepEqual([...pool.tables], MATRIX_ADDITIVE_TABLES);
});

test("malformed inventory fails closed before CREATE", async () => {
  const pool = new MatrixSchemaPool(); pool.invalidInventory = true;
  await assert.rejects(createMissingMatrixTables(pool));
  assert.equal(pool.creates.length, 0);
});
