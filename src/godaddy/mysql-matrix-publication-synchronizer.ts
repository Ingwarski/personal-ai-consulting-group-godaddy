import type { MatrixPublicationSynchronizer } from "./matrix-service.ts";
import { GODADDY_MATRIX_OUTBOX_TABLE } from "./mysql-matrix-outbox.ts";
import type { MySqlConnection, MySqlPool } from "./mysql-storage.ts";

const PUBLICATION_LOCK_NAME = "personal-consultant:matrix-publication:v1";
const DEFAULT_LOCK_TIMEOUT_SECONDS = 35;
const ACQUIRE_PUBLICATION_LOCK = "SELECT GET_LOCK(?, ?) AS acquired";
const RELEASE_PUBLICATION_LOCK = "SELECT RELEASE_LOCK(?) AS released";
const SELECT_LEASED_GENERATION = `SELECT COUNT(*) AS leasedCount FROM ${GODADDY_MATRIX_OUTBOX_TABLE}
  WHERE generation = ? AND state = 'leased'`;

type SqlRow = Readonly<Record<string, unknown>>;

function oneRow(value: unknown): SqlRow | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const row = value[0];
  return typeof row === "object" && row !== null && !Array.isArray(row)
    ? row as SqlRow
    : undefined;
}

function exactInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

export type MatrixPublicationSynchronizationErrorCode =
  | "publication_lock_unavailable"
  | "publication_lock_release_failed"
  | "publication_state_invalid"
  | "publication_unresolved";

export class MatrixPublicationSynchronizationError extends Error {
  readonly code: MatrixPublicationSynchronizationErrorCode;

  constructor(code: MatrixPublicationSynchronizationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "MatrixPublicationSynchronizationError";
    this.code = code;
  }
}

async function releaseLockedConnection(connection: MySqlConnection): Promise<void> {
  let released = false;
  try {
    const [rows] = await connection.execute(RELEASE_PUBLICATION_LOCK, [PUBLICATION_LOCK_NAME]);
    released = exactInteger(oneRow(rows)?.released) === 1;
  } catch {
    released = false;
  }
  if (released) {
    connection.release();
    return;
  }
  // Returning a connection that may still own a named lock to the pool would
  // silently preserve the lock for an unrelated borrower. Destroy it instead.
  connection.destroy?.();
  throw new MatrixPublicationSynchronizationError("publication_lock_release_failed");
}

/**
 * Serializes Matrix publication and generation fencing across every Node
 * process connected to the same MySQL server. The advisory lock is held on a
 * dedicated connection while the callback uses the shared pool normally.
 */
export class MySqlMatrixPublicationSynchronizer implements MatrixPublicationSynchronizer {
  readonly #pool: MySqlPool;
  readonly #lockTimeoutSeconds: number;

  constructor(pool: MySqlPool, lockTimeoutSeconds = DEFAULT_LOCK_TIMEOUT_SECONDS) {
    if (!Number.isSafeInteger(lockTimeoutSeconds) || lockTimeoutSeconds < 1 || lockTimeoutSeconds > 60) {
      throw new Error("Invalid Matrix publication lock timeout.");
    }
    this.#pool = pool;
    this.#lockTimeoutSeconds = lockTimeoutSeconds;
  }

  async #withLock<Value>(operation: (connection: MySqlConnection) => Promise<Value>): Promise<Value> {
    const connection = await this.#pool.getConnection();
    let acquired = false;
    let acquisitionKnownSafeToPool = false;
    let operationResult: Value | undefined;
    let operationError: unknown;
    let operationFailed = false;
    try {
      const [rows] = await connection.execute(ACQUIRE_PUBLICATION_LOCK, [
        PUBLICATION_LOCK_NAME,
        this.#lockTimeoutSeconds
      ]);
      const acquisitionResult = exactInteger(oneRow(rows)?.acquired);
      acquired = acquisitionResult === 1;
      acquisitionKnownSafeToPool = acquisitionResult === 0;
      if (!acquired) throw new MatrixPublicationSynchronizationError("publication_lock_unavailable");
      operationResult = await operation(connection);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    if (!acquired) {
      // A definite timeout (0) never acquired the lock. A malformed/failed
      // response has unknown session state and must not return to the pool.
      if (acquisitionKnownSafeToPool) connection.release();
      else connection.destroy?.();
      throw operationError;
    }

    try {
      await releaseLockedConnection(connection);
    } catch (releaseError) {
      throw new MatrixPublicationSynchronizationError("publication_lock_release_failed", {
        cause: operationError ?? releaseError
      });
    }
    if (operationFailed) throw operationError;
    return operationResult as Value;
  }

  withPublicationPermit<Value>(publish: () => Promise<Value>): Promise<Value> {
    return this.#withLock(async () => publish());
  }

  withGenerationFence<Value>(
    input: Readonly<{ generation: number }>,
    fence: () => Promise<Value>
  ): Promise<Value> {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      return Promise.reject(new MatrixPublicationSynchronizationError("publication_state_invalid"));
    }
    return this.#withLock(async (connection) => {
      const [rows] = await connection.execute(SELECT_LEASED_GENERATION, [input.generation]);
      const leasedCount = exactInteger(oneRow(rows)?.leasedCount);
      if (leasedCount === undefined) {
        throw new MatrixPublicationSynchronizationError("publication_state_invalid");
      }
      // A lease may represent a Matrix acceptance whose MySQL response was
      // lost. Never cancel it: deterministic transaction replay must reconcile
      // the acceptance before Stop/new-task can complete.
      if (leasedCount !== 0) {
        throw new MatrixPublicationSynchronizationError("publication_unresolved");
      }
      return fence();
    });
  }
}
