import type { MySqlPool } from "./mysql-storage.ts";

export type MySqlTransportDiagnostics = Readonly<{
  nodeDatabaseReachable: boolean;
  nodeSessionEncrypted: boolean | "unknown";
  serverTlsSupport: "available" | "disabled" | "unknown";
  secureTransportRequired: boolean | "unknown";
}>;

type VariableRow = Readonly<{ Variable_name?: unknown; Value?: unknown }>;

const rows = (value: unknown): readonly VariableRow[] => Array.isArray(value)
  ? value.filter((row): row is VariableRow => typeof row === "object" && row !== null && !Array.isArray(row))
  : [];

const variableMap = (value: unknown): ReadonlyMap<string, string> => new Map(rows(value).flatMap((row) =>
  typeof row.Variable_name === "string" && typeof row.Value === "string"
    ? [[row.Variable_name.toLowerCase(), row.Value.toUpperCase()] as const]
    : []));

/**
 * Owner-only, read-only transport inspection through the exact process-wide
 * mysql2 pool already used by Published. It returns normalized capability
 * facts only: no host, account, schema, certificate, query text or error.
 */
export async function inspectMySqlTransport(pool: MySqlPool): Promise<MySqlTransportDiagnostics> {
  let connection: Awaited<ReturnType<MySqlPool["getConnection"]>> | undefined;
  try {
    connection = await pool.getConnection();
    const [[statusRows], [variableRows]] = await Promise.all([
      connection.execute("SHOW SESSION STATUS LIKE 'Ssl_cipher'", []),
      connection.execute("SHOW VARIABLES WHERE Variable_name IN ('have_ssl', 'require_secure_transport')", [])
    ]);
    const status = variableMap(statusRows);
    const variables = variableMap(variableRows);
    const cipher = status.get("ssl_cipher");
    const tls = variables.get("have_ssl");
    const secure = variables.get("require_secure_transport");
    return Object.freeze({
      nodeDatabaseReachable: true,
      nodeSessionEncrypted: cipher === undefined ? "unknown" : cipher.length > 0,
      serverTlsSupport: tls === "YES" ? "available" : tls === "DISABLED" || tls === "NO" ? "disabled" : "unknown",
      secureTransportRequired: secure === "ON" ? true : secure === "OFF" ? false : "unknown"
    });
  } catch {
    connection?.destroy?.();
    return Object.freeze({
      nodeDatabaseReachable: false,
      nodeSessionEncrypted: "unknown",
      serverTlsSupport: "unknown",
      secureTransportRequired: "unknown"
    });
  } finally {
    connection?.release();
  }
}
