import type { ActiveSessionSummary } from "../settings/owner-settings-do.ts";
import type { RegistrarDO } from "./registrar-do.ts";

/** Adapts Registrar state to the content-free summary allowed on Settings. */
export function createActiveSessionSummaryProvider(
  registrar: Pick<RegistrarDO, "getActiveSession">
): () => Promise<ActiveSessionSummary | null> {
  return async () => {
    const session = await registrar.getActiveSession();
    if (session === undefined || session.phase !== "active") return null;
    return Object.freeze({
      settingsRevision: session.settingsSnapshot.settingsRevision,
      catalogVersion: session.settingsSnapshot.catalogVersion,
      startedAt: session.startedAt,
      effectiveSettings: Object.freeze({ ...session.settingsSnapshot.settings })
    });
  };
}
