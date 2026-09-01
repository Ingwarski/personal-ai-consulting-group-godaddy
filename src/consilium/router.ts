import type { RegistrarDO } from "../session/registrar-do.ts";
import { routeA2AEnvelope, type A2AEnvelope, type ConfirmedMessageObserver } from "./a2a.ts";
import type { AgentRegistration } from "./roster.ts";
import { validateConsiliumRoster } from "./roster.ts";
import { SafeConsiliumFailure, safeFailureDetails, type ConsiliumFailureCause } from "./failures.ts";

export type ConsiliumPhase = "initial_position" | "critique" | "revision";

export type ConsiliumEvidence = Readonly<{
  fromRole: string;
  body: string;
}>;

export type RuntimeEmission = Readonly<{
  messageId: string;
  kind: A2AEnvelope["kind"];
  toAgentId: string;
  body: string;
}>;

export interface ConsiliumAgentRuntime {
  readonly registration: AgentRegistration;
  run(input: Readonly<{
    phase: ConsiliumPhase;
    sessionGeneration: number;
    task: string;
    assignment: string;
    evidence: readonly ConsiliumEvidence[];
  }>, emit: (message: RuntimeEmission) => Promise<void>): Promise<void>;
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

function assignmentBody(phase: ConsiliumPhase, task: string, recipientRole: string): string {
  if (phase === "initial_position") {
    return `Проаналізуйте завдання власника у вашій спеціалізації та надішліть повну незалежну первинну позицію для Критика.\n\nЗавдання власника:\n${task}`;
  }
  if (phase === "critique") {
    return `Перевірте повні первинні позиції спеціалістів: припущення, суперечності, ризики й відсутні дані. Надішліть повну критичну репліку для Головного консультанта.\n\nЗавдання власника:\n${task}`;
  }
  return `Після повної критичної репліки доопрацюйте свою позицію. Надішліть повну переглянуту репліку для Головного консультанта; не повторюйте приховані міркування.\n\nЗавдання власника:\n${task}\n\nАдресат: ${recipientRole}.`;
}

/**
 * Coordinates independent initial positions, a separate Claude critic and a
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
    const rosterResult = validateConsiliumRoster(this.#specialists, this.#critic);
    if (!rosterResult.ok || this.#head.provider !== "codex" || this.#head.runtimeSessionRef.trim().length === 0) {
      return { ok: false, code: "invalid_roster", cause: "runtime_identity_mismatch" };
    }
    const roster = Object.freeze([this.#head, ...rosterResult.agents]);
    const runtimes = this.#runtimesFor(roster);
    if (!runtimes.ok) return runtimes;

    const activeSession = await this.#registrar.getActiveSession();
    if (activeSession === undefined) return { ok: false, code: "speed_policy_failed", cause: "no_active_session" };
    if (activeSession.generation !== input.sessionGeneration) return { ok: false, code: "speed_policy_failed", cause: "obsolete_generation" };
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
    const assign = async (phase: ConsiliumPhase, recipient: AgentRegistration): Promise<void> => {
      const routed = await routeA2AEnvelope(this.#registrar, roster, {
        messageId: assignmentMessageId(input.sessionGeneration, phase, recipient.agentId),
        sessionGeneration: input.sessionGeneration,
        fromAgentId: this.#head.agentId,
        toAgentId: recipient.agentId,
        kind: "assignment",
        body: assignmentBody(phase, input.task, recipient.role)
      }, this.#afterConfirmed);
      if (!routed.ok) throw new SafeConsiliumFailure(routed.cause);
      assignmentSequences.push(routed.visibleSequence);
    };
    try {
      for (const specialist of this.#specialists) await assign("initial_position", specialist);
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
          assignment: assignmentBody("initial_position", input.task, specialist.role),
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
      await assign("critique", this.#critic);
      await criticRuntime.run({
        phase: "critique",
        sessionGeneration: input.sessionGeneration,
        task: input.task,
        assignment: assignmentBody("critique", input.task, this.#critic.role),
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
      for (const specialist of this.#specialists) await assign("revision", specialist);
      await this.#runBatches(this.#specialists, concurrency, async (specialist) => {
        const runtime = runtimes.value.get(specialist.agentId);
        if (runtime === undefined) throw new SafeConsiliumFailure("runtime_missing");
        let outputCount = 0;
        await runtime.run({
          phase: "revision",
          sessionGeneration: input.sessionGeneration,
          task: input.task,
          assignment: assignmentBody("revision", input.task, specialist.role),
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
      await Promise.all(items.slice(index, index + concurrency).map(operation));
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
