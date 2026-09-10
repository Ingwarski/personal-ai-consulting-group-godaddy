import { ConsiliumSessionLauncher, executePreparedConsilium, type ConsiliumRole, type PreparedConsiliumExecutionResult } from "../consilium/session-launcher.ts";
import { parseHistoricalOwnerSettings } from "../settings/schema.ts";
import { planConsultation, preflightCodexForSnapshot, type ConsultationIntakeResult } from "../runtime/consultation-intake.ts";
import { readResumableFinalization } from "../consilium/resumable-finalization.ts";
import { CodexHeadSynthesizer } from "../runtime/codex-head-synthesizer.ts";
import { CriticGatedFinalizer } from "../consilium/final-recommendation.ts";
import type { CodexTurnImage } from "../runtime/codex-thread-client.ts";
import type { GoDaddyRegistrarRuntime } from "./registrar-runtime.ts";
import type { RuntimeBootstrap } from "./runtime-bootstrap.ts";
import type { SpecialistAssignment } from "../consilium/consultant-roles.ts";
import { canonicalSessionLanguage } from "../consilium/language.ts";
import { isSessionId } from "../identity/ids.ts";
import { translateServiceMessages } from "../runtime/service-message-translator.ts";
import { extractContinuationImageEvidence } from "../runtime/consultation-image-evidence.ts";

