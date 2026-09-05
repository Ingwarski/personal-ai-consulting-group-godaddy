import { createActiveSessionSummaryProvider } from "../session/active-settings-summary.ts";
import { RegistrarDO } from "../session/registrar-do.ts";
import type { ConfirmedAgentMessage } from "../session/registrar-do.ts";
import type { MySqlPool } from "./mysql-storage.ts";
import { MySqlMatrixPublicationSynchronizer } from "./mysql-matrix-publication-synchronizer.ts";
import type { MatrixPublicationSynchronizer } from "./matrix-service.ts";
import {
  MySqlAtomicRegistrarStorage,
  MySqlMatrixIngressReceipts,
  MySqlMatrixOutbox,
  fenceMySqlOutboxGeneration,
  projectConfirmedMessageToMySqlOutbox
} from "./mysql-matrix-outbox.ts";

export const GODADDY_REGISTRAR_NAMESPACE = "registrar-v1";

export type GoDaddyRegistrarRuntime = Readonly<{
  registrar: RegistrarDO;
  matrixOutbox: MySqlMatrixOutbox;
  matrixIngressReceipts: MySqlMatrixIngressReceipts;
  matrixPublicationSynchronizer: MatrixPublicationSynchronizer;
  afterConfirmed: (message: ConfirmedAgentMessage) => Promise<void>;
  getActiveSessionSummary: () => ReturnType<ReturnType<typeof createActiveSessionSummaryProvider>>;
}>;

/**
 * Keeps the existing Registrar domain as the single mutable session authority
 * while swapping only its durable-object storage adapter. No HTTP route or
 * Matrix client is exposed here: those require their own E2EE/runtime proof.
 */
export function createGoDaddyRegistrarRuntime(input: Readonly<{
  pool: MySqlPool;
  now: () => Date;
  wakeMatrixOutbox?: () => void | Promise<void>;
  matrixPublicationSynchronizer?: MatrixPublicationSynchronizer;
}>): GoDaddyRegistrarRuntime {
  const matrixPublicationSynchronizer = input.matrixPublicationSynchronizer
    ?? new MySqlMatrixPublicationSynchronizer(input.pool);
  const registrar = new RegistrarDO({
    storage: new MySqlAtomicRegistrarStorage({ executor: input.pool, namespace: GODADDY_REGISTRAR_NAMESPACE }),
    now: input.now,
    projectConfirmedMessage: projectConfirmedMessageToMySqlOutbox,
    fenceGeneration: (storage, fenceInput) => matrixPublicationSynchronizer.withGenerationFence(
      { generation: fenceInput.generation },
      () => fenceMySqlOutboxGeneration(storage, fenceInput)
    )
  });
  return Object.freeze({
    registrar,
    matrixOutbox: new MySqlMatrixOutbox(input.pool),
    matrixIngressReceipts: new MySqlMatrixIngressReceipts(input.pool),
    matrixPublicationSynchronizer,
    // The message was already projected transactionally. Observers may wake a
    // drain loop, but must never publish the supplied body directly.
    afterConfirmed: async (_message) => { await input.wakeMatrixOutbox?.(); },
    getActiveSessionSummary: createActiveSessionSummaryProvider(registrar)
  });
}
