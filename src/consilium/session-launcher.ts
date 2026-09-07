import { ClaudeCodeCriticRuntime, type ClaudeCodeSubscriptionProcess } from "../runtime/claude-code-critic.ts";
import { CodexConsiliumAgentRuntime, CodexCriticRuntime, CodexHeadThreadRuntime } from "../runtime/codex-consilium-agent.ts";
import { CodexHeadSynthesizer } from "../runtime/codex-head-synthesizer.ts";
import { CodexAppServerThreadClient, type CodexThreadLease } from "../runtime/codex-thread-client.ts";
import { preflightSessionSubscriptions, type SessionSubscriptionPreflightFailureCode } from "../runtime/session-preflight.ts";
import type { CapabilityReceipt, EffectiveSessionSnapshot } from "../settings/types.ts";
import type { RegistrarDO } from "../session/registrar-do.ts";
import { ConsiliumRouter } from "./router.ts";
import { ConsensusRouter } from "./consensus-router.ts";
import type { SpecialistAssignment } from "./consultant-roles.ts";
import { CriticGatedFinalizer } from "./final-recommendation.ts";
import type { FinalRecommendationResult } from "./final-recommendation.ts";
import type { ConfirmedMessageObserver } from "./a2a.ts";
import type { ConsiliumFailureCause } from "./failures.ts";
import { validateConsiliumRoster, type AgentRegistration } from "./roster.ts";
import { isAgentId } from "../identity/ids.ts";
import { parseHistoricalOwnerSettings } from "../settings/schema.ts";

export type ConsiliumRole = Readonly<{ agentId: string; role: string }>;

export type PreparedConsilium = Readonly<{
  head: Readonly<{ registration: AgentRegistration; lease: CodexThreadLease }>;
  specialists: readonly AgentRegistration[];
  critic: AgentRegistration;
  router: ConsiliumRouter;
  consensusRouter: ConsensusRouter;
  synthesizer: CodexHeadSynthesizer;
  finalizer: CriticGatedFinalizer;
  cleanup: () => Promise<void>;
}>;

export type SessionLaunchResult =
  | Readonly<{ ok: true; value: PreparedConsilium }>
  | Readonly<{
      ok: false;
      code: "invalid_roles" | "preflight_failed" | "codex_thread_start_failed" | "cancelled";
      preflightCode?: SessionSubscriptionPreflightFailureCode;
    }>;

export type PreparedConsiliumExecutionResult =
  | Readonly<{ ok: true; final: FinalRecommendationResult & Readonly<{ ok: true }>; outcome?: "consensus" | "unresolved" | "safety_handoff" }>
  | Readonly<{
      ok: false;
      code: "consilium_route_failed" | "head_synthesis_failed" | "finalization_failed";
      cause?: ConsiliumFailureCause;
      ledgerCode?: string;
      retryAt?: string;
    }>;

function validRoles(head: ConsiliumRole, specialists: readonly ConsiliumRole[], critic: ConsiliumRole): boolean {
  const roles = [head, ...specialists, critic];
  return specialists.length >= 2 && specialists.length <= 5 &&
    new Set(roles.map((role) => role.agentId)).size === roles.length &&
    roles.every((role) => isAgentId(role.agentId) && role.role.trim().length > 0 && role.role.length <= 160);
}

/**
 * Creates the actual contexts before any A2A envelope can be routed. The
 * launcher has no provider credentials: it consumes only safe process adapters
 * and the already-frozen session snapshot.
 */
export class ConsiliumSessionLauncher {
  readonly #registrar: RegistrarDO;
  readonly #codex: CodexAppServerThreadClient;
  readonly #claude: ClaudeCodeSubscriptionProcess | undefined;
  readonly #environment: Record<string, unknown>;
  readonly #privateSingleOwner: boolean;
  readonly #now: () => Date;
  readonly #afterConfirmed: ConfirmedMessageObserver | undefined;

  constructor(input: Readonly<{
    registrar: RegistrarDO;
    codex: CodexAppServerThreadClient;
    claude?: ClaudeCodeSubscriptionProcess;
    environment: Record<string, unknown>;
    privateSingleOwner: boolean;
    now: () => Date;
    afterConfirmed?: ConfirmedMessageObserver;
  }>) {
    this.#registrar = input.registrar;
    this.#codex = input.codex;
    this.#claude = input.claude;
    this.#environment = input.environment;
    this.#privateSingleOwner = input.privateSingleOwner;
    this.#now = input.now;
    this.#afterConfirmed = input.afterConfirmed;
  }