export type GoDaddyConsiliumRequest = Readonly<{
  sessionGeneration: number;
  task: string;
  head: ConsiliumRole;
  specialists: readonly ConsiliumRole[];
  critic: ConsiliumRole;
  taskId?: string;
  taskDigest?: string;
  language?: string;
  assignments?: readonly SpecialistAssignment[];
  signal?: AbortSignal;
}>;
export type GoDaddyConsiliumResult = PreparedConsiliumExecutionResult | Readonly<{
  ok: false;
  code: "runtime_unavailable" | "session_unavailable" | "session_busy" | "invalid_task" | "catalog_unavailable" | "prepare_failed" | "speed_policy_unresolved";
  detail?: string;
}>;
export type GoDaddyConsultationPlanRequest = Pick<GoDaddyConsiliumRequest, "sessionGeneration" | "task" | "signal" | "language" | "taskId"> & Readonly<{ images?: readonly CodexTurnImage[] }>;
export type GoDaddyConsultationPlanResult = ConsultationIntakeResult | Exclude<GoDaddyConsiliumResult, { ok: true }>;
type ServiceTranslationResult = Awaited<ReturnType<typeof translateServiceMessages>>;
type RuntimeOperationResult = GoDaddyConsiliumResult | GoDaddyConsultationPlanResult | ServiceTranslationResult;

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
  const running = new Map<number, Readonly<{ abort: AbortController; completion: Promise<RuntimeOperationResult> }>>();
  let closing = false;

  const execute = async (request: GoDaddyConsiliumRequest, signal: AbortSignal): Promise<GoDaddyConsiliumResult> => {
    if (signal.aborted) return { ok: false, code: "runtime_unavailable" };
    const adaptive = request.taskId !== undefined || request.taskDigest !== undefined || request.language !== undefined || request.assignments !== undefined;
    if (adaptive && (!isSessionId(request.taskId) || canonicalSessionLanguage(request.language) !== request.language ||
      request.language === undefined || request.assignments === undefined)) return { ok: false, code: "invalid_task" };
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
    if (!prepared.ok) return { ok: false, code: "prepare_failed", detail: prepared.preflightCode ?? prepared.threadStartCode ?? prepared.code };
    return executePreparedConsilium({ prepared: prepared.value, sessionGeneration: session.generation, task: request.task, signal,
      ...(adaptive ? { taskId: request.taskId!, language: request.language!, assignments: request.assignments!,
        ...(request.taskDigest === undefined ? {} : { taskDigest: request.taskDigest }) } : {}) });
  };

  const plan = async (request: GoDaddyConsultationPlanRequest, signal: AbortSignal): Promise<GoDaddyConsultationPlanResult> => {
    if (signal.aborted) return { ok: false, code: "runtime_unavailable" };
    const session = await input.registrarRuntime.registrar.getActiveSession();
    if (session === undefined || session.generation !== request.sessionGeneration || session.phase !== "active") return { ok: false, code: "session_unavailable" };
    const boundTask = await input.registrarRuntime.registrar.getConsensusTask(session.generation);
    let retainedPlan: Extract<ConsultationIntakeResult, { kind: "consilium" }> | undefined;
    if (boundTask !== undefined) {
      if (request.taskId !== boundTask) return { ok: false, code: "invalid_task" };
      const previous = await input.registrarRuntime.registrar.getConsensus(boundTask);
      if (previous === undefined) return { ok: false, code: "session_unavailable" };
      // Continue reuses the durable task roster and individual assignments;
      // re-running intake must never reset counts by inventing a fresh task.
      retainedPlan = { ok: true, kind: "consilium", language: request.language ?? previous.language,
        head: previous.head, specialists: previous.specialists, critic: previous.critic,
        assignments: previous.assignments, extractedEvidence: "" };
      if (!request.images?.length) return retainedPlan;
    }
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
    if (retainedPlan !== undefined) {
      const extracted = await extractContinuationImageEvidence({ task: request.task, language: retainedPlan.language,
        images: request.images!, snapshot, capabilityReceipt: receipt, codex,
        environment: input.environment, now: input.now(), signal });
      return extracted.ok ? { ...retainedPlan, extractedEvidence: extracted.evidence } : extracted;
    }
    return planConsultation({ task: request.task, snapshot, capabilityReceipt: receipt, codex,
      ...(request.language === undefined ? {} : { language: request.language }),
      ...(request.images === undefined ? {} : { images: request.images }),
      environment: input.environment, now: input.now(), maximumSpecialists: 2 + policy.maxOptionalSpecialists.value, signal });
  };

  const launch = <T extends RuntimeOperationResult>(request: GoDaddyConsultationPlanRequest,
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
    translateServiceMessages(request: Readonly<{ sessionGeneration: number; language: string; signal?: AbortSignal }>) {
      // App-authored UI strings only. The worker invokes this after consent;
      // no owner task, image, history or document enters the translation turn.
      return launch({ ...request, task: "Translate application interface strings." }, async signal => {
        const session = await input.registrarRuntime.registrar.getActiveSession();
        if (session?.generation !== request.sessionGeneration || session.phase !== "active") return { ok: false as const, code: "session_unavailable" as const };
        const settings = parseHistoricalOwnerSettings(session.settingsSnapshot.settings);
        const receipt = await input.bootstrap.loadCatalog();
        const codex = await input.bootstrap.getCodexThreadClient?.();
        if (!settings.ok || receipt === undefined || codex === undefined) return { ok: false as const, code: "runtime_unavailable" as const };
        return translateServiceMessages({ language: request.language, snapshot: { ...session.settingsSnapshot, settings: settings.value },
          capabilityReceipt: receipt, codex, environment: input.environment, now: input.now(), signal });
      });
    },
    async canResumeFinalization(sessionGeneration: number): Promise<boolean> {
      return !closing && !running.has(sessionGeneration)
        && await readResumableFinalization(input.registrarRuntime.registrar, sessionGeneration) !== undefined;
    },
    resumeFinalization(request: GoDaddyConsultationPlanRequest): Promise<GoDaddyConsiliumResult> {
      return launch(request, async (signal): Promise<GoDaddyConsiliumResult> => {
        const registrar = input.registrarRuntime.registrar;
        const completed = await readResumableFinalization(registrar, request.sessionGeneration);
        const session = await registrar.getActiveSession();
        if (completed === undefined || session?.generation !== request.sessionGeneration || session.phase !== "active") return { ok: false, code: "session_unavailable" };
        const settings = parseHistoricalOwnerSettings(session.settingsSnapshot.settings);
        if (!settings.ok) return { ok: false, code: "session_unavailable" };
        const snapshot = { ...session.settingsSnapshot, settings: settings.value };
        const policy = snapshot.speedPolicy;
        if (policy.internalBudgetMilliseconds.status !== "resolved" || !Number.isSafeInteger(policy.internalBudgetMilliseconds.value) ||
          policy.internalBudgetMilliseconds.value < 1 || policy.internalBudgetMilliseconds.value > 540_000 ||
          policy.paidAcceleration !== "forbidden" || Object.values(policy.invariants).some(value => value !== true)) return { ok: false, code: "speed_policy_unresolved" };
        signal = AbortSignal.any([signal, AbortSignal.timeout(policy.internalBudgetMilliseconds.value)]);
        const receipt = await input.bootstrap.loadCatalog();
        const codex = await input.bootstrap.getCodexThreadClient?.();
        if (receipt === undefined || codex === undefined) return { ok: false, code: "runtime_unavailable" };
        const modelId = await preflightCodexForSnapshot({ snapshot, capabilityReceipt: receipt, codex,
          environment: input.environment, now: input.now(), signal });
        if (modelId === undefined) return { ok: false, code: "catalog_unavailable" };
        const started = await codex.startIsolatedThread({ modelId });
        if (!started.ok) return { ok: false, code: "prepare_failed" };
        try {
          const head = { ...completed.head, runtimeSessionRef: started.value.threadId };
          const synthesized = await new CodexHeadSynthesizer({ registrar, head, critic: completed.critic,
            lease: started.value, threadClient: codex, reasoningEffort: snapshot.settings.codex.reasoningEffort, signal
          }).synthesize({ sessionGeneration: request.sessionGeneration, task: request.task });
          if (!synthesized.ok || signal.aborted) return { ok: false, code: "head_synthesis_failed" };
          const finalized = await new CriticGatedFinalizer({ registrar, head, critic: completed.critic,
            afterConfirmed: input.registrarRuntime.afterConfirmed
          }).publish({ sessionGeneration: request.sessionGeneration, messageId: synthesized.messageId, recommendation: synthesized.recommendation });
          return finalized.ok ? { ok: true, final: finalized } : { ok: false, code: "finalization_failed" };
        } finally { await codex.releaseThread(started.value); }
      });
    },
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
