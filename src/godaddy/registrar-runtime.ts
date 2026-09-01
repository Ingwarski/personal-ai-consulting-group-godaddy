import { createActiveSessionSummaryProvider } from "../session/active-settings-summary.ts";
import { RegistrarDO } from "../session/registrar-do.ts";
import type { MySqlPool } from "./mysql-storage.ts";
import { MySqlKeyValueStorage } from "./mysql-storage.ts";

export const GODADDY_REGISTRAR_NAMESPACE = "registrar-v1";

export type GoDaddyRegistrarRuntime = Readonly<{
  registrar: RegistrarDO;
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
}>): GoDaddyRegistrarRuntime {
  const registrar = new RegistrarDO({
    storage: new MySqlKeyValueStorage({ executor: input.pool, namespace: GODADDY_REGISTRAR_NAMESPACE }),
    now: input.now
  });
  return Object.freeze({
    registrar,
    getActiveSessionSummary: createActiveSessionSummaryProvider(registrar)
  });
}
