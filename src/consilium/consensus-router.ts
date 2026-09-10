import type { RegistrarDO } from "../session/registrar-do.ts";
import type { ConfirmedMessageObserver } from "./a2a.ts";
import type { AgentRegistration } from "./roster.ts";
import { validateConsiliumRoster } from "./roster.ts";
import type { SpecialistAssignment } from "./consultant-roles.ts";
import type { ConsiliumAgentRuntime, ConsiliumEvidence, ConsiliumPhase, RuntimeEmission } from "./router.ts";
import { consensusDigest, consensusPositionsDigest, hasConsensus, type ConsensusLedger, type ConsensusState,
  type ConsensusDispatch, type ConsensusConfirmation, type ConsensusReview } from "./consensus-contract.ts";
import { SafeConsiliumFailure, safeFailureDetails, type ConsiliumFailureCause } from "./failures.ts";
import { isSecretLikeMatrixContent } from "../matrix/bridge.ts";
import { isInternalEventId } from "../identity/ids.ts";

export type ConsensusRunResult = Readonly<{ ok: true; outcome: "consensus" | "unresolved" | "safety_handoff"; visibleSequence: number; replayed: boolean }> |
  Readonly<{ ok: false; cause: ConsiliumFailureCause; ledgerCode?: string; retryAt?: string }>;

export type ConsensusRouterInput = Readonly<{
  registrar: RegistrarDO; ledger: ConsensusLedger; head: AgentRegistration;
  specialists: readonly AgentRegistration[]; critic: AgentRegistration;
  runtimes: readonly ConsiliumAgentRuntime[]; afterConfirmed?: ConfirmedMessageObserver;
  stopRuntimes?: () => void;
}>;

class ConsensusLedgerFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

function currentReview(state: ConsensusState, actor: string, target?: string): ConsensusReview | undefined {
  return [...state.reviews].reverse().find(review => review.proposalDigest === state.proposal?.digest &&
    review.actorAgentId === actor && (target === undefined || review.affectedSpecialistIds.includes(target)));
}

function positionsEvidence(state: ConsensusState): readonly ConsiliumEvidence[] {
  return state.specialists.flatMap(specialist => state.positions[specialist.agentId] === undefined ? [] :
    [{ fromRole: specialist.role, body: state.positions[specialist.agentId]!.body }]);
}

function reviewEvidence(state: ConsensusState): readonly ConsiliumEvidence[] {
  const actors = [state.head, ...state.specialists, state.critic];
  return state.reviews.filter(review => review.proposalDigest === state.proposal?.digest).map(review => ({
    fromRole: actors.find(actor => actor.agentId === review.actorAgentId)!.role,
    body: review.body
  }));
}

/** New production workflow. Legacy ConsiliumRouter remains read-compatible with
 * historical one-pass sessions but cannot establish this workflow's consensus.
 * The Registrar alone owns authoritative state, reservations and message counts.
 */
export class ConsensusRouter {
  readonly #input: ConsensusRouterInput;

