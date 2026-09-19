import type { SessionCloseObserver } from "../consilium/final-recommendation.ts";
import { ArchiveService } from "./archive-service.ts";

/**
 * Binds an application-managed AES-GCM key to the finalization barrier. The
 * key itself is never serialized, logged or passed through Browser/A2A.
 */
export function createArchiveCloseGate(input: Readonly<{
  archiveService: ArchiveService;
  key: CryptoKey;
}>): SessionCloseObserver {
  return async ({ session, messages }) => {
    const sealed = await input.archiveService.seal({ session, messages, key: input.key });
    if (!sealed.ok) throw new Error(`archive seal rejected: ${sealed.code}`);
  };
}
