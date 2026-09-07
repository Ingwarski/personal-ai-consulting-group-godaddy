import type { RegistrarDO } from "../session/registrar-do.ts";
import { routeA2AEnvelope, routeHeadAssignment, type A2AEnvelope, type ConfirmedMessageObserver } from "./a2a.ts";
import type { AgentRegistration } from "./roster.ts";
import { validateConsiliumRoster } from "./roster.ts";
import { SafeConsiliumFailure, safeFailureDetails, type ConsiliumFailureCause } from "./failures.ts";

export type ConsiliumPhase = "initial_position" | "critique" | "revision" | "proposal" | "agreement";

export type ConsiliumEvidence = Readonly<{
  fromRole: string;
  body: string;
}>;

export type RuntimeEmission = Readonly<{
  messageId: string;
  kind: A2AEnvelope["kind"];
  toAgentId: string;
  body: string;
  decision?: "agree" | "revise" | "unresolved";
  proposalDigest?: string;
  safetyHandoff?: true;
}>;

export type ConsensusTurnContext = Readonly<{
  dispatchId: string;
  affectedSpecialistIds: readonly string[];
  proposalDigest?: string;
}>;

export type ConsiliumRuntimeInput = Readonly<{
  phase: ConsiliumPhase;
  sessionGeneration: number;
  task: string;
  assignment: string;
  evidence: readonly ConsiliumEvidence[];
  language?: string;
  consensus?: ConsensusTurnContext;
}>;

export interface ConsiliumAgentRuntime {
  readonly registration: AgentRegistration;
  run(input: ConsiliumRuntimeInput, emit: (message: RuntimeEmission) => Promise<void>): Promise<void>;
}

export type ConsiliumRunResult =
  | Readonly<{
      ok: true;
      initialVisibleSequences: readonly number[];
      assignmentVisibleSequences: readonly number[];
      critiqueVisibleSequence: number;
      revisionVisibleSequences: readonly number[];
    }>
  | Readonly<{
      ok: false;
      code: "invalid_roster" | "runtime_missing" | "runtime_identity_mismatch" | "speed_policy_failed" | "initial_phase_failed" | "critique_phase_failed" | "revision_phase_failed";
      cause: ConsiliumFailureCause;
      retryAt?: string;
    }>;

const exactRegistration = (left: AgentRegistration, right: AgentRegistration): boolean =>
  left.agentId === right.agentId && left.role === right.role && left.provider === right.provider && left.runtimeSessionRef === right.runtimeSessionRef;

const meaningfulBody = (value: string): boolean => value.trim().length > 0 && value.length <= 32_000;
const assignmentMessageId = (generation: number, phase: ConsiliumPhase, targetAgentId: string): string =>
  `assignment-${generation}-${phase}-${targetAgentId}`;

function assignmentBody(phase: ConsiliumPhase, task: string, recipientRoles: readonly string[]): string {
  const addressees = `Адресати: ${recipientRoles.join("; ")}.`;
  if (phase === "initial_position") {
    return `${addressees}\n\nПрошу кожного проаналізувати завдання у своїй спеціалізації та надіслати окрему повну незалежну первинну позицію для Критика.\n\nЗавдання власника:\n${task}`;
  }
  if (phase === "critique") {
    return `${addressees}\n\nПеревірте повні первинні позиції спеціалістів щодо цього завдання: припущення, суперечності, ризики й відсутні дані. Надішліть повну критичну репліку для Головного консультанта.`;
  }
  return `${addressees}\n\nПісля повної критичної репліки прошу кожного доопрацювати свою позицію щодо цього завдання та надіслати окрему повну переглянуту репліку для Головного консультанта.`;
}

/**
 * Coordinates independent initial positions, a separate designated critic and a
 * mandatory specialist revision cycle. Every emission is a complete body,
 * written immediately through the only Registrar before a later phase can
 * consume it. This is deliberately not token streaming and never synthesizes
 * an agent's message itself.
 */
