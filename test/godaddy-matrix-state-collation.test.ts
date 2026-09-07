import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { inspectStateKeyCollation, repairStateKeyCollation } from "../src/godaddy/matrix-state-collation.ts";
import { MatrixCollationPool } from "./fixtures/matrix-collation-pool.ts";

test("Cyrillic-preserving repair executes only the canonical two-column ALTER and is idempotent", async () => {
  const pool = new MatrixCollationPool();
  assert.deepEqual(await inspectStateKeyCollation(pool), { compatible: false, repairable: true });
  assert.equal(pool.alters.length, 0);
  assert.deepEqual(await repairStateKeyCollation(pool), { compatible: true, cyrillicVerified: true, existingKeysPreserved: true, changed: true });
  const sql = await readFile(new URL("../scripts/godaddy-state-schema.sql", import.meta.url), "utf8");
  const start = sql.indexOf("ALTER TABLE personal_consultant_state\n");
  assert.equal(pool.alters[0], sql.slice(start, sql.indexOf(";", start) + 1));
  assert.equal(pool.restored, true); assert.equal(pool.migrationReleased, true);
  assert.equal((await repairStateKeyCollation(pool)).changed, false);
  assert.equal(pool.alters.length, 1);
  assert.ok(pool.queries.every(q => /^(SELECT|SET SESSION|ALTER TABLE personal_consultant_state)/.test(q)));
});

test("unexpected charset or collation, failed Cyrillic round-trip, and case folding block ALTER", async () => {
  for (const change of [
    (p: MatrixCollationPool) => { p.charset = "latin1"; },
    (p: MatrixCollationPool) => { p.collation = "utf8mb4_general_ci"; },
    (p: MatrixCollationPool) => { p.roundTripValid = false; },
    (p: MatrixCollationPool) => { p.caseValid = false; }
  ]) {
    const pool = new MatrixCollationPool(); change(pool);
    await assert.rejects(repairStateKeyCollation(pool)); assert.equal(pool.alters.length, 0);
  }
});

test("DDL failure restores the session and missing old keys cannot be reported as a successful repair", async () => {
  for (const failAlter of [true, false]) {
    const pool = new MatrixCollationPool(); pool.failAlter = failAlter; pool.loseKey = !failAlter;
    await assert.rejects(repairStateKeyCollation(pool));
    assert.equal(pool.restored, true); assert.equal(pool.migrationReleased, true);
  }
});

test("a connection whose session settings cannot be restored is destroyed, not returned to the pool", async () => {
  const pool = new MatrixCollationPool(); pool.failRestore = true;
  await repairStateKeyCollation(pool);
  assert.equal(pool.destroyed, true); assert.equal(pool.migrationReleased, false);
});