  async prepare(input: Readonly<{
    snapshot: EffectiveSessionSnapshot;
    capabilityReceipt: CapabilityReceipt;
    head: ConsiliumRole;
    specialists: readonly ConsiliumRole[];
    critic: ConsiliumRole;
    signal?: AbortSignal;
  }>): Promise<SessionLaunchResult> {
    const compatible = parseHistoricalOwnerSettings(input.snapshot.settings);
    if (!compatible.ok) return { ok: false, code: "preflight_failed", preflightCode: "settings_incompatible" };
    // Read-only projection; never rewrite an already-frozen historic snapshot.
    const snapshot = { ...input.snapshot, settings: compatible.value };
    if (!validRoles(input.head, input.specialists, input.critic)) return { ok: false, code: "invalid_roles" };
    if (input.signal?.aborted) return { ok: false, code: "cancelled" };
    const preflight = await preflightSessionSubscriptions({
      environment: this.#environment,
      snapshot: snapshot,
      capabilityReceipt: input.capabilityReceipt,
      codexTransport: this.#codex.transport,
      ...(this.#claude === undefined ? {} : { claudeProcess: this.#claude }),
      privateSingleOwner: this.#privateSingleOwner,
      now: this.#now()
    });
    if (!preflight.ok) return { ok: false, code: "preflight_failed", preflightCode: preflight.code };
    const selectedCodex = preflight.codex.models.find((model) => model.productId === snapshot.settings.codex.modelId);
    if (selectedCodex === undefined) return { ok: false, code: "preflight_failed", preflightCode: "codex_model_not_available" };
    const selectedCritic = snapshot.settings.critic;
    const criticCodex = selectedCritic.codex === null ? undefined : preflight.codex.models.find((model) => model.productId === selectedCritic.codex!.modelId);
    if (selectedCritic.provider === "codex" && criticCodex === undefined) return { ok: false, code: "preflight_failed", preflightCode: "codex_model_not_available" };
    const leases: CodexThreadLease[] = [];
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      controller.abort();
      input.signal?.removeEventListener("abort", abort);
      return cleanupPromise ??= Promise.all(leases.map((lease) => this.#codex.releaseThread(lease))).then(() => undefined);
    };
    let preparedSuccessfully = false;
    try {
      if (input.signal?.aborted) return { ok: false, code: "cancelled" };
      const headLease = await this.#codex.startIsolatedThread({ modelId: selectedCodex.runtimeModelId });
      if (!headLease.ok) return { ok: false, code: "codex_thread_start_failed" };
      leases.push(headLease.value);
      const specialistLeases: CodexThreadLease[] = [];
      for (const specialist of input.specialists) {
        if (controller.signal.aborted) return { ok: false, code: "cancelled" };
        const lease = await this.#codex.startIsolatedThread({ modelId: selectedCodex.runtimeModelId });
        if (!lease.ok) return { ok: false, code: "codex_thread_start_failed" };
        specialistLeases.push(lease.value);
        leases.push(lease.value);
      }
      if (controller.signal.aborted) return { ok: false, code: "cancelled" };
      let criticLease: CodexThreadLease | undefined;
      if (selectedCritic.provider === "codex") {
        const lease = await this.#codex.startIsolatedThread({ modelId: criticCodex!.runtimeModelId });
        if (!lease.ok) return { ok: false, code: "codex_thread_start_failed" };
        criticLease = lease.value;
        leases.push(lease.value);
      }
      if (controller.signal.aborted) return { ok: false, code: "cancelled" };

      const head: AgentRegistration = Object.freeze({ ...input.head, provider: "codex", runtimeSessionRef: headLease.value.threadId });
      const specialists = Object.freeze(input.specialists.map((specialist, index) => Object.freeze({
        ...specialist,
        provider: "codex" as const,
        runtimeSessionRef: specialistLeases[index]!.threadId
      })));
      const critic: AgentRegistration = Object.freeze({
        ...input.critic,
        provider: selectedCritic.provider,
        runtimeSessionRef: criticLease?.threadId ?? (preflight.critic.provider === "claude_code" ? preflight.critic.status.processRef : "")
      });
      const roster = validateConsiliumRoster(specialists, critic);
      if (!roster.ok) return { ok: false, code: "invalid_roles" };

      const runtimes = Object.freeze([
        new CodexHeadThreadRuntime({ registration: head, lease: headLease.value, threadClient: this.#codex,
          reasoningEffort: snapshot.settings.codex.reasoningEffort, signal: controller.signal }),
        ...specialists.map((registration, index) => new CodexConsiliumAgentRuntime({
          registration,
          lease: specialistLeases[index]!,
          threadClient: this.#codex,
          criticAgentId: critic.agentId,
          headAgentId: head.agentId,
          reasoningEffort: snapshot.settings.codex.reasoningEffort,
          signal: controller.signal
        })),
        ...(selectedCritic.provider === "codex" ? [new CodexCriticRuntime({
          registration: critic,
          lease: criticLease!,
          threadClient: this.#codex,
          headAgentId: head.agentId,
          reasoningEffort: selectedCritic.codex!.reasoningEffort,
          signal: controller.signal
        })] : [new ClaudeCodeCriticRuntime({
          registration: critic,
          process: this.#claude!,
          headAgentId: head.agentId,
          modelId: selectedCritic.claude!.modelId,
          reasoningEffort: selectedCritic.claude!.reasoningEffort,
          signal: controller.signal
        })])
      ]);
      const prepared = Object.freeze({
        head: Object.freeze({ registration: head, lease: headLease.value }),
        specialists,
        critic,
        cleanup,
        consensusRouter: new ConsensusRouter({
          registrar: this.#registrar, ledger: this.#registrar, head, specialists, critic, runtimes,
          stopRuntimes: abort,
          ...(this.#afterConfirmed === undefined ? {} : { afterConfirmed: this.#afterConfirmed })
        }),
        router: new ConsiliumRouter({
          registrar: this.#registrar,
          head,
          specialists,
          critic,
          runtimes,
          ...(this.#afterConfirmed === undefined ? {} : { afterConfirmed: this.#afterConfirmed })
        }),
        synthesizer: new CodexHeadSynthesizer({
          registrar: this.#registrar,
          head,
          critic,
          lease: headLease.value,
          threadClient: this.#codex,
          reasoningEffort: snapshot.settings.codex.reasoningEffort,
          signal: controller.signal
        }),
        finalizer: new CriticGatedFinalizer({
          registrar: this.#registrar,
          head,
          critic,
          ...(this.#afterConfirmed === undefined ? {} : { afterConfirmed: this.#afterConfirmed })
        })
      });
      preparedSuccessfully = true;
      return { ok: true, value: prepared };
    } catch {
      return { ok: false, code: "codex_thread_start_failed" };
    } finally {
      if (!preparedSuccessfully) await cleanup();
    }
  }
}

/** Runs the complete local orchestration path after `prepare` has fenced it. */
export async function executePreparedConsilium(input: Readonly<{
  prepared: PreparedConsilium;
  sessionGeneration: number;
  task: string;
  taskId?: string;
  taskDigest?: string;
  language?: string;
  assignments?: readonly SpecialistAssignment[];
  signal?: AbortSignal;
}>): Promise<PreparedConsiliumExecutionResult> {
  const cancel = (): void => { void input.prepared.cleanup(); };
  input.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (input.signal?.aborted) return { ok: false, code: "consilium_route_failed", cause: "codex_turn_cancelled" };
    if (input.taskId !== undefined || input.taskDigest !== undefined || input.language !== undefined || input.assignments !== undefined) {
      if (input.taskId === undefined || input.language === undefined || input.assignments === undefined) {
        return { ok: false, code: "consilium_route_failed", cause: "invalid_runtime_emission" };
      }
      const result = await input.prepared.consensusRouter.run({ sessionGeneration: input.sessionGeneration,
        taskId: input.taskId, task: input.task, language: input.language, assignments: input.assignments,
        ...(input.taskDigest === undefined ? {} : { taskDigest: input.taskDigest }),
        ...(input.signal === undefined ? {} : { signal: input.signal }) });
      return result.ok ? { ok: true, outcome: result.outcome, final: { ok: true, visibleSequence: result.visibleSequence, replayed: result.replayed } } :
        { ok: false, code: "consilium_route_failed", cause: result.cause,
          ...(result.ledgerCode === undefined ? {} : { ledgerCode: result.ledgerCode }),
          ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }) };
    }
    const routed = await input.prepared.router.run({ sessionGeneration: input.sessionGeneration, task: input.task });
    if (!routed.ok) return {
      ok: false,
      code: "consilium_route_failed",
      cause: routed.cause,
      ...(routed.retryAt === undefined ? {} : { retryAt: routed.retryAt })
    };
    const synthesized = await input.prepared.synthesizer.synthesize({ sessionGeneration: input.sessionGeneration, task: input.task });
    if (!synthesized.ok) return { ok: false, code: "head_synthesis_failed" };
    const finalized = await input.prepared.finalizer.publish({
      sessionGeneration: input.sessionGeneration,
      messageId: synthesized.messageId,
      recommendation: synthesized.recommendation
    });
    return finalized.ok ? { ok: true, final: finalized } : { ok: false, code: "finalization_failed" };
  } finally {
    input.signal?.removeEventListener("abort", cancel);
    await input.prepared.cleanup();
  }
}
