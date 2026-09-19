import { createPool } from "mysql2/promise";

import type { GodaddyDatabaseConfiguration, MySqlPool } from "./mysql-storage.ts";

export type CloseableMySqlPool = MySqlPool & Readonly<{
  end: () => Promise<void>;
}>;

/**
 * Creates the one process-wide Published-state pool. Callers inject this same
 * pool into Settings, registrar, archive and consultation consumers so those
 * modules cannot accidentally create competing connection pools.
 */
export function createGodaddyMySqlPool(configuration: GodaddyDatabaseConfiguration): CloseableMySqlPool {
  return createPool({
    host: configuration.host,
    port: configuration.port,
    database: configuration.database,
    user: configuration.user,
    password: configuration.password,
    waitForConnections: true,
    connectionLimit: configuration.connectionLimit,
    // Settings, registrar, archive and consultation share this process-wide pool.
    // Keep the wait queue finite so a stalled database creates backpressure
    // instead of unbounded heap growth.
    queueLimit: 32,
    enableKeepAlive: true
  }) as unknown as CloseableMySqlPool;
}
