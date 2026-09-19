import { createActiveSessionSummaryProvider } from "../session/active-settings-summary.ts";
import { RegistrarDO } from "../session/registrar-do.ts";
import type { ConfirmedAgentMessage } from "../session/registrar-do.ts";
import { MySqlKeyValueStorage, type MySqlPool } from "./mysql-storage.ts";

export const GODADDY_REGISTRAR_NAMESPACE = "registrar-v2";

export type GoDaddyRegistrarRuntime = Readonly<{
  registrar: RegistrarDO;
  afterConfirmed: (message: ConfirmedAgentMessage) => Promise<void>;
  getActiveSessionSummary: () => ReturnType<ReturnType<typeof createActiveSessionSummaryProvider>>;
}>;

/** Persistent session authority shared by browser consultation and Settings. */
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
    afterConfirmed: async (_message) => undefined,
    getActiveSessionSummary: createActiveSessionSummaryProvider(registrar)
  });
}
