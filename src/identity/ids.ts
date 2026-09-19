/** Stable IDs that cross product boundaries; provider IDs never enter ledgers verbatim. */
export const isAgentId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_-]{2,63}$/.test(value);

export const isInternalEventId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(value);

export const isSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export const isExternalRuntimeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);

export async function deriveInternalEventId(
  namespace: "codex" | "claude",
  externalRuntimeId: string
): Promise<string | undefined> {
  if (!isExternalRuntimeId(externalRuntimeId)) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${namespace}\n${externalRuntimeId}`));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `pc-${namespace}-${hash}`;
}
