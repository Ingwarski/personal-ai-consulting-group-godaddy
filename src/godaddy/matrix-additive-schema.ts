import type { MySqlPool } from "./mysql-storage.ts";

// These are the only statements this explicitly invoked operation can execute.
// Tests bind their bytes to the two canonical CREATE blocks; never run the full
// schema script here, because it also contains changes to existing tables.
export const MATRIX_ADDITIVE_TABLES = ["personal_consultant_matrix_outbox","personal_consultant_matrix_ingress"] as const;
const CREATES = [
  `CREATE TABLE IF NOT EXISTS personal_consultant_matrix_outbox (
  generation BIGINT UNSIGNED NOT NULL,
  sequence_no BIGINT UNSIGNED NOT NULL,
  transaction_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state ENUM('pending', 'leased', 'accepted', 'device_delivered', 'read', 'blocked', 'cancelled') NOT NULL,
  record_kind ENUM('message', 'control') NOT NULL,
  message_json JSON NOT NULL,
  body_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  delivery_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reply_to_event_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  matrix_event_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0,
  lease_expires_at VARCHAR(64) NULL,
  attempt_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_error_code VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NULL,
  available_at VARCHAR(64) NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  accepted_at VARCHAR(64) NULL,
  device_delivered_at VARCHAR(64) NULL,
  read_at VARCHAR(64) NULL,
  device_delivery_evidence_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  device_delivery_evidence_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  read_evidence_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  read_evidence_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (generation, sequence_no),
  UNIQUE KEY uq_matrix_outbox_transaction (transaction_id),
  UNIQUE KEY uq_matrix_outbox_event (matrix_event_id),
  KEY ix_matrix_outbox_head (state, generation, sequence_no)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
  `CREATE TABLE IF NOT EXISTS personal_consultant_matrix_ingress (
  event_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  event_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state ENUM('ready', 'leased', 'processed', 'rejected', 'blocked') NOT NULL,
  room_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  owner_mxid VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  body_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  media_manifest_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  work_intent_json JSON NOT NULL,
  ack_eligible_at VARCHAR(64) NULL,
  media_consumption_receipt_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  media_consumed_at VARCHAR(64) NULL,
  lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0,
  lease_expires_at VARCHAR(64) NULL,
  session_id VARCHAR(128) NULL,
  generation BIGINT UNSIGNED NULL,
  received_at VARCHAR(64) NOT NULL,
  acknowledged_at VARCHAR(64) NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (event_id),
  KEY ix_matrix_ingress_recovery (state, lease_expires_at)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
] as const;

export type MatrixSchemaInventory = Readonly<{
  present: readonly string[];
  missing: readonly string[];
  stateKeyCollations: Readonly<Record<string, string>>;
}>;

export async function inspectMatrixSchema(pool: MySqlPool): Promise<MatrixSchemaInventory> {
  const [rows] = await pool.execute(
    "SELECT TABLE_NAME AS tableName, TABLE_TYPE AS tableType FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?)",
    MATRIX_ADDITIVE_TABLES);
  if (!Array.isArray(rows) || rows.length > 2 || rows.some(row => !row
    || !MATRIX_ADDITIVE_TABLES.includes(row.tableName) || row.tableType !== "BASE TABLE")
    || new Set(rows.map(row => row.tableName)).size !== rows.length) throw new Error("Invalid schema inventory.");
  const present = MATRIX_ADDITIVE_TABLES.filter(name => rows.some(row => row.tableName === name));
  const [columns] = await pool.execute(
    "SELECT COLUMN_NAME AS columnName, COLLATION_NAME AS collationName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_consultant_state' AND COLUMN_NAME IN ('state_namespace', 'state_key')", []);
  const stateKeyCollations: Record<string, string> = {};
  if (!Array.isArray(columns)) throw new Error("Invalid column inventory.");
  for (const row of columns) {
    if (!row || !["state_namespace", "state_key"].includes(row.columnName)
      || typeof row.collationName !== "string" || !/^[a-z0-9_]{1,64}$/.test(row.collationName)) throw new Error("Invalid column inventory.");
    stateKeyCollations[row.columnName] = row.collationName;
  }
  return { present, missing: MATRIX_ADDITIVE_TABLES.filter(name => !present.includes(name)), stateKeyCollations };
}

/** No ALTER, row writes, arbitrary identifiers, implicit startup or GET calls.
 * MySQL DDL is not transactional. If the second create fails, preserve the first
 * and inspect before a retry. IF NOT EXISTS protects a concurrent creator too.
 */
export async function createMissingMatrixTables(pool: MySqlPool): Promise<MatrixSchemaInventory> {
  const before = await inspectMatrixSchema(pool);
  for (const [index, name] of MATRIX_ADDITIVE_TABLES.entries()) {
    if (before.missing.includes(name)) await pool.execute(CREATES[index]!, []);
  }
  const after = await inspectMatrixSchema(pool);
  if (after.missing.length !== 0) throw new Error("Schema creation was not confirmed.");
  return after;
}
