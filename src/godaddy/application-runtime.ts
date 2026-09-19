import type { GoDaddyConsiliumRequest, GoDaddyConsiliumResult } from "./consilium-runtime.ts";
import { fileURLToPath } from "node:url";
import { ArchiveService } from "../archive/archive-service.ts";
import { createArchiveCloseGate } from "../archive/close-gate.ts";
import { importArchiveEncryptionKey } from "../archive/key.ts";
import { createInstructionDocumentService } from "../instructions/documents.ts";
import { parseRuntimeEnvironment } from "../runtime/environment.ts";
import { createBrowserConsultationService, type BrowserConsultationService } from "./browser-consultation-service.ts";
import { createConsultationLeadership } from "./consultation-leadership.ts";
import { MySqlArchiveStorage } from "./mysql-archive-storage.ts";
import { createGodaddyMySqlPool, type CloseableMySqlPool } from "./mysql-pool.ts";
import { MySqlKeyValueStorage, parseGodaddyDatabaseConfiguration, type GodaddyDatabaseConfiguration } from "./mysql-storage.ts";
import { createGoDaddyRegistrarRuntime, type GoDaddyRegistrarRuntime } from "./registrar-runtime.ts";
import { createGoDaddySettingsRuntime, type GoDaddySettingsRuntime, type GoDaddySettingsRuntimeDependencies } from "./settings-runtime.ts";

export type GoDaddyApplicationRuntime = Readonly<{
  configured: boolean;
  settings: GoDaddySettingsRuntime;
  registrarRuntime?: GoDaddyRegistrarRuntime;
  consultationService: BrowserConsultationService | undefined;
  runConsilium?: (request: GoDaddyConsiliumRequest) => Promise<GoDaddyConsiliumResult>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}>;

export type GoDaddyApplicationRuntimeDependencies = Readonly<{
  createPool?: (configuration: GodaddyDatabaseConfiguration) => CloseableMySqlPool;
  createRegistrarRuntime?: typeof createGoDaddyRegistrarRuntime;
  createSettingsRuntime?: (environment: Record<string, unknown>, dependencies: GoDaddySettingsRuntimeDependencies) => GoDaddySettingsRuntime;
  createConsultationService?: typeof createBrowserConsultationService;
  now?: () => Date;
  shutdownTimeoutMs?: number;
}>;

async function completeBeforeDeadline(operation: () => Promise<void>, deadlineMs: number, operationName: string): Promise<void> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new Error(`Application shutdown deadline elapsed before ${operationName}.`);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`Application shutdown timed out during ${operationName}.`)), remaining); })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

const plausibleKey = (value: unknown): value is string => typeof value === "string" &&
  (/^[a-f0-9]{64}$/iu.test(value) || /^[A-Za-z0-9_-]{43,44}$/u.test(value));

/** Builds the current GoDaddy process composition root. Hosting extraction is a
 * separate migration; domain services remain independent of the HTTP host. */
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
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1_000 || shutdownTimeoutMs > 30_000) throw new Error("Invalid application shutdown timeout.");

  if (!runtime.ok || runtime.value.runtimeMode !== "production" || !database.ok) {
    const settings = createSettings(environment, { now });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({ configured: false, settings, consultationService: undefined, async start() {}, stop() { closePromise ??= settings.close().catch(() => undefined); return closePromise; } });
  }

  const pool = (dependencies.createPool ?? createGodaddyMySqlPool)(database.value);
  const registrarRuntime = (dependencies.createRegistrarRuntime ?? createGoDaddyRegistrarRuntime)({ pool, now });
  const archiveService = new ArchiveService({ storage: new MySqlArchiveStorage(pool), now });
  const instructionService = createInstructionDocumentService({
    pool,
    rootSecret: environment.RUNTIME_INSTRUCTION_ENCRYPTION_KEY,
    repositoryRoot: fileURLToPath(new URL("../../", import.meta.url)),
    now
  });
  let archiveKey: CryptoKey | undefined;
  let consultationService: BrowserConsultationService | undefined;
  const beforeConsultationClose = async (value: Parameters<ReturnType<typeof createArchiveCloseGate>>[0]): Promise<void> => {
    if (archiveKey === undefined) throw new Error("Archive key is unavailable.");
    await createArchiveCloseGate({ archiveService, key: archiveKey })(value);
  };
  const settings = createSettings(environment, {
    pool, registrarRuntime, now, archiveService,
    ...(instructionService === undefined ? {} : { instructionService }),
    beforeConsultationClose,
    getArchiveKey: () => archiveKey,
    getConsultationService: () => consultationService
  });
  const keyMaterials = [environment.ARCHIVE_ENCRYPTION_KEY, environment.RUNTIME_INSTRUCTION_ENCRYPTION_KEY,
    environment.RUNTIME_CREDENTIAL_ENCRYPTION_KEY];
  const configured = settings.configured && instructionService !== undefined && keyMaterials.every(plausibleKey) &&
    new Set(keyMaterials).size === keyMaterials.length;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopping = false;

  const start = (): Promise<void> => {
    if (stopping || !configured) return Promise.resolve();
    startPromise ??= (async () => {
      archiveKey = await importArchiveEncryptionKey(environment.ARCHIVE_ENCRYPTION_KEY);
      if (archiveKey === undefined || instructionService === undefined || settings.consilium === undefined || settings.prepareConsultationSnapshot === undefined) {
        throw new Error("Application encryption or consultation runtime is unavailable.");
      }
      await instructionService.initialize();
      consultationService = (dependencies.createConsultationService ?? createBrowserConsultationService)({
        storage: new MySqlKeyValueStorage({ executor: pool, namespace: "browser-consultation-v1" }),
        registrarRuntime,
        executor: settings.consilium,
        prepareSnapshot: settings.prepareConsultationSnapshot,
        archiveService,
        archiveKey,
        archiveBeforeClose: beforeConsultationClose,
        leadership: createConsultationLeadership(pool, database.value.database),
        now
      });
      await consultationService.start();
    })();
    return startPromise;
  };

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      stopping = true;
      const deadline = Date.now() + shutdownTimeoutMs;
      await completeBeforeDeadline(async () => { await consultationService?.close(); }, deadline, "consultation shutdown");
      await completeBeforeDeadline(() => settings.close(), deadline, "provider shutdown");
      await completeBeforeDeadline(() => pool.end(), deadline, "database shutdown");
      archiveKey = undefined;
    })();
    return stopPromise;
  };

  return Object.freeze({
    configured,
    settings,
    registrarRuntime,
    get consultationService() { return consultationService; },
    async runConsilium(request: GoDaddyConsiliumRequest): Promise<GoDaddyConsiliumResult> {
      if (stopping || settings.consilium === undefined || archiveKey === undefined) return { ok: false, code: "runtime_unavailable" };
      return settings.consilium.run(request);
    },
    start,
    stop
  });
}
