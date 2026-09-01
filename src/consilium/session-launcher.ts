import { ClaudeCodeCriticRuntime, type ClaudeCodeSubscriptionProcess } from "../runtime/claude-code-critic.ts";
import { CodexConsiliumAgentRuntime, CodexHeadThreadRuntime } from "../runtime/codex-consilium-agent.ts";
import { CodexHeadSynthesizer } from "../runtime/codex-head-synthesizer.ts";
import { CodexAppServerThreadClient, type CodexThreadLease } from "../runtime/codex-thread-client.ts";
import { preflightSessionSubscriptions, type SessionSubscriptionPreflightFailureCode } from "../runtime/session-preflight.ts";
import type { CapabilityReceipt, EffectiveSessionSnapshot } from "../settings/types.ts";
import type { RegistrarDO } from "../session/registrar-do.ts";
import { ConsiliumRouter } from "./router.ts";
import { CriticGatedFinalizer } from "./final-recommendation.ts";
import type { FinalRecommendationResult } from "./final-recommendation.ts";
import type { ConfirmedMessageObserver } from "./a2a.ts";
import type { ConsiliumFailureCause } from "./failures.ts";
import { validateConsiliumRoster, type AgentRegistration } from "./roster.ts";
import { isAgentId } from "../identity/ids.ts";

export type ConsiliumRole = Readonly<{ agentId: string; role: string }>;

export type PreparedConsilium = Readonly<{
  head: Readonly<{ registration: AgentRegistration; lease: CodexThreadLease }>;
  specialists: readonly AgentRegistration[];
  critic: AgentRegistration;
  router: ConsiliumRouter;
  synthesizer: CodexHeadSynthesizer;
  finalizer: CriticGatedFinalizer;
}>;

export type SessionLaunchResult =
  | Readonly<{ ok: true; value: PreparedConsilium }>
  | Readonly<{
      ok: false;
      code: "invalid_roles" | "preflight_failed" | "codex_thread_start_failed";
      preflightCode?: SessionSubscriptionPreflightFailureCode;
    }>;

export type PreparedConsiliumExecutionResult =
  | Readonly<{ ok: true; final: FinalRecommendationResult & Readonly<{ ok: true }> }>
  | Readonly<{
      ok: false;
      code: "consilium_route_failed" | "head_synthesis_failed" | "finalization_failed";
      cause?: ConsiliumFailureCause;
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
  readonly #claude: ClaudeCodeSubscriptionProcess;
  readonly #environment: Record<string, unknown>;
  readonly #privateSingleOwner: boolean;
  readonly #now: () => Date;
  readonly #afterConfirmed: ConfirmedMessageObserver | undefined;

  constructor(input: Readonly<{
    registrar: RegistrarDO;
    codex: CodexAppServerThreadClient;
    claude: ClaudeCodeSubscriptionProcess;
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
  }>): Promise<SessionLaunchResult> {
    if (!validRoles(input.head, input.specialists, input.critic)) return { ok: false, code: "invalid_roles" };
    const preflight = await preflightSessionSubscriptions({
      environment: this.#environment,
      snapshot: input.snapshot,
      capabilityReceipt: input.capabilityReceipt,
      codexTransport: this.#codex.transport,
      claudeProcess: this.#claude,
      privateSingleOwner: this.#privateSingleOwner,
      now: this.#now()
    });
    if (!preflight.ok) return { ok: false, code: "preflight_failed", preflightCode: preflight.code };
    const selectedCodex = preflight.codex.models.find((model) => model.productId === input.snapshot.settings.codexModelId);
    if (selectedCodex === undefined) return { ok: false, code: "preflight_failed", preflightCode: "codex_model_not_available" };

    const headLease = await this.#codex.startIsolatedThread({ modelId: selectedCodex.runtimeModelId });
    if (!headLease.ok) return { ok: false, code: "codex_thread_start_failed" };
    const specialistLeases: CodexThreadLease[] = [];
    for (const specialist of input.specialists) {
      const lease = await this.#codex.startIsolatedThread({ modelId: selectedCodex.runtimeModelId });
      if (!lease.ok) return { ok: false, code: "codex_thread_start_failed" };
      specialistLeases.push(lease.value);
    }

    const head: AgentRegistration = Object.freeze({ ...input.head, provider: "codex", runtimeSessionRef: headLease.value.threadId });
    const specialists = Object.freeze(input.specialists.map((specialist, index) => Object.freeze({
      ...specialist,
      provider: "codex" as const,
      runtimeSessionRef: specialistLeases[index]!.threadId
    })));
    const critic: AgentRegistration = Object.freeze({
      ...input.critic,
      provider: "claude_code",
      runtimeSessionRef: preflight.claude.processRef
    });
    const roster = validateConsiliumRoster(specialists, critic);
    if (!roster.ok) return { ok: false, code: "invalid_roles" };

    const runtimes = Object.freeze([
      new CodexHeadThreadRuntime({ registration: head, lease: headLease.value }),
      ...specialists.map((registration, index) => new CodexConsiliumAgentRuntime({
        registration,
        lease: specialistLeases[index]!,
        threadClient: this.#codex,
        criticAgentId: critic.agentId,
        headAgentId: head.agentId,
        reasoningEffort: input.snapshot.settings.reasoningDepth
      })),
      new ClaudeCodeCriticRuntime({
        registration: critic,
        process: this.#claude,
        headAgentId: head.agentId,
        modelId: input.snapshot.settings.claudeModelId,
        reasoningEffort: input.snapshot.settings.reasoningDepth
      })
    ]);
    return {
      ok: true,
      value: Object.freeze({
        head: Object.freeze({ registration: head, lease: headLease.value }),
        specialists,
        critic,
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
          reasoningEffort: input.snapshot.settings.reasoningDepth
        }),
        finalizer: new CriticGatedFinalizer({
          registrar: this.#registrar,
          head,
          critic,
          ...(this.#afterConfirmed === undefined ? {} : { afterConfirmed: this.#afterConfirmed })
        })
      })
    };
  }
}

/** Runs the complete local orchestration path after `prepare` has fenced it. */
export async function executePreparedConsilium(input: Readonly<{
  prepared: PreparedConsilium;
  sessionGeneration: number;
  task: string;
}>): Promise<PreparedConsiliumExecutionResult> {
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
}
