import { ConsiliumSessionLauncher, executePreparedConsilium, type ConsiliumRole, type PreparedConsiliumExecutionResult } from "../consilium/session-launcher.ts";
import { parseHistoricalOwnerSettings } from "../settings/schema.ts";
import { planConsultation, type ConsultationIntakeResult } from "../runtime/consultation-intake.ts";
import type { CodexTurnImage } from "../runtime/codex-thread-client.ts";
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
export type GoDaddyConsultationPlanRequest = Pick<GoDaddyConsiliumRequest, "sessionGeneration" | "task" | "signal"> & Readonly<{ images?: readonly CodexTurnImage[] }>;
export type GoDaddyConsultationPlanResult = ConsultationIntakeResult | Exclude<GoDaddyConsiliumResult, { ok: true }>;

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
  const running = new Map<number, Readonly<{ abort: AbortController; completion: Promise<GoDaddyConsiliumResult | GoDaddyConsultationPlanResult> }>>();
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
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 540_000 ||
      !Number.isSafeInteger(policy.maxOptionalSpecialists.value) || policy.maxOptionalSpecialists.value < 0 || policy.maxOptionalSpecialists.value > 3 ||
      !Number.isSafeInteger(policy.concurrency.value) || policy.concurrency.value < 1 || policy.concurrency.value > 5 ||
      policy.critiqueRevisionCycles.value !== 1 || policy.paidAcceleration !== "forbidden" ||
      Object.values(policy.invariants).some(value => value !== true) ||
      request.specialists.length < 2 || request.specialists.length > 2 + policy.maxOptionalSpecialists.value) return { ok: false, code: "speed_policy_unresolved" };
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

  const plan = async (request: GoDaddyConsultationPlanRequest, signal: AbortSignal): Promise<GoDaddyConsultationPlanResult> => {
    if (signal.aborted) return { ok: false, code: "runtime_unavailable" };
    const session = await input.registrarRuntime.registrar.getActiveSession();
    if (session === undefined || session.generation !== request.sessionGeneration || session.phase !== "active") return { ok: false, code: "session_unavailable" };
    const settings = parseHistoricalOwnerSettings(session.settingsSnapshot.settings);
    if (!settings.ok) return { ok: false, code: "session_unavailable" };
    const snapshot = Object.freeze({ ...session.settingsSnapshot, settings: settings.value });
    const policy = snapshot.speedPolicy;
    if (policy.maxOptionalSpecialists.status !== "resolved" || policy.internalBudgetMilliseconds.status !== "resolved" ||
      policy.concurrency.status !== "resolved" || policy.critiqueRevisionCycles.status !== "resolved" ||
      !Number.isSafeInteger(policy.maxOptionalSpecialists.value) || policy.maxOptionalSpecialists.value < 0 || policy.maxOptionalSpecialists.value > 3 ||
      !Number.isSafeInteger(policy.internalBudgetMilliseconds.value) || policy.internalBudgetMilliseconds.value < 1 || policy.internalBudgetMilliseconds.value > 540_000 ||
      !Number.isSafeInteger(policy.concurrency.value) || policy.concurrency.value < 1 || policy.concurrency.value > 5 ||
      policy.critiqueRevisionCycles.value !== 1 || policy.paidAcceleration !== "forbidden" ||
      Object.values(policy.invariants).some(value => value !== true)) return { ok: false, code: "speed_policy_unresolved" };
    signal = AbortSignal.any([signal, AbortSignal.timeout(policy.internalBudgetMilliseconds.value)]);
    const receipt = await input.bootstrap.loadCatalog();
    if (receipt === undefined) return { ok: false, code: "catalog_unavailable" };
    const codex = await input.bootstrap.getCodexThreadClient?.();
    if (codex === undefined) return { ok: false, code: "runtime_unavailable" };
    return planConsultation({ task: request.task, snapshot, capabilityReceipt: receipt, codex,
      ...(request.images === undefined ? {} : { images: request.images }),
      environment: input.environment, now: input.now(), maximumSpecialists: 2 + policy.maxOptionalSpecialists.value, signal });
  };

  const launch = <T extends GoDaddyConsiliumResult | GoDaddyConsultationPlanResult>(request: GoDaddyConsultationPlanRequest,
    operation: (signal: AbortSignal) => Promise<T>): Promise<T | Exclude<GoDaddyConsiliumResult, { ok: true }>> => {
    if (closing) return Promise.resolve({ ok: false, code: "runtime_unavailable" });
    if (!Number.isSafeInteger(request.sessionGeneration) || request.sessionGeneration < 1 ||
      typeof request.task !== "string" || request.task.trim().length === 0 || Buffer.byteLength(request.task, "utf8") > 32_000) return Promise.resolve({ ok: false, code: "invalid_task" });
    if (running.has(request.sessionGeneration)) return Promise.resolve({ ok: false, code: "session_busy" });
    const abort = new AbortController();
    const cancel = (): void => abort.abort();
    request.signal?.addEventListener("abort", cancel, { once: true });
    if (request.signal?.aborted) cancel();
    const completion = operation(abort.signal).catch((): Exclude<GoDaddyConsiliumResult, { ok: true }> => ({ ok: false, code: "runtime_unavailable" })).finally(() => {
      request.signal?.removeEventListener("abort", cancel);
      running.delete(request.sessionGeneration);
    });
    running.set(request.sessionGeneration, { abort, completion });
    return completion;
  };

  return Object.freeze({
    run(request: GoDaddyConsiliumRequest): Promise<GoDaddyConsiliumResult> {
      return launch(request, signal => execute(request, signal));
    },
    plan(request: GoDaddyConsultationPlanRequest): Promise<GoDaddyConsultationPlanResult> {
      return launch(request, signal => plan(request, signal));
    },
    async close(): Promise<void> {
      closing = true;
      for (const run of running.values()) run.abort.abort();
      await Promise.all([...running.values()].map(run => run.completion));
    }
  });
}

export type GoDaddyConsiliumRuntime = ReturnType<typeof createGoDaddyConsiliumRuntime>;