  constructor(input: ConsensusRouterInput) { this.#input = input; }

  async run(input: Readonly<{
    sessionGeneration: number; taskId: string; task: string; language: string;
    taskDigest?: string;
    assignments: readonly SpecialistAssignment[]; signal?: AbortSignal;
  }>): Promise<ConsensusRunResult> {
    const { registrar, ledger, head, specialists, critic } = this.#input;
    const roster = [head, ...specialists, critic];
    const runtimes = new Map(this.#input.runtimes.map(runtime => [runtime.registration.agentId, runtime]));
    if (!validateConsiliumRoster(specialists, critic).ok || head.provider !== "codex" ||
      new Set(roster.map(actor => actor.agentId)).size !== roster.length || runtimes.size !== this.#input.runtimes.length ||
      roster.some(actor => {
        const runtime = runtimes.get(actor.agentId)?.registration;
        return runtime === undefined || runtime.role !== actor.role || runtime.provider !== actor.provider || runtime.runtimeSessionRef !== actor.runtimeSessionRef;
      })) return { ok: false, cause: "runtime_identity_mismatch" };
    const active = await registrar.getActiveSession();
    if (active?.generation !== input.sessionGeneration || active.phase !== "active") return { ok: false, cause: "obsolete_generation" };
    const policy = active.settingsSnapshot.speedPolicy;
    if (policy.paidAcceleration !== "forbidden" || Object.values(policy.invariants).some(value => value !== true)) return { ok: false, cause: "speed_policy_invariant_failed" };
    if (policy.maxOptionalSpecialists.status !== "resolved" || policy.concurrency.status !== "resolved") return { ok: false, cause: "speed_policy_unresolved" };
    if (specialists.length > 2 + policy.maxOptionalSpecialists.value || policy.concurrency.value < 1) return { ok: false, cause: "speed_policy_unsupported" };
    const concurrency = Math.min(specialists.length, policy.concurrency.value);
    const designated = await registrar.designateCritic({ generation: input.sessionGeneration, critic });
    if (!designated.ok) return { ok: false, cause: designated.code };
    const initialized = await ledger.initializeConsensus({ generation: input.sessionGeneration, taskId: input.taskId,
      taskDigest: input.taskDigest ?? await consensusDigest(input.task), language: input.language, head, specialists, critic, assignments: input.assignments });
    if (!initialized.ok) return { ok: false, cause: "invalid_runtime_emission", ledgerCode: initialized.code };
    const prefix = `cns-${(await consensusDigest(input.taskId)).slice(0, 24)}`;
    let safetyResult: Extract<ConsensusRunResult, { ok: true }> | undefined;
    const read = async (): Promise<ConsensusState> => {
      const value = await ledger.getConsensus(input.taskId);
      if (value === undefined) throw new ConsensusLedgerFailure("consensus_state_missing");
      return value;
    };
    const fenced = async (): Promise<void> => {
      if (input.signal?.aborted) throw new SafeConsiliumFailure("codex_turn_cancelled");
      const session = await registrar.getActiveSession();
      if (session?.generation !== input.sessionGeneration || session.phase !== "active") throw new SafeConsiliumFailure("obsolete_generation");
    };
    const dispatch = (kind: ConsensusDispatch["kind"], actor: AgentRegistration, suffix: string,
      targets: readonly string[], proposalDigest?: string): ConsensusDispatch => ({
      generation: input.sessionGeneration, taskId: input.taskId,
      // The generation fences the turn but is not the identity of a task/count.
      dispatchId: `${prefix}-g${input.sessionGeneration}-${kind}-${suffix}`,
      actorAgentId: actor.agentId, kind, affectedSpecialistIds: targets,
      ...(proposalDigest === undefined ? {} : { proposalDigest })
    });
    const confirm = async (value: ConsensusConfirmation) => {
      const result = await ledger.confirmConsensusMessage(value);
      if (!result.ok) throw new ConsensusLedgerFailure(result.code);
      if (value.safetyHandoff === true) this.#input.stopRuntimes?.();
      if (this.#input.afterConfirmed !== undefined) {
        try { await this.#input.afterConfirmed(result.value); }
        catch { throw new SafeConsiliumFailure("confirmed_delivery_rejected"); }
      }
      const receipt = { visibleSequence: result.value.sequence, replayed: result.replayed === true };
      if (value.safetyHandoff === true) safetyResult = { ok: true, outcome: "safety_handoff", ...receipt };
      return receipt;
    };
    const run = async (value: ConsensusDispatch, phase: ConsiliumPhase, assignment: string,
      evidence: readonly ConsiliumEvidence[], addressedTo: readonly string[], positionsDigest?: string) => {
      await fenced();
      const reserved = await ledger.reserveConsensusDispatch(value);
      if (!reserved.ok) throw new ConsensusLedgerFailure(reserved.code);
      if (reserved.value.confirmed !== undefined) return { visibleSequence: reserved.value.confirmed.sequence, replayed: true };
      const runtime = runtimes.get(value.actorAgentId)!;
      let emissionCount = 0;
      let output: Awaited<ReturnType<typeof confirm>> | undefined;
      await runtime.run({ phase, sessionGeneration: input.sessionGeneration, task: input.task, assignment, evidence,
        language: input.language, consensus: { dispatchId: value.dispatchId, affectedSpecialistIds: value.affectedSpecialistIds,
          ...(value.proposalDigest === undefined ? {} : { proposalDigest: value.proposalDigest }) }
      }, async (emission: RuntimeEmission) => {
        if (emissionCount++ !== 0) throw new SafeConsiliumFailure("duplicate_runtime_emission");
        const review = ["specialist_review", "critic_review", "head_review"].includes(value.kind);
        const expectedKind = phase === "initial_position" ? "initial_position" : phase === "revision" ? "revision" : phase === "critique" ? "critique" : "answer";
        const expectedRecipient = phase === "initial_position" ? critic.agentId : head.agentId;
        if (emission.body.trim().length === 0 || emission.body.length > 32_000 || isSecretLikeMatrixContent(emission.body) ||
          !isInternalEventId(emission.messageId) || emission.kind !== expectedKind || emission.toAgentId !== expectedRecipient ||
          (emission.safetyHandoff !== undefined && emission.safetyHandoff !== true) ||
          (review && emission.safetyHandoff === true && emission.decision !== "unresolved") ||
          (review && (!['agree', 'revise', 'unresolved'].includes(emission.decision ?? "") || emission.proposalDigest !== value.proposalDigest)) ||
          (!review && (emission.decision !== undefined || emission.proposalDigest !== undefined))) throw new SafeConsiliumFailure("invalid_runtime_emission");
        await fenced();
        output = await confirm({ ...value, messageId: value.dispatchId, body: emission.body, addressedTo,
          ...(positionsDigest === undefined ? {} : { positionsDigest }),
          ...(emission.decision === undefined ? {} : { decision: emission.decision }),
          ...(emission.safetyHandoff === true ? { safetyHandoff: true } : {}) });
        if (emission.safetyHandoff === true) throw new SafeConsiliumFailure("obsolete_generation");
      });
      if (emissionCount !== 1 || output === undefined) throw new SafeConsiliumFailure("runtime_no_output");
      return output;
    };
    try {
      let state = initialized.value;
      const assignmentBodies = new Map(input.assignments.map(assignment => [assignment.agentId,
        [assignment.question, assignment.expectedOutcome, ...assignment.facts, ...assignment.constraints,
          ...(assignment.dependencies.length === 0 ? [] : [assignment.dependencies.map(id => specialists.find(s => s.agentId === id)!.role).join("; ")])].join("\n\n")]));
      // The intake's real Head-generated structured assignment is forwarded once,
      // independently to each specialist; it is not a repeated generic brief.
      for (const specialist of specialists) {
        if (state.positions[specialist.agentId] !== undefined) continue;
        const assignment = input.assignments.find(item => item.agentId === specialist.agentId);
        if (assignment === undefined) throw new SafeConsiliumFailure("invalid_runtime_emission");
        const body = assignmentBodies.get(specialist.agentId)!;
        const value = dispatch("assignment", head, specialist.agentId, [specialist.agentId]);
        await fenced();
        const reserved = await ledger.reserveConsensusDispatch(value);
        if (!reserved.ok) throw new ConsensusLedgerFailure(reserved.code);
        if (reserved.value.confirmed === undefined) await confirm({ ...value, messageId: value.dispatchId, body, addressedTo: [specialist.agentId] });
      }
      await this.#batches(specialists.filter(specialist => state.positions[specialist.agentId] === undefined), concurrency, async specialist => {
        await run(dispatch("position", specialist, `${specialist.agentId}-1`, [specialist.agentId]), "initial_position",
          assignmentBodies.get(specialist.agentId)!, [], [critic.agentId]);
      });

      // Seven is a hard per-target message cap, not a request to waste seven rounds.
      // At most seven reviewed proposals can be needed because every fresh round
      // requires the Critic to review every current specialist position.
      for (;;) {
        await fenced();
        state = await read();
        if (hasConsensus(state)) {
          const value = dispatch("final", head, String(state.proposalVersion), [], state.proposal!.digest);
          const reserved = await ledger.reserveConsensusDispatch(value);
          if (!reserved.ok) throw new ConsensusLedgerFailure(reserved.code);
          const result = await confirm({ ...value, messageId: value.dispatchId, body: state.proposal!.body,
            positionsDigest: state.proposal!.positionsDigest, addressedTo: [] });
          return { ok: true, outcome: "consensus", ...result };
        }
        const fresh = state.proposal !== undefined && state.proposal.positionsDigest === await consensusPositionsDigest(state.positions);
        if (fresh) {
          const proposal = state.proposal!;
          const evidence = [...positionsEvidence(state), { fromRole: head.role, body: proposal.body }, ...reviewEvidence(state)];
          await this.#batches(specialists.filter(s => currentReview(state, s.agentId) === undefined), concurrency, async specialist => {
            await run(dispatch("specialist_review", specialist, `${state.proposalVersion}-${specialist.agentId}`, [specialist.agentId], proposal.digest),
              "agreement", "Review the complete candidate and your current specialist position. Give explicit agreement or a concrete needed correction.",
              evidence, [head.agentId, critic.agentId], proposal.positionsDigest);
          });
          state = await read();
          const criticTargets = specialists.filter(specialist =>
            currentReview(state, critic.agentId, specialist.agentId) === undefined && state.critiqueCounts[specialist.agentId]! < 7);
          if (criticTargets.length > 0) {
            const targetRoles = criticTargets.map(specialist => specialist.role);
            // One complete Critic review can address several specialists. The
            // durable ledger still increments and enforces the seven-message
            // cap independently for every affected specialist. This removes
            // unnecessary sequential model turns without weakening consensus.
            await run(dispatch("critic_review", critic, String(state.proposalVersion), criticTargets.map(s => s.agentId), proposal.digest),
              "critique", `Constructively review the current positions of ${targetRoles.join("; ")} and their treatment in the complete candidate. Help resolve material issues; agree when the complete candidate is sound. If any material correction is needed, identify every affected role precisely. This joint decision applies to all listed roles.`,
              [...positionsEvidence(state), { fromRole: head.role, body: proposal.body }, ...reviewEvidence(state)],
              [...criticTargets.map(s => s.agentId), head.agentId], proposal.positionsDigest);
            state = await read();
          }
          if (specialists.every(s => currentReview(state, s.agentId)?.decision === "agree" && currentReview(state, critic.agentId, s.agentId)?.decision === "agree") &&
            currentReview(state, head.agentId) === undefined) {
            await run(dispatch("head_review", head, String(state.proposalVersion), specialists.map(s => s.agentId), proposal.digest),
              "agreement", "All specialists and the designated Critic explicitly reviewed this exact candidate. Independently agree to this exact complete recommendation, or identify a concrete unresolved change. Do not rewrite it in an agreement.",
              [...positionsEvidence(state), { fromRole: head.role, body: proposal.body }, ...reviewEvidence(state)],
              [...specialists.map(s => s.agentId), critic.agentId], proposal.positionsDigest);
            state = await read();
          }
          if (hasConsensus(state)) continue;
        }
        state = await read();
        const reviews = reviewEvidence(state);
        const unresolved = state.reviews.some(review => review.proposalDigest === state.proposal?.digest && review.decision === "unresolved");
        if (unresolved || specialists.some(s => state.critiqueCounts[s.agentId]! >= 7)) {
          const result = await run(dispatch("unresolved", head, String(state.proposalVersion), specialists.map(s => s.agentId)), "proposal",
            "Consensus was NOT reached. This is an unresolved outcome, not a candidate or agreed final. In the session language, explicitly state that consensus was not reached, identify the actual remaining disagreements and missing evidence, and give a safe next step. Do not claim agreement or invent a solution. Do not expose technical IDs or hidden reasoning.",
            [...positionsEvidence(state), ...(state.proposal === undefined ? [] : [{ fromRole: head.role, body: state.proposal.body }]), ...reviews], []);
          return { ok: true, outcome: "unresolved", ...result };
        }
        // Finish every requested revision before replacing the proposal. A crash
        // after one revision is recoverable via the saved proposal's revision map.
        if (state.proposal !== undefined) {
          const proposal = state.proposal;
          const targets = specialists.filter(specialist => state.positions[specialist.agentId]!.revision === proposal.positionRevisions[specialist.agentId] &&
            state.reviews.some(review => review.proposalDigest === proposal.digest && review.decision === "revise" &&
              (review.actorAgentId === specialist.agentId || review.affectedSpecialistIds.includes(specialist.agentId))));
          await this.#batches(targets, concurrency, async specialist => {
            await run(dispatch("position", specialist, `${specialist.agentId}-${state.positions[specialist.agentId]!.revision + 1}`, [specialist.agentId]),
              "revision", "Respond to the specific current critique and requested corrections. Improve your specialist position, or explain the evidence-based reason for disagreeing. Do not simply repeat the original assignment.",
              [...positionsEvidence(state), { fromRole: head.role, body: proposal.body }, ...reviews], [head.agentId, critic.agentId]);
          });
        }
        state = await read();
        await run(dispatch("proposal", head, String(state.proposalVersion + 1), specialists.map(s => s.agentId)), "proposal",
          "Synthesize the current independent positions and the concrete review issues into one practical candidate. Preserve acknowledged uncertainty and safety boundaries. Tailor actions to the owner's task. Do not claim consensus until every participant explicitly approves this exact text.",
          [...positionsEvidence(state), ...reviews], [...specialists.map(s => s.agentId), critic.agentId], await consensusPositionsDigest(state.positions));
      }
    } catch (error) {
      if (safetyResult !== undefined) return safetyResult;
      return error instanceof ConsensusLedgerFailure ? { ok: false, cause: "invalid_runtime_emission", ledgerCode: error.code } :
        { ok: false, ...safeFailureDetails(error) };
    }
  }

  async #batches<T>(items: readonly T[], concurrency: number, operation: (item: T) => Promise<void>): Promise<void> {
    for (let index = 0; index < items.length; index += concurrency) {
      const outcomes = await Promise.allSettled(items.slice(index, index + concurrency).map(operation));
      const rejected = outcomes.find(outcome => outcome.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
    }
  }
}
