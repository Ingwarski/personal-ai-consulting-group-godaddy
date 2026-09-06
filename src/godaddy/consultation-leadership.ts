import type { MySqlConnection, MySqlPool } from "./mysql-storage.ts";

export interface ConsultationLeadership {
  acquire(): Promise<boolean>;
  check(): Promise<boolean>;
  release(): Promise<void>;
}

const LOCK = "personal-consultant:consultation-worker:v1";
const first = (rows: unknown, key: string): unknown =>
  Array.isArray(rows) && rows.length === 1 && rows[0] !== null && typeof rows[0] === "object"
    ? (rows[0] as Record<string, unknown>)[key] : undefined;

/** One executor per canonical database. This is a connection-owned lock, not
 * a transaction held across provider calls. A crashed connection loses it.
 * Never return a possibly locked connection to the pool. */
export function createConsultationLeadership(pool: MySqlPool): ConsultationLeadership {
  let connection: MySqlConnection | undefined;
  return {
    async acquire() {
      if (connection !== undefined) return this.check();
      const candidate = await pool.getConnection();
      try {
        const [rows] = await candidate.execute("SELECT GET_LOCK(?, 0) AS acquired", [LOCK]);
        if (Number(first(rows, "acquired")) !== 1) { candidate.release(); return false; }
        connection = candidate;
        return true;
      } catch {
        candidate.destroy?.();
        throw new Error("Consultation leadership is unavailable.");
      }
    },
    async check() {
      if (connection === undefined) return false;
      try {
        const [rows] = await connection.execute(
          "SELECT (IS_USED_LOCK(?) = CONNECTION_ID()) AS owned", [LOCK]
        );
        return Number(first(rows, "owned")) === 1;
      } catch { return false; }
    },
    async release() {
      const current = connection;
      connection = undefined;
      if (current === undefined) return;
      try {
        const [rows] = await current.execute("SELECT RELEASE_LOCK(?) AS released", [LOCK]);
        if (Number(first(rows, "released")) === 1) { current.release(); return; }
      } catch { /* Never pool an uncertain lock owner. */ }
      current.destroy?.();
    }
  };
}
