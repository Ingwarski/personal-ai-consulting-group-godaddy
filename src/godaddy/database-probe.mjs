export const DATABASE_METADATA_PROBE_FLAG = "metadata";

const databaseVariableNames = Object.freeze([
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD"
]);

const metadataQuery = `
  SELECT
    TABLE_NAME AS tableName,
    TABLE_TYPE AS tableType,
    TABLE_ROWS AS estimatedRows,
    DATA_LENGTH + INDEX_LENGTH AS estimatedBytes
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
  ORDER BY TABLE_NAME
  LIMIT 200
`;

const nonEmptyValue = (value) => typeof value === "string" && value.length > 0;

const nonNegativeSafeInteger = (value) => {
  const numeric = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
};

const readConnectionConfig = (environment) => {
  const missing = databaseVariableNames.filter((name) => !nonEmptyValue(environment[name]));
  if (missing.length > 0) return { ok: false, code: "database_configuration_missing" };

  const port = Number(environment.DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, code: "database_port_invalid" };
  }

  return {
    ok: true,
    config: {
      host: environment.DB_HOST,
      port,
      user: environment.DB_USER,
      password: environment.DB_PASSWORD,
      database: environment.DB_NAME,
      connectTimeout: 5_000,
      enableKeepAlive: false
    }
  };
};

const publicTableMetadata = (row) => ({
  name: typeof row.tableName === "string" ? row.tableName : "unknown",
  type: typeof row.tableType === "string" ? row.tableType : "unknown",
  estimatedRows: nonNegativeSafeInteger(row.estimatedRows),
  estimatedBytes: nonNegativeSafeInteger(row.estimatedBytes)
});

/**
 * Returns schema metadata only. It never reads table rows, table definitions,
 * credentials, database names, or provider error details.
 */
export async function runDatabaseMetadataProbe({ environment, loadMysql = () => import("mysql2/promise") }) {
  if (environment.GODADDY_DATABASE_PROBE !== DATABASE_METADATA_PROBE_FLAG) {
    return { status: "not_requested" };
  }

  const connectionConfig = readConnectionConfig(environment);
  if (!connectionConfig.ok) return { status: "blocked", code: connectionConfig.code };

  let connection;
  try {
    const mysql = await loadMysql();
    connection = await mysql.createConnection(connectionConfig.config);
    const [rows] = await connection.query(metadataQuery);
    const tables = Array.isArray(rows) ? rows.map(publicTableMetadata) : [];
    return {
      status: "completed",
      tableCount: tables.length,
      truncated: tables.length === 200,
      tables
    };
  } catch {
    return { status: "unavailable", code: "database_metadata_probe_failed" };
  } finally {
    if (connection !== undefined) {
      try {
        await connection.end();
      } catch {
        // The result deliberately keeps provider error details out of logs.
      }
    }
  }
}
