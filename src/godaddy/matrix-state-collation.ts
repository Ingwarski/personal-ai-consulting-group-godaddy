import type { MySqlPool, MySqlConnection } from "./mysql-storage.ts";

type Executor = Pick<MySqlPool, "execute">;
const COLUMNS = ["state_namespace", "state_key"] as const;
const CYRILLIC_SAMPLE = "Українська: Ґґ Єє Іі Її Київ; Кириллица: Ёё Йй; 🦆";
const ALTER = `ALTER TABLE personal_consultant_state
  MODIFY state_namespace VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  MODIFY state_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;`;

export type StateCollationStatus = Readonly<{ compatible: boolean; repairable: boolean }>;

export async function inspectStateKeyCollation(executor: Executor): Promise<StateCollationStatus> {
  const [rows] = await executor.execute(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type,
    CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, IS_NULLABLE AS nullable,
    COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_COMMENT AS comment
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'personal_consultant_state' AND COLUMN_NAME IN ('state_namespace', 'state_key')`, []);
  if (!Array.isArray(rows) || rows.length !== 2) return { compatible: false, repairable: false };
  const valid = COLUMNS.every((name, index) => {
    const matches = rows.filter(row => row?.name === name);
    const row = matches[0];
    return matches.length === 1 && row.type === (index === 0 ? "varchar(64)" : "varchar(191)")
      && row.charset === "utf8mb4" && row.nullable === "NO" && row.defaultValue === null
      && row.extra === "" && row.comment === ""
      && ["utf8mb4_unicode_ci", "utf8mb4_bin"].includes(row.collation);
  });
  return { compatible: valid && rows.every(row => row.collation === "utf8mb4_bin"), repairable: valid };
}

async function verifyCyrillic(executor: Executor): Promise<void> {
  // Read-only literals: never insert a probe row into the user's data.
  const [rows] = await executor.execute(`SELECT
    HEX(CONVERT(? USING utf8mb4) COLLATE utf8mb4_bin) AS roundTripHex,
    (CONVERT(? USING utf8mb4) COLLATE utf8mb4_bin = CONVERT(? USING utf8mb4) COLLATE utf8mb4_bin) AS sameCase,
    (CONVERT(? USING utf8mb4) COLLATE utf8mb4_bin = CONVERT(? USING utf8mb4) COLLATE utf8mb4_bin) AS differentCase`,
    [CYRILLIC_SAMPLE, "Київ", "Київ", "Київ", "київ"]);
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.roundTripHex !== Buffer.from(CYRILLIC_SAMPLE, "utf8").toString("hex").toUpperCase()
    || rows[0]?.sameCase !== 1 || rows[0]?.differentCase !== 0) throw new Error("Cyrillic verification failed.");
}

async function keyHashes(executor: Executor): Promise<Set<string>> {
  // The server hashes keys. Neither keys nor JSON/credential values leave the
  // database. The bounded hash set remains process-local and is never returned.
  const [rows] = await executor.execute(`SELECT SHA2(CONCAT(HEX(state_namespace), ':', HEX(state_key)), 256) AS keyHash
    FROM personal_consultant_state LIMIT 10001`, []);
  if (!Array.isArray(rows) || rows.length > 10000 || rows.some(row => !/^[a-f0-9]{64}$/.test(row?.keyHash ?? ""))) {
    throw new Error("Key inventory could not be verified.");
  }
  const hashes = new Set<string>(rows.map(row => row.keyHash));
  if (hashes.size !== rows.length) throw new Error("Key inventory is ambiguous.");
  return hashes;
}

export async function repairStateKeyCollation(pool: MySqlPool): Promise<Readonly<{
  compatible: true; cyrillicVerified: true; existingKeysPreserved: true; changed: boolean;
}>> {
  const connection: MySqlConnection = await pool.getConnection();
  let originalWait: number | undefined;
  let sessionChanged = false;
  let reusable = true;
  try {
    // A short metadata-lock wait prevents an operator click from waiting behind
    // a busy transaction indefinitely. Always restore pooled session settings.
    if (connection.destroy === undefined) throw new Error("Connection cleanup unavailable.");
    const before = await inspectStateKeyCollation(connection);
    if (!before.repairable) throw new Error("Unexpected state column definition.");
    await verifyCyrillic(connection);
    if (before.compatible) return { compatible: true, cyrillicVerified: true, existingKeysPreserved: true, changed: false };
    const [waitRows] = await connection.execute("SELECT @@SESSION.lock_wait_timeout AS lockWait", []);
    if (!Array.isArray(waitRows) || waitRows.length !== 1 || !Number.isSafeInteger(waitRows[0]?.lockWait) || waitRows[0].lockWait < 1) throw new Error("Invalid session setting.");
    originalWait = waitRows[0].lockWait;
    sessionChanged = true;
    await connection.execute("SET SESSION lock_wait_timeout = 10", []);
    const hashes = await keyHashes(connection);
    // One fixed DDL statement; no charset/type narrowing, row DML, dropped keys,
    // CREATE/REPLACE, or permission to execute the rest of the schema script.
    await connection.execute(ALTER, []);
    const after = await inspectStateKeyCollation(connection);
    const currentHashes = await keyHashes(connection);
    if (!after.compatible || [...hashes].some(hash => !currentHashes.has(hash))) throw new Error("Post-migration verification failed.");
    // Concurrent application writes may add keys; they cannot mask a lost old key.
    await verifyCyrillic(connection);
    return { compatible: true, cyrillicVerified: true, existingKeysPreserved: true, changed: true };
  } finally {
    if (sessionChanged && originalWait !== undefined) {
      try { await connection.execute("SET SESSION lock_wait_timeout = ?", [originalWait]); }
      catch { reusable = false; connection.destroy?.(); }
    }
    if (reusable) connection.release();
  }
}
