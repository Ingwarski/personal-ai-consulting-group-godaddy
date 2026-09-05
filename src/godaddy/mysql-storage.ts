import type { RegistrarStorage } from "../session/storage.ts";
import type { SettingsStorage } from "../settings/storage.ts";

type SqlResultRow = Readonly<{ stateValue?: unknown }>;

export type MySqlConnection = Readonly<{
  execute: (statement: string, values: readonly unknown[]) => Promise<readonly [unknown, unknown]>;
  beginTransaction: () => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  release: () => void;
  /** mysql2 exposes destroy(); it is required when a session lock cannot be released safely. */
  destroy?: () => void;
}>;

export type MySqlPool = Readonly<{
  execute: (statement: string, values: readonly unknown[]) => Promise<readonly [unknown, unknown]>;
  getConnection: () => Promise<MySqlConnection>;
}>;

type MySqlExecutor = MySqlPool | MySqlConnection;

export type GodaddyDatabaseConfiguration = Readonly<{
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}>;

export type GodaddyDatabaseConfigurationResult =
  | Readonly<{ ok: true; value: GodaddyDatabaseConfiguration }>
  | Readonly<{ ok: false; code: "state_database_not_enabled" | "invalid_state_database_configuration" }>;

export const GODADDY_STATE_DATABASE_ROLE = "published";
export const GODADDY_STATE_TABLE = "personal_consultant_state";

const SELECT_VALUE = `SELECT state_value AS stateValue FROM ${GODADDY_STATE_TABLE} WHERE state_namespace = ? AND state_key = ? LIMIT 1`;
const SELECT_VALUE_FOR_UPDATE = `${SELECT_VALUE} FOR UPDATE`;
const UPSERT_VALUE = `INSERT INTO ${GODADDY_STATE_TABLE} (state_namespace, state_key, state_value)
  VALUES (?, ?, CAST(? AS JSON))
  ON DUPLICATE KEY UPDATE state_value = VALUES(state_value), updated_at = UTC_TIMESTAMP(6)`;
const DELETE_VALUE = `DELETE FROM ${GODADDY_STATE_TABLE} WHERE state_namespace = ? AND state_key = ?`;

const asRequiredString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 1_024 ? value : undefined;

const isTransactionConnection = (value: MySqlExecutor): value is MySqlConnection =>
  "beginTransaction" in value;

function parseStoredJson(value: unknown): unknown | undefined {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value !== null && typeof value === "object") return value;
  return undefined;
}

function firstRow(value: unknown): SqlResultRow | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const row = value[0];
  return typeof row === "object" && row !== null && !Array.isArray(row) ? row as SqlResultRow : undefined;
}

/**
 * A narrow transactional adapter for the existing registrar/settings domain
 * contracts. It never creates its table: schema changes require their own,
 * explicitly approved production operation.
 */
export class MySqlKeyValueStorage implements RegistrarStorage, SettingsStorage {
  readonly #executor: MySqlExecutor;
  readonly #namespace: string;

  constructor(input: Readonly<{ executor: MySqlExecutor; namespace: string }>) {
    if (!/^[a-z0-9-]{3,64}$/u.test(input.namespace)) {
      throw new Error("MySQL storage namespace must be a short lowercase identifier.");
    }
    this.#executor = input.executor;
    this.#namespace = input.namespace;
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (key.length === 0 || key.length > 191) return undefined;
    // Domain mutations read their versioned document inside transaction(). The
    // row/gap lock prevents two concurrent web requests from both accepting
    // the same revision before one write commits.
    const statement = isTransactionConnection(this.#executor) ? SELECT_VALUE_FOR_UPDATE : SELECT_VALUE;
    const [rows] = await this.#executor.execute(statement, [this.#namespace, key]);
    const row = firstRow(rows);
    if (row === undefined) return undefined;
    return parseStoredJson(row.stateValue) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    if (key.length === 0 || key.length > 191) throw new Error("MySQL storage key is invalid.");
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("MySQL storage value cannot be serialized.");
    await this.#executor.execute(UPSERT_VALUE, [this.#namespace, key, serialized]);
  }

  async delete(key: string): Promise<void> {
    if (key.length === 0 || key.length > 191) throw new Error("MySQL storage key is invalid.");
    await this.#executor.execute(DELETE_VALUE, [this.#namespace, key]);
  }

  async transaction<T>(operation: (storage: MySqlKeyValueStorage) => Promise<T>): Promise<T> {
    if (isTransactionConnection(this.#executor)) return operation(this);

    const connection = await this.#executor.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(new MySqlKeyValueStorage({ executor: connection, namespace: this.#namespace }));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}

/**
 * Preview has no state role by design. This parser exposes connection details
 * only to the server process and never serializes/logs them.
 */
export function parseGodaddyDatabaseConfiguration(
  environment: Record<string, unknown>
): GodaddyDatabaseConfigurationResult {
  if (
    environment.RUNTIME_MODE !== "production" ||
    environment.GODADDY_STATE_DATABASE_ROLE !== GODADDY_STATE_DATABASE_ROLE
  ) {
    return { ok: false, code: "state_database_not_enabled" };
  }

  const host = asRequiredString(environment.DB_HOST);
  const database = asRequiredString(environment.DB_NAME);
  const user = asRequiredString(environment.DB_USER);
  const password = asRequiredString(environment.DB_PASSWORD);
  const portValue = asRequiredString(environment.DB_PORT);
  const port = portValue === undefined ? undefined : Number.parseInt(portValue, 10);
  if (
    host === undefined || database === undefined || user === undefined || password === undefined ||
    port === undefined || !Number.isSafeInteger(port) || port < 1 || port > 65_535 || String(port) !== portValue
  ) {
    return { ok: false, code: "invalid_state_database_configuration" };
  }

  return { ok: true, value: Object.freeze({ host, port, database, user, password }) };
}
