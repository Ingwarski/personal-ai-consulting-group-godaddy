import type { AgentRegistration } from "./roster.ts";
import type { SpecialistAssignment } from "./consultant-roles.ts";
import type { ConfirmedAgentMessage } from "../session/registrar-do.ts";

export type ConsensusDecision = "agree" | "revise" | "unresolved";
export type ConsensusDispatchKind = "assignment" | "position" | "proposal" | "specialist_review" | "critic_review" | "head_review" | "unresolved" | "final";
export type ConsensusPosition = Readonly<{ body: string; revision: number }>;
export type ConsensusProposal = Readonly<{
  body: string; digest: string; positionsDigest: string;
  positionRevisions: Readonly<Record<string, number>>;
}>;
export type ConsensusReview = Readonly<{
  actorAgentId: string;
  proposalDigest: string;
  decision: ConsensusDecision;
  body: string;
  affectedSpecialistIds: readonly string[];
}>;
export type ConsensusState = Readonly<{
  schemaVersion: "1";
  taskId: string;
  taskDigest: string;
  generation: number;
  language: string;
  head: AgentRegistration;
  specialists: readonly AgentRegistration[];
  critic: AgentRegistration;
  assignments: readonly SpecialistAssignment[];
  positions: Readonly<Record<string, ConsensusPosition>>;
  proposal?: ConsensusProposal;
  /** Incremented for each committed new proposal, never reset on Continue. */
  proposalVersion: number;
  reviews: readonly ConsensusReview[];
  critiqueCounts: Readonly<Record<string, number>>;
  status: "working" | "consensus" | "unresolved" | "published";
  finalBody?: string;
}>;
export type ConsensusResult<T> = Readonly<{ ok: true; value: T; replayed?: boolean }> | Readonly<{ ok: false; code: string }>;
export type ConsensusDispatch = Readonly<{
  generation: number;
  taskId: string;
  dispatchId: string;
  actorAgentId: string;
  kind: ConsensusDispatchKind;
  proposalDigest?: string;
  affectedSpecialistIds: readonly string[];
}>;
export type ConsensusConfirmation = ConsensusDispatch & Readonly<{
  messageId: string;
  body: string;
  addressedTo: readonly string[];
  decision?: ConsensusDecision;
  positionsDigest?: string;
  /** Actual author detected a crisis: publish this safe handoff and stop. */
  safetyHandoff?: true;
}>;

/** Implemented by the Registrar, not by the model or an in-memory router.
 * Reservations fence every dependent call. Confirm commits message, state,
 * counters and the canonical delivery projection in one transaction. Critic reservations
 * reject an eighth message before calling a provider. A failed provider attempt
 * may retry a bounded number of times without counting it as a Critic message.
 */
export interface ConsensusLedger {
  initializeConsensus(input: Readonly<{
    generation: number; taskId: string; taskDigest: string; language: string;
    head: AgentRegistration; specialists: readonly AgentRegistration[]; critic: AgentRegistration;
    assignments: readonly SpecialistAssignment[];
  }>): Promise<ConsensusResult<ConsensusState>>;
  getConsensus(taskId: string): Promise<ConsensusState | undefined>;
  reserveConsensusDispatch(input: ConsensusDispatch): Promise<ConsensusResult<Readonly<{ confirmed?: ConfirmedAgentMessage }>>>;
  confirmConsensusMessage(input: ConsensusConfirmation): Promise<ConsensusResult<ConfirmedAgentMessage>>;
}

export async function consensusDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function consensusPositionsDigest(positions: Readonly<Record<string, ConsensusPosition>>): Promise<string> {
  return consensusDigest(JSON.stringify(Object.keys(positions).sort().map(id => [id, positions[id]!.revision, positions[id]!.body])));
}

/** Agreement is explicit, complete and tied to exactly the current candidate.
 * A Critic agreement is required for every specialist, including multi-target
 * messages; a previous version, silence or a completed model turn is not consent.
 */
export function hasConsensus(state: ConsensusState): boolean {
  const proposal = state.proposal;
  if (proposal === undefined || state.specialists.some(s => state.positions[s.agentId] === undefined ||
    state.positions[s.agentId]!.revision !== proposal.positionRevisions[s.agentId] || (state.critiqueCounts[s.agentId] ?? 0) > 7)) return false;
  const current = state.reviews.filter(review => review.proposalDigest === proposal.digest);
  const latest = (actor: string, target?: string): ConsensusReview | undefined => [...current].reverse().find(review =>
    review.actorAgentId === actor && (target === undefined || review.affectedSpecialistIds.includes(target)));
  return latest(state.head.agentId)?.decision === "agree" && state.specialists.every(specialist =>
    latest(specialist.agentId)?.decision === "agree" && latest(state.critic.agentId, specialist.agentId)?.decision === "agree");
}