export class ConsiliumRouter {
  readonly #registrar: RegistrarDO;
  readonly #head: AgentRegistration;
  readonly #specialists: readonly AgentRegistration[];
  readonly #critic: AgentRegistration;
  readonly #runtimes: readonly ConsiliumAgentRuntime[];
  readonly #afterConfirmed: ConfirmedMessageObserver | undefined;

  constructor(input: Readonly<{
    registrar: RegistrarDO;
    head: AgentRegistration;
    specialists: readonly AgentRegistration[];
    critic: AgentRegistration;
    runtimes: readonly ConsiliumAgentRuntime[];
    afterConfirmed?: ConfirmedMessageObserver;
  }>) {
    this.#registrar = input.registrar;
    this.#head = input.head;
    this.#specialists = input.specialists;
    this.#critic = input.critic;
    this.#runtimes = input.runtimes;
    this.#afterConfirmed = input.afterConfirmed;
  }

  async run(input: Readonly<{ sessionGeneration: number; task: string }>): Promise<ConsiliumRunResult> {
    if (await this.#registrar.getConsensusTask(input.sessionGeneration) !== undefined) {
      return { ok: false, code: "invalid_roster", cause: "invalid_runtime_emission" };
    }
    const rosterResult = validateConsiliumRoster(this.#specialists, this.#critic);
    if (!rosterResult.ok || this.#head.provider !== "codex" || this.#head.runtimeSessionRef.trim().length === 0) {
      return { ok: false, code: "invalid_roster", cause: "runtime_identity_mismatch" };
    }
    const roster = Object.freeze([this.#head, ...rosterResult.agents]);
    if (new Set(roster.map((agent) => agent.agentId)).size !== roster.length ||
      new Set(roster.map((agent) => `${agent.provider}:${agent.runtimeSessionRef}`)).size !== roster.length) {
      return { ok: false, code: "invalid_roster", cause: "runtime_identity_mismatch" };
    }
    const runtimes = this.#runtimesFor(roster);
    if (!runtimes.ok) return runtimes;

    const activeSession = await this.#registrar.getActiveSession();
    if (activeSession === undefined) return { ok: false, code: "speed_policy_failed", cause: "no_active_session" };
    if (activeSession.generation !== input.sessionGeneration) return { ok: false, code: "speed_policy_failed", cause: "obsolete_generation" };
    const designated = await this.#registrar.designateCritic({ generation: input.sessionGeneration, critic: this.#critic });
    if (!designated.ok) return { ok: false, code: "runtime_identity_mismatch", cause: designated.code };
    const policy = activeSession.settingsSnapshot.speedPolicy;
    const invariantValues = Object.values(policy.invariants);
    if (policy.paidAcceleration !== "forbidden" || invariantValues.some((value) => value !== true)) {
      return { ok: false, code: "speed_policy_failed", cause: "speed_policy_invariant_failed" };
    }
    if (
      policy.maxOptionalSpecialists.status !== "resolved" ||
      policy.concurrency.status !== "resolved" ||
      policy.critiqueRevisionCycles.status !== "resolved"
    ) return { ok: false, code: "speed_policy_failed", cause: "speed_policy_unresolved" };
    if (
      this.#specialists.length > 2 + policy.maxOptionalSpecialists.value ||
      policy.concurrency.value < 1 ||
      policy.critiqueRevisionCycles.value !== 1
    ) return { ok: false, code: "speed_policy_failed", cause: "speed_policy_unsupported" };
    const concurrency = Math.min(policy.concurrency.value, this.#specialists.length);

    const assignmentSequences: number[] = [];
    const assignments = {
      initial_position: assignmentBody("initial_position", input.task, this.#specialists.map(agent => agent.role)),
      critique: assignmentBody("critique", input.task, [this.#critic.role]),
      revision: assignmentBody("revision", input.task, this.#specialists.map(agent => agent.role))
    };
    const assign = async (phase: "initial_position" | "critique" | "revision", recipients: readonly AgentRegistration[]): Promise<void> => {
      const routed = await routeHeadAssignment(this.#registrar, roster, this.#head, {
        messageId: assignmentMessageId(input.sessionGeneration, phase, phase === "critique" ? this.#critic.agentId : "specialists"),
        sessionGeneration: input.sessionGeneration,
        toAgentIds: recipients.map(agent => agent.agentId),
        body: assignments[phase]
      }, this.#afterConfirmed);
      if (!routed.ok) throw new SafeConsiliumFailure(routed.cause);
      assignmentSequences.push(routed.visibleSequence);
    };
    try {
      await assign("initial_position", this.#specialists);
    } catch (error) {
      return { ok: false, code: "initial_phase_failed", ...safeFailureDetails(error) };
    }

    const initialEvidenceByAgent = new Map<string, ConsiliumEvidence>();
    const initialSequences: number[] = [];
    try {
      await this.#runBatches(this.#specialists, concurrency, async (specialist) => {
        const runtime = runtimes.value.get(specialist.agentId);
        if (runtime === undefined) throw new SafeConsiliumFailure("runtime_missing");
        let outputCount = 0;
        await runtime.run({
          phase: "initial_position",
          sessionGeneration: input.sessionGeneration,
          task: input.task,
          assignment: assignments.initial_position,
          evidence: Object.freeze([])
        }, async (emission) => {
          if (emission.kind !== "initial_position" || emission.toAgentId !== this.#critic.agentId || !meaningfulBody(emission.body)) {
            throw new SafeConsiliumFailure("invalid_runtime_emission");
          }
          if (outputCount !== 0) throw new SafeConsiliumFailure("duplicate_runtime_emission");
          const routed = await routeA2AEnvelope(this.#registrar, roster, {
            messageId: emission.messageId,
            sessionGeneration: input.sessionGeneration,
            fromAgentId: specialist.agentId,
            toAgentId: emission.toAgentId,
            kind: emission.kind,
            body: emission.body
          }, this.#afterConfirmed);
          if (!routed.ok) throw new SafeConsiliumFailure(routed.cause);
          outputCount += 1;
          initialSequences.push(routed.visibleSequence);
          initialEvidenceByAgent.set(specialist.agentId, Object.freeze({ fromRole: specialist.role, body: emission.body }));
        });
        if (outputCount === 0) throw new SafeConsiliumFailure("runtime_no_output");
      });
    } catch (error) {
      return { ok: false, code: "initial_phase_failed", ...safeFailureDetails(error) };
    }
    const initialEvidence = Object.freeze(this.#specialists.map((specialist) => initialEvidenceByAgent.get(specialist.agentId)!));

    const criticRuntime = runtimes.value.get(this.#critic.agentId);
    if (criticRuntime === undefined) return { ok: false, code: "runtime_missing", cause: "runtime_missing" };
    let critiqueSequence: number | undefined;
    let critiqueBody: string | undefined;
    try {
      await assign("critique", [this.#critic]);
      await criticRuntime.run({
        phase: "critique",
        sessionGeneration: input.sessionGeneration,
        task: input.task,
        assignment: assignments.critique,
        evidence: initialEvidence
      }, async (emission) => {
        if (emission.kind !== "critique" || emission.toAgentId !== this.#head.agentId || !meaningfulBody(emission.body) || critiqueSequence !== undefined) {
          throw new SafeConsiliumFailure(critiqueSequence !== undefined ? "duplicate_runtime_emission" : "invalid_runtime_emission");
        }
        const routed = await routeA2AEnvelope(this.#registrar, roster, {
          messageId: emission.messageId,
          sessionGeneration: input.sessionGeneration,
          fromAgentId: this.#critic.agentId,
          toAgentId: emission.toAgentId,
          kind: emission.kind,
          body: emission.body
        }, this.#afterConfirmed);
        if (!routed.ok) throw new SafeConsiliumFailure(routed.cause);
        critiqueSequence = routed.visibleSequence;
        critiqueBody = emission.body;
      });
      if (critiqueSequence === undefined) throw new SafeConsiliumFailure("runtime_no_output");
    } catch (error) {
      return { ok: false, code: "critique_phase_failed", ...safeFailureDetails(error) };
    }
    if (critiqueBody === undefined) return { ok: false, code: "critique_phase_failed", cause: "runtime_no_output" };

    const revisionEvidence = Object.freeze([...initialEvidence, Object.freeze({ fromRole: this.#critic.role, body: critiqueBody })]);
    const revisionSequences: number[] = [];
    try {
      await assign("revision", this.#specialists);
      await this.#runBatches(this.#specialists, concurrency, async (specialist) => {
        const runtime = runtimes.value.get(specialist.agentId);
        if (runtime === undefined) throw new SafeConsiliumFailure("runtime_missing");
        let outputCount = 0;
        await runtime.run({
          phase: "revision",
          sessionGeneration: input.sessionGeneration,
          task: input.task,
          assignment: assignments.revision,
          evidence: revisionEvidence
        }, async (emission) => {
          if (emission.kind !== "revision" || emission.toAgentId !== this.#head.agentId || !meaningfulBody(emission.body)) {
            throw new SafeConsiliumFailure("invalid_runtime_emission");
          }
          if (outputCount !== 0) throw new SafeConsiliumFailure("duplicate_runtime_emission");
          const routed = await routeA2AEnvelope(this.#registrar, roster, {
            messageId: emission.messageId,
            sessionGeneration: input.sessionGeneration,
            fromAgentId: specialist.agentId,
            toAgentId: emission.toAgentId,
            kind: emission.kind,
            body: emission.body
          }, this.#afterConfirmed);
          if (!routed.ok) throw new SafeConsiliumFailure(routed.cause);
          outputCount += 1;
          revisionSequences.push(routed.visibleSequence);
        });
        if (outputCount === 0) throw new SafeConsiliumFailure("runtime_no_output");
      });
    } catch (error) {
      return { ok: false, code: "revision_phase_failed", ...safeFailureDetails(error) };
    }
    return Object.freeze({
      ok: true,
      initialVisibleSequences: Object.freeze([...initialSequences]),
      assignmentVisibleSequences: Object.freeze([...assignmentSequences]),
      critiqueVisibleSequence: critiqueSequence,
      revisionVisibleSequences: Object.freeze([...revisionSequences])
    });
  }

  async #runBatches<T>(items: readonly T[], concurrency: number, operation: (item: T) => Promise<void>): Promise<void> {
    for (let index = 0; index < items.length; index += concurrency) {
      // Drain the whole in-flight batch before cleanup; Promise.all would leave
      // the other provider turns orphaned when one specialist rejects early.
      const outcomes = await Promise.allSettled(items.slice(index, index + concurrency).map(operation));
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
    }
  }

  #runtimesFor(roster: readonly AgentRegistration[]):
    | Readonly<{ ok: true; value: ReadonlyMap<string, ConsiliumAgentRuntime> }>
    | Readonly<{
        ok: false;
        code: "runtime_missing" | "runtime_identity_mismatch";
        cause: "runtime_missing" | "runtime_identity_mismatch";
      }> {
    const map = new Map<string, ConsiliumAgentRuntime>();
    for (const runtime of this.#runtimes) {
      if (map.has(runtime.registration.agentId)) return { ok: false, code: "runtime_identity_mismatch", cause: "runtime_identity_mismatch" };
      map.set(runtime.registration.agentId, runtime);
    }
    for (const registration of roster) {
      const runtime = map.get(registration.agentId);
      if (runtime === undefined) return { ok: false, code: "runtime_missing", cause: "runtime_missing" };
      if (!exactRegistration(runtime.registration, registration)) return { ok: false, code: "runtime_identity_mismatch", cause: "runtime_identity_mismatch" };
    }
    return { ok: true, value: map };
  }
}
