import { parseRuntimeEnvironment } from "../runtime/environment.ts";
import {
  createGoDaddyMatrixService,
  type DurableMatrixMediaConsumer,
  type GoDaddyMatrixService,
  type MatrixPublicationSynchronizer
} from "./matrix-service.ts";
import { createGodaddyMySqlPool, type CloseableMySqlPool } from "./mysql-pool.ts";
import {
  parseGodaddyDatabaseConfiguration,
  type GodaddyDatabaseConfiguration
} from "./mysql-storage.ts";
import {
  createGoDaddyRegistrarRuntime,
  type GoDaddyRegistrarRuntime
} from "./registrar-runtime.ts";
import {
  createGoDaddySettingsRuntime,
  type GoDaddySettingsRuntime,
  type GoDaddySettingsRuntimeDependencies
} from "./settings-runtime.ts";

export type GoDaddyApplicationRuntime = Readonly<{
  configured: boolean;
  settings: GoDaddySettingsRuntime;
  registrarRuntime?: GoDaddyRegistrarRuntime;
  matrixService?: GoDaddyMatrixService;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}>;

type MatrixServiceFactory = (input: Readonly<{
  environment: Record<string, unknown>;
  pool: CloseableMySqlPool;
  registrarRuntime: GoDaddyRegistrarRuntime;
  now: () => Date;
}>, dependencies?: Readonly<{
  mediaConsumer?: DurableMatrixMediaConsumer;
  publicationSynchronizer?: MatrixPublicationSynchronizer;
}>) => GoDaddyMatrixService;

export type GoDaddyApplicationRuntimeDependencies = Readonly<{
  createPool?: (configuration: GodaddyDatabaseConfiguration) => CloseableMySqlPool;
  createRegistrarRuntime?: typeof createGoDaddyRegistrarRuntime;
  createSettingsRuntime?: (
    environment: Record<string, unknown>,
    dependencies: GoDaddySettingsRuntimeDependencies
  ) => GoDaddySettingsRuntime;
  createMatrixService?: MatrixServiceFactory;
  /** U-08 supplies the idempotent durable consumer; absence keeps Matrix readiness blocked. */
  matrixMediaConsumer?: DurableMatrixMediaConsumer;
  now?: () => Date;
  shutdownTimeoutMs?: number;
}>;

async function completeBeforeDeadline(
  operation: () => Promise<void>,
  deadlineMs: number,
  operationName: string
): Promise<void> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw new Error(`Application shutdown deadline elapsed before ${operationName}.`);
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Application shutdown timed out during ${operationName}.`)),
          remaining
        );
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Builds the single process composition root. Only the exact Published role
 * may create a pool, touch Matrix state or start background work. Development,
 * test and Preview-like configurations receive only the inert Settings shell.
 */
export function createGoDaddyApplicationRuntime(
  input: Readonly<{ environment?: Record<string, unknown> }> = {},
  dependencies: GoDaddyApplicationRuntimeDependencies = {}
): GoDaddyApplicationRuntime {
  const environment = input.environment ?? process.env;
  const now = dependencies.now ?? (() => new Date());
  const runtime = parseRuntimeEnvironment(environment);
  const database = parseGodaddyDatabaseConfiguration(environment);
  const createSettings = dependencies.createSettingsRuntime ?? createGoDaddySettingsRuntime;
  const shutdownTimeoutMs = dependencies.shutdownTimeoutMs ?? 12_000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1_000 || shutdownTimeoutMs > 30_000) {
    throw new Error("Invalid application shutdown timeout.");
  }

  if (!runtime.ok || runtime.value.runtimeMode !== "production" || !database.ok) {
    const settings = createSettings(environment, { now });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      configured: false,
      settings,
      async start(): Promise<void> {},
      stop(): Promise<void> {
        closePromise ??= settings.close().catch(() => undefined);
        return closePromise;
      }
    });
  }

  const pool = (dependencies.createPool ?? createGodaddyMySqlPool)(database.value);
  let matrixService: GoDaddyMatrixService | undefined;
  let wakePending = false;
  const registrarRuntime = (dependencies.createRegistrarRuntime ?? createGoDaddyRegistrarRuntime)({
    pool,
    now,
    wakeMatrixOutbox: () => {
      if (matrixService === undefined) {
        wakePending = true;
        return;
      }
      matrixService.wakeOutbox();
    }
  });
  const settings = createSettings(environment, { pool, registrarRuntime, now });
  const createdMatrixService = (dependencies.createMatrixService ?? createGoDaddyMatrixService)(
    { environment, pool, registrarRuntime, now },
    {
      publicationSynchronizer: registrarRuntime.matrixPublicationSynchronizer,
      ...(dependencies.matrixMediaConsumer === undefined
        ? {}
        : { mediaConsumer: dependencies.matrixMediaConsumer })
    }
  );
  matrixService = createdMatrixService;
  if (wakePending) createdMatrixService.wakeOutbox();

  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopping = false;
  const configured = settings.configured && createdMatrixService.configured;

  const start = (): Promise<void> => {
    if (stopping || !createdMatrixService.configured) return Promise.resolve();
    startPromise ??= createdMatrixService.start().catch(() => undefined);
    return startPromise;
  };

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      stopping = true;
      const deadline = Date.now() + shutdownTimeoutMs;
      // Stop intake/background publication first, provider-owned processes
      // second, and the one shared database pool last. A failed/timed-out
      // predecessor prevents later teardown from racing a live state user.
      await completeBeforeDeadline(() => createdMatrixService.stop(), deadline, "Matrix shutdown");
      await completeBeforeDeadline(() => settings.close(), deadline, "provider shutdown");
      await completeBeforeDeadline(() => pool.end(), deadline, "database shutdown");
    })();
    return stopPromise;
  };

  return Object.freeze({
    configured,
    settings,
    registrarRuntime,
    matrixService: createdMatrixService,
    start,
    stop
  });
}
