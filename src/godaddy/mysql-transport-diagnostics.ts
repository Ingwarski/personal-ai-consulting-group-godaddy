import { createConnection } from "mysql2/promise";
import { getCACertificates } from "node:tls";

import type { GodaddyDatabaseConfiguration, MySqlPool } from "./mysql-storage.ts";

export type VerifiedTlsResult = "connected" | "server_not_supported" | "certificate_rejected"
  | "login_or_database_failed" | "network_failed" | "connection_closed" | "failed" | "not_checked";

export type MySqlTransportDiagnostics = Readonly<{
  nodeDatabaseReachable: boolean;
  nodeSessionEncrypted: boolean | "unknown";
  nodeExtraCaConfigured: boolean;
  nodeAdditionalSystemCaActive: boolean;
  serverTlsSupport: "available" | "disabled" | "unknown";
  secureTransportRequired: boolean | "unknown";
  verifiedTlsConnection: VerifiedTlsResult;
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
type ProbeConnection = Readonly<{
  execute: (statement: string, values: readonly unknown[]) => Promise<readonly [unknown, unknown]>;
  end: () => Promise<void>;
  destroy?: () => void;
}>;

type TlsConnector = (configuration: GodaddyDatabaseConfiguration) => Promise<ProbeConnection>;

const defaultTlsConnector: TlsConnector = async (configuration) => createConnection({
  host: configuration.host,
  port: configuration.port,
  database: configuration.database,
  user: configuration.user,
  password: configuration.password,
  connectTimeout: 10_000,
  ssl: { rejectUnauthorized: true }
}) as unknown as ProbeConnection;

function nodeTrustConfiguration(): Readonly<{
  nodeExtraCaConfigured: boolean;
  nodeAdditionalSystemCaActive: boolean;
}> {
  const bundled = new Set(getCACertificates("bundled"));
  const extra = new Set(getCACertificates("extra"));
  const active = getCACertificates("default");
  return Object.freeze({
    nodeExtraCaConfigured: extra.size > 0,
    nodeAdditionalSystemCaActive: active.some((certificate) => !bundled.has(certificate) && !extra.has(certificate))
  });
}

function classifyTlsFailure(error: unknown): VerifiedTlsResult {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : "";
  if (code === "HANDSHAKE_NO_SSL_SUPPORT") return "server_not_supported";
  if (["HANDSHAKE_SSL_ERROR", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_HAS_EXPIRED"].includes(code)) return "certificate_rejected";
  if (["ER_ACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR"].includes(code)) return "login_or_database_failed";
  if (["ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
    return "network_failed";
  }
  if (["ECONNRESET", "EPIPE", "PROTOCOL_CONNECTION_LOST"].includes(code)) return "connection_closed";
  return "failed";
}

async function probeVerifiedTls(
  configuration: GodaddyDatabaseConfiguration,
  connect: TlsConnector
): Promise<VerifiedTlsResult> {
  let connection: ProbeConnection | undefined;
  try {
    connection = await connect(configuration);
    const [result] = await connection.execute("SHOW SESSION STATUS LIKE 'Ssl_cipher'", []);
    const cipher = variableMap(result).get("ssl_cipher");
    return cipher !== undefined && cipher.length > 0 ? "connected" : "failed";
  } catch (error) {
    connection?.destroy?.();
    return classifyTlsFailure(error);
  } finally {
    await connection?.end().catch(() => undefined);
  }
}

export async function inspectMySqlTransport(
  pool: MySqlPool,
  configuration?: GodaddyDatabaseConfiguration,
  dependencies: Readonly<{ connectTls?: TlsConnector }> = {}
): Promise<MySqlTransportDiagnostics> {
  const trust = nodeTrustConfiguration();
  let connection: Awaited<ReturnType<MySqlPool["getConnection"]>> | undefined;
  let destroyed = false;
  try {
    connection = await pool.getConnection();
    const [statusRows] = await connection.execute("SHOW SESSION STATUS LIKE 'Ssl_cipher'", []);
    const [variableRows] = await connection.execute(
      "SHOW VARIABLES WHERE Variable_name IN ('have_ssl', 'require_secure_transport')", []
    );
    const status = variableMap(statusRows);
    const variables = variableMap(variableRows);
    const cipher = status.get("ssl_cipher");
    const tls = variables.get("have_ssl");
    const secure = variables.get("require_secure_transport");
    return Object.freeze({
      nodeDatabaseReachable: true,
      nodeSessionEncrypted: cipher === undefined ? "unknown" : cipher.length > 0,
      ...trust,
      serverTlsSupport: tls === "YES" ? "available" : tls === "DISABLED" || tls === "NO" ? "disabled" : "unknown",
      secureTransportRequired: secure === "ON" ? true : secure === "OFF" ? false : "unknown",
      verifiedTlsConnection: configuration === undefined ? "not_checked"
        : await probeVerifiedTls(configuration, dependencies.connectTls ?? defaultTlsConnector)
    });
  } catch {
    connection?.destroy?.();
    destroyed = connection !== undefined;
    return Object.freeze({
      nodeDatabaseReachable: false,
      nodeSessionEncrypted: "unknown",
      ...trust,
      serverTlsSupport: "unknown",
      secureTransportRequired: "unknown",
      verifiedTlsConnection: "not_checked"
    });
  } finally {
    if (!destroyed) connection?.release();
  }
}
