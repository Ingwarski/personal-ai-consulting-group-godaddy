import type { GoDaddyConsiliumRequest, GoDaddyConsiliumResult } from "./consilium-runtime.ts";
import { createHash, hkdfSync } from "node:crypto";
import { createMatrixConsultationService, type MatrixConsultationService } from "./matrix-consultation-service.ts";
import { createConsultationLeadership } from "./consultation-leadership.ts";
import { createMySqlMatrixConsultationMediaStore, type MatrixConsultationMediaStore } from "./matrix-consultation-media.ts";
import { createConsultationMediaAdapter } from "./consultation-media-adapter.ts";
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
  MySqlKeyValueStorage,
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
  consultationService?: MatrixConsultationService;
  runConsilium?: (request: GoDaddyConsiliumRequest) => Promise<GoDaddyConsiliumResult>;
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
  /** Test adapter override; production supplies the durable encrypted consumer. */
  matrixMediaConsumer?: DurableMatrixMediaConsumer;
  createConsultationService?: typeof createMatrixConsultationService;
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
  let mediaStore: MatrixConsultationMediaStore | undefined;
  if (typeof environment.MATRIX_STORE_PASSPHRASE === "string" && /^[a-f0-9]{64}$/.test(environment.MATRIX_STORE_PASSPHRASE)) {
    // Domain-separated staging key; never reuse the SQLite passphrase directly
    // as an AEAD key, write it to MySQL, or forward it to a model.
    const stagingKey = new Uint8Array(hkdfSync("sha256", environment.MATRIX_STORE_PASSPHRASE,
      "personal-consultant-media", "matrix-consultation-media-v1", 32));
    try { mediaStore = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: stagingKey, now: () => now().getTime() }); }
    finally { stagingKey.fill(0); }
  }
  const mediaConsumer = dependencies.matrixMediaConsumer ?? mediaStore?.consume;
  const createdMatrixService = (dependencies.createMatrixService ?? createGoDaddyMatrixService)(
    { environment, pool, registrarRuntime, now },
    {
      publicationSynchronizer: registrarRuntime.matrixPublicationSynchronizer,
      ...(mediaConsumer === undefined
        ? {}
        : { mediaConsumer })
    }
  );
  matrixService = createdMatrixService;
  if (wakePending) createdMatrixService.wakeOutbox();
  const consultationService = settings.consilium === undefined || settings.prepareConsultationSnapshot === undefined ? undefined
    : (dependencies.createConsultationService ?? createMatrixConsultationService)({
      storage: new MySqlKeyValueStorage({ executor: pool, namespace: "matrix-consultation-v1" }),
      ingress: registrarRuntime.matrixIngressReceipts, registrar: registrarRuntime.registrar,
      executor: settings.consilium, prepareSnapshot: settings.prepareConsultationSnapshot,
      async resolveReplySession(matrixEventId) {
        const generation = await registrarRuntime.matrixOutbox.resolveAcceptedGeneration(matrixEventId);
        return generation === undefined ? undefined : (await registrarRuntime.registrar.getSession(generation))?.sessionId;
      },
      afterConfirmed: () => createdMatrixService.wakeOutbox(),
      leadership: createConsultationLeadership(pool),
      bindingHash: createHash("sha256").update(JSON.stringify([
        environment.MATRIX_HOMESERVER_URL, environment.MATRIX_ROOM_ID, environment.MATRIX_OWNER_MXID
      ])).digest("hex"),
      assertReady: () => createdMatrixService.assertReadyForNewSession(),
      ...(mediaStore === undefined ? {} : { media: createConsultationMediaAdapter(mediaStore) }), now
    });

  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopping = false;
  const configured = settings.configured && createdMatrixService.configured;

  const start = (): Promise<void> => {
    if (stopping || !createdMatrixService.configured) return Promise.resolve();
    startPromise ??= (async () => {
      await createdMatrixService.start();
      await consultationService?.start();
    })().catch(() => undefined);
    return startPromise;
  };

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      stopping = true;
      const deadline = Date.now() + shutdownTimeoutMs;
      // Stop intake/background publication first, provider-owned processes
      // second, and the one shared database pool last. A failed/timed-out
      // predecessor prevents later teardown from racing a live state user.
      await completeBeforeDeadline(async () => { await consultationService?.stop(); }, deadline, "consultation shutdown");
      await completeBeforeDeadline(() => createdMatrixService.stop(), deadline, "Matrix shutdown");
      await completeBeforeDeadline(() => settings.close(), deadline, "provider shutdown");
      mediaStore?.close();
      await completeBeforeDeadline(() => pool.end(), deadline, "database shutdown");
    })();
    return stopPromise;
  };

  return Object.freeze({
    configured,
    settings,
    registrarRuntime,
    matrixService: createdMatrixService,
    ...(consultationService === undefined ? {} : { consultationService }),
    async runConsilium(request: GoDaddyConsiliumRequest): Promise<GoDaddyConsiliumResult> {
      if (stopping || settings.consilium === undefined) return { ok: false, code: "runtime_unavailable" };
      // The internal dispatcher cannot bypass E2EE/storage/media readiness.
      try { createdMatrixService.assertReadyForNewSession(); }
      catch { return { ok: false, code: "runtime_unavailable" }; }
      return settings.consilium.run(request);
    },
    start,
    stop
  });
}
