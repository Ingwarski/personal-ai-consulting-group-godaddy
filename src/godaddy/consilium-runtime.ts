import { ConsiliumSessionLauncher, executePreparedConsilium, type ConsiliumRole, type PreparedConsiliumExecutionResult } from "../consilium/session-launcher.ts";
import { parseHistoricalOwnerSettings } from "../settings/schema.ts";
import type { GoDaddyRegistrarRuntime } from "./registrar-runtime.ts";
import type { RuntimeBootstrap } from "./runtime-bootstrap.ts";

export type GoDaddyConsiliumRequest = Readonly<{
  sessionGeneration: number;
  task: string;
  head: ConsiliumRole;
  specialists: readonly ConsiliumRole[];
  critic: ConsiliumRole;
  signal?: AbortSignal;
}>;
export type GoDaddyConsiliumResult = PreparedConsiliumExecutionResult | Readonly<{
  ok: false;
  code: "runtime_unavailable" | "session_unavailable" | "session_busy" | "invalid_task" | "catalog_unavailable" | "prepare_failed" | "speed_policy_unresolved";
}>;

/** Internal execution boundary, not a new HTTP entry point. The authorized
 * dispatcher supplies task/roles; the immutable snapshot comes ONLY from the
 * shared production Registrar, never from the request or current Settings.
 * Broader Matrix intake/media/consent gates remain the caller's responsibility.
 */
export function createGoDaddyConsiliumRuntime(input: Readonly<{
  bootstrap: RuntimeBootstrap;
  registrarRuntime: GoDaddyRegistrarRuntime;
  environment: Record<string, unknown>;
  now: () => Date;
}>) {
  const running = new Map<number, Readonly<{ abort: AbortController; completion: Promise<GoDaddyConsiliumResult> }>>();
  let closing = false;

  const execute = async (request: GoDaddyConsiliumRequest, signal: AbortSignal): Promise<GoDaddyConsiliumResult> => {
    if (signal.aborted) return { ok: false, code: "runtime_unavailable" };
    const session = await input.registrarRuntime.registrar.getActiveSession();
    if (session === undefined || session.generation !== request.sessionGeneration || session.phase !== "active") return { ok: false, code: "session_unavailable" };
    const parsedSettings = parseHistoricalOwnerSettings(session.settingsSnapshot.settings);
    if (!parsedSettings.ok) return { ok: false, code: "session_unavailable" };
    const snapshot = Object.freeze({ ...session.settingsSnapshot, settings: parsedSettings.value });
    const policy = snapshot.speedPolicy;
    // Do not spend subscription turns and then discover an unapproved policy.
    if (policy.concurrency.status !== "resolved" || policy.critiqueRevisionCycles.status !== "resolved" ||
      policy.maxOptionalSpecialists.status !== "resolved" || policy.internalBudgetMilliseconds.status !== "resolved") return { ok: false, code: "speed_policy_unresolved" };
    const budget = policy.internalBudgetMilliseconds.value;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 2_147_483_647) return { ok: false, code: "speed_policy_unresolved" };
    signal = AbortSignal.any([signal, AbortSignal.timeout(budget)]);
    const receipt = await input.bootstrap.loadCatalog();
    if (receipt === undefined) return { ok: false, code: "catalog_unavailable" };
    const codex = await input.bootstrap.getCodexThreadClient?.();
    if (codex === undefined) return { ok: false, code: "runtime_unavailable" };
    const claude = snapshot.settings.critic.provider === "claude_code" ? input.bootstrap.getClaudeProcess?.() : undefined;
    const launcher = new ConsiliumSessionLauncher({
      registrar: input.registrarRuntime.registrar, codex,
      ...(claude === undefined ? {} : { claude }),
      environment: input.environment, privateSingleOwner: true, now: input.now,
      afterConfirmed: input.registrarRuntime.afterConfirmed
    });
    const prepared = await launcher.prepare({ snapshot, capabilityReceipt: receipt,
      head: request.head, specialists: request.specialists, critic: request.critic, signal });
    if (!prepared.ok) return { ok: false, code: "prepare_failed" };
    return executePreparedConsilium({ prepared: prepared.value, sessionGeneration: session.generation, task: request.task, signal });
  };

  return Object.freeze({
    run(request: GoDaddyConsiliumRequest): Promise<GoDaddyConsiliumResult> {
      if (closing) return Promise.resolve({ ok: false, code: "runtime_unavailable" });
      if (!Number.isSafeInteger(request.sessionGeneration) || request.sessionGeneration < 1 ||
        typeof request.task !== "string" || request.task.trim().length === 0 || Buffer.byteLength(request.task, "utf8") > 32_000) return Promise.resolve({ ok: false, code: "invalid_task" });
      if (running.has(request.sessionGeneration)) return Promise.resolve({ ok: false, code: "session_busy" });
      const abort = new AbortController();
      const cancel = (): void => abort.abort();
      request.signal?.addEventListener("abort", cancel, { once: true });
      if (request.signal?.aborted) cancel();
      const completion = execute(request, abort.signal).catch((): GoDaddyConsiliumResult => ({ ok: false, code: "runtime_unavailable" })).finally(() => {
        request.signal?.removeEventListener("abort", cancel);
        running.delete(request.sessionGeneration);
      });
      running.set(request.sessionGeneration, { abort, completion });
      return completion;
    },
    async close(): Promise<void> {
      closing = true;
      for (const run of running.values()) run.abort.abort();
      await Promise.all([...running.values()].map(run => run.completion));
    }
  });
}

export type GoDaddyConsiliumRuntime = ReturnType<typeof createGoDaddyConsiliumRuntime>;
