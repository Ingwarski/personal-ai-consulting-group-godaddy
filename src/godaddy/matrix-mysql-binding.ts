import { createHash } from "node:crypto";
import type { MySqlPool } from "./mysql-storage.ts";
import type { GoDaddyMatrixConfiguration } from "./matrix-service-config.ts";
import type { MatrixStoreBindingResult } from "./matrix-store-binding.ts";

export function matrixMySqlStoreId(config: Pick<GoDaddyMatrixConfiguration, "homeserverOrigin" | "roomId" | "botMxid" | "botDeviceId">): Buffer {
  return createHash("sha256").update(JSON.stringify([
    "personal-consultant-matrix-v1", config.homeserverOrigin, config.roomId, config.botMxid, config.botDeviceId
  ]), "utf8").digest().subarray(0, 16);
}

/** Explicit candidate provisioning freezes the old SQLite encryption identity.
 * A missing registry is expected only before this migration has been installed;
 * connection, permission and unknown-column failures are not that permission. */
export async function checkLegacyMatrixStoreAuthority(
  pool: MySqlPool,
  config: GoDaddyMatrixConfiguration
): Promise<Readonly<{ ok: true }> | Extract<MatrixStoreBindingResult, { ok: false }>> {
  try {
    // Deliberately do not filter schema_version: provisioning under a newer schema
    // must also prevent an older deployment from resuming stale SQLite state.
    const [rows] = await pool.execute(
      "SELECT HEX(account_fingerprint) AS fingerprint FROM pc_matrix_stores WHERE store_id = ?",
      [matrixMySqlStoreId(config)]
    );
    if (!Array.isArray(rows)) return { ok: false, code: "store_binding_invalid" };
    if (rows.length === 0) return { ok: true };
    // Even an inactive NULL candidate freezes legacy authority. Otherwise a
    // restarted SQLite writer could advance its ratchets after the import.
    return { ok: false, code: "store_binding_invalid" };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_NO_SUCH_TABLE") {
      return { ok: true };
    }
    return { ok: false, code: "store_binding_transient" };
  }
}

/** Public account fingerprint is installed only by the atomic migration
 * activation. Rust separately verifies its encrypted binding and actual key. */
export async function readMySqlMatrixStoreBinding(pool: MySqlPool, config: GoDaddyMatrixConfiguration): Promise<MatrixStoreBindingResult> {
  try {
    const [rows] = await pool.execute(
      "SELECT HEX(account_fingerprint) AS fingerprint FROM pc_matrix_stores WHERE store_id = ? AND schema_version = 1",
      [matrixMySqlStoreId(config)]
    );
    if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) return { ok: false, code: "store_binding_missing" };
    const fp = (rows[0] as Record<string, unknown>).fingerprint;
    if (typeof fp !== "string" || !/^[a-fA-F0-9]{64}$/u.test(fp)) return { ok: false, code: "store_binding_invalid" };
    return { ok: true, value: { deviceId: config.botDeviceId, storeFingerprint: fp.toLowerCase() } };
  } catch { return { ok: false, code: "store_binding_transient" }; }
}
