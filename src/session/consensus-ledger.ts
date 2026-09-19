import type { RegistrarStorage } from "./storage.ts";
import type { ConfirmedAgentMessage, ConfirmedAgentAuthority, SessionGeneration, DesignatedCriticBinding } from "./registrar-do.ts";
import type { ConsensusState, ConsensusLedger, ConsensusDispatch, ConsensusConfirmation, ConsensusResult } from "../consilium/consensus-contract.ts";
import { consensusDigest, consensusPositionsDigest, hasConsensus } from "../consilium/consensus-contract.ts";
import { assignConsultantColourSlots, resolveConsultantRole } from "../consilium/consultant-roles.ts";
import { canonicalSessionLanguage } from "../consilium/language.ts";
import { isInternalEventId, isSessionId, isExternalRuntimeId } from "../identity/ids.ts";
import { containsSecretLikeContent } from "../security/content-policy.ts";

const stateKey = (id: string) => `registrar:consensus:${id}`;
export const consensusTaskKey = (generation: number) => `registrar:consensus-task:${generation}`;
const dispatchesKey = (id: string) => `registrar:consensus-dispatches:${id}`;
type Reservation = { dispatch: ConsensusDispatch; confirmationHash?: string; confirmed?: ConfirmedAgentMessage };
type Reservations = Record<string, Reservation>;
const fail = (code: string) => ({ ok: false as const, code });
const success = <T>(value: T, replayed = false) => ({ ok: true as const, value, replayed });
const safeText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= 65_536 && !containsSecretLikeContent(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => [key, canonical(field)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const actors = (state: ConsensusState) => [state.head, ...state.specialists, state.critic];
const validActor = (actor: ConsensusState["head"]) => actor !== null && typeof actor === "object" &&
  resolveConsultantRole(actor.agentId)?.role === actor.role && isExternalRuntimeId(actor.runtimeSessionRef) &&
  (actor.provider === "codex" || actor.provider === "claude_code");
const identity = (actor: ConsensusState["head"]) => [actor.agentId, actor.role, actor.provider];
const distinct = (values: readonly string[]) => new Set(values).size === values.length;
const digestString = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
async function writeState(storage: RegistrarStorage, state: ConsensusState): Promise<void> {
  await storage.put(stateKey(state.taskId), { ...state, integrityDigest: await consensusDigest(JSON.stringify(canonical(state))) });
}

/** No SQL schema change: all records share the existing transactional Registrar KV. */
export async function readConsensusState(storage: RegistrarStorage, taskId: string): Promise<ConsensusState | undefined> {
  if (!isSessionId(taskId)) return undefined;
  const stored = await storage.get<ConsensusState & { integrityDigest: string }>(stateKey(taskId));
  if (stored === undefined) return undefined;
  const { integrityDigest, ...state } = stored;
  if (!digestString(integrityDigest) || await consensusDigest(JSON.stringify(canonical(state))) !== integrityDigest) throw new Error("Invalid durable consensus integrity.");
  if (state.schemaVersion !== "1" || state.taskId !== taskId || !/^[a-f0-9]{64}$/.test(state.taskDigest) || !Number.isSafeInteger(state.generation) ||
    canonicalSessionLanguage(state.language) !== state.language || !Array.isArray(state.specialists) || state.specialists.length < 2 || state.specialists.length > 5 ||
    !actors(state).every(validActor) || !distinct(actors(state).map(a => a.agentId)) ||
    !Number.isSafeInteger(state.proposalVersion) || state.proposalVersion < 0 || !Array.isArray(state.reviews) ||
    !["working", "consensus", "unresolved", "published"].includes(state.status) ||
    Object.keys(state.critiqueCounts).length !== state.specialists.length ||
    state.specialists.some(s => !Number.isSafeInteger(state.critiqueCounts[s.agentId]) || state.critiqueCounts[s.agentId]! < 0 || state.critiqueCounts[s.agentId]! > 7) ||
    state.reviews.some(r => !actors(state).some(a => a.agentId === r.actorAgentId) || !digestString(r.proposalDigest) ||
      !["agree", "revise", "unresolved"].includes(r.decision) || !safeText(r.body) || !Array.isArray(r.affectedSpecialistIds) ||
      !distinct(r.affectedSpecialistIds) || r.affectedSpecialistIds.some((id: string) => !state.specialists.some(s => s.agentId === id))) ||
    Object.entries(state.positions).some(([id, position]) => !state.specialists.some(s => s.agentId === id) ||
      !Number.isSafeInteger(position.revision) || position.revision < 1 || !safeText(position.body))) throw new Error("Invalid durable consensus state.");
  if (state.proposal !== undefined && (await consensusDigest(state.proposal.body) !== state.proposal.digest ||
    !digestString(state.proposal.positionsDigest) || !safeText(state.proposal.body) ||
    typeof state.proposal.positionRevisions !== "object" || state.proposal.positionRevisions === null ||
    Object.keys(state.proposal.positionRevisions).length !== state.specialists.length || state.specialists.some(s =>
      !Number.isSafeInteger(state.proposal!.positionRevisions[s.agentId]) || state.proposal!.positionRevisions[s.agentId]! < 1))) throw new Error("Invalid durable proposal.");
  return state;
}

function activeError(active: SessionGeneration | undefined, generation: number) {
  if (active === undefined) return fail("no_active_session");
  if (active.generation !== generation) return fail("obsolete_generation");
  if (active.phase !== "active") return fail("session_not_active");
  return undefined;
}

export async function initializeConsensusState(storage: RegistrarStorage, input: Parameters<ConsensusLedger["initializeConsensus"]>[0],
  active: SessionGeneration | undefined, critic: DesignatedCriticBinding | undefined): Promise<ConsensusResult<ConsensusState>> {
  const error = activeError(active, input.generation);
  if (error) return error;
  const roster = [input.head, ...input.specialists, input.critic];
  if (!isSessionId(input.taskId) || !/^[a-f0-9]{64}$/.test(input.taskDigest) || canonicalSessionLanguage(input.language) !== input.language ||
    input.head.agentId !== "head" || input.critic.agentId !== "critic" || input.head.provider !== "codex" ||
    input.specialists.length < 2 || input.specialists.length > 5 || !roster.every(validActor) ||
    !distinct(roster.map(a => a.agentId)) || !distinct(roster.map(a => `${a.provider}:${a.runtimeSessionRef}`)) ||
    input.specialists.some(s => s.provider !== "codex") || critic?.runtimeSessionRef !== input.critic.runtimeSessionRef ||
    critic.provider !== input.critic.provider || critic.agentId !== input.critic.agentId ||
    !Array.isArray(input.assignments) || input.assignments.length !== input.specialists.length ||
    !distinct(input.assignments.map(a => a.agentId)) || !distinct(input.assignments.map(a => `${a.question.trim().toLowerCase()}|${a.expectedOutcome.trim().toLowerCase()}`)) ||
    input.assignments.some(a => !input.specialists.some(s => s.agentId === a.agentId) || !safeText(a.question) || !safeText(a.expectedOutcome) ||
      ![a.facts, a.constraints, a.dependencies].every(Array.isArray) || !a.facts.every(safeText) || !a.constraints.every(safeText) ||
      a.dependencies.some((id: string) => id === a.agentId || !input.specialists.some(s => s.agentId === id)))) return fail("invalid_consensus_initialization");
  const boundTask = await storage.get<string>(consensusTaskKey(input.generation));
  if (boundTask !== undefined && boundTask !== input.taskId) return fail("task_identity_conflict");
  const existing = await readConsensusState(storage, input.taskId);
  if (existing !== undefined) {
    if (!same(actors(existing).map(identity), roster.map(identity)) || !same(existing.assignments, input.assignments)) return fail("task_roster_conflict");
    if (existing.generation === input.generation) {
      return same(actors(existing), roster) && existing.language === input.language && existing.taskDigest === input.taskDigest ? success(existing, true) : fail("runtime_identity_conflict");
    }
    // Only the Registrar's explicit revision can carry a task into another generation.
    if (boundTask !== input.taskId || active?.previousGeneration !== existing.generation) return fail("task_identity_conflict");
    const { finalBody: _priorFinal, proposal: priorProposal, ...prior } = existing;
    const taskChanged = existing.taskDigest !== input.taskDigest;
    const updated: ConsensusState = { ...prior, generation: input.generation, language: input.language, taskDigest: input.taskDigest,
      positions: taskChanged ? {} : existing.positions,
      ...(!taskChanged && existing.language === input.language && priorProposal !== undefined ? { proposal: priorProposal } : {}),
      head: input.head, specialists: input.specialists, critic: input.critic, status: "working",
      // Continue fences unconfirmed output by generation, but confirmed reviews
      // remain valid for the same immutable task and exact proposal digest.
      // Repeating them wastes provider turns and can make recovery time out.
      reviews: taskChanged || existing.language !== input.language ? [] : existing.reviews };
    await writeState(storage, updated);
    return success(updated);
  }
  if (boundTask !== undefined) return fail("consensus_state_missing");
  const state: ConsensusState = { schemaVersion: "1", taskId: input.taskId, taskDigest: input.taskDigest, generation: input.generation, language: input.language,
    head: input.head, specialists: input.specialists, critic: input.critic, assignments: input.assignments,
    positions: {}, proposalVersion: 0, reviews: [], critiqueCounts: Object.fromEntries(input.specialists.map(s => [s.agentId, 0])), status: "working" };
  await writeState(storage, state);
  await storage.put(consensusTaskKey(input.generation), input.taskId);
  // Presentation is persisted once and never derived from array completion order.
  await storage.put(`registrar:consensus-colours:${input.taskId}`, assignConsultantColourSlots(roster));
  return success(state);
}

async function dispatchState(storage: RegistrarStorage, input: ConsensusDispatch, active: SessionGeneration | undefined): Promise<ConsensusResult<ConsensusState>> {
  const error = activeError(active, input.generation);
  if (error) return error;
  if (!isSessionId(input.taskId) || !isInternalEventId(input.dispatchId) || !Array.isArray(input.affectedSpecialistIds) || !distinct(input.affectedSpecialistIds)) return fail("invalid_dispatch");
  const state = await readConsensusState(storage, input.taskId);
  if (state === undefined || state.generation !== input.generation || await storage.get<string>(consensusTaskKey(input.generation)) !== input.taskId) return fail("obsolete_generation");
  if (state.status === "published" || state.status === "unresolved") return fail("consensus_closed");
  const specialist = state.specialists.some(s => s.agentId === input.actorAgentId);
  const head = input.actorAgentId === state.head.agentId;
  if (input.affectedSpecialistIds.some(id => !state.specialists.some(s => s.agentId === id))) return fail("invalid_dispatch");
  if (!({ assignment: head, position: specialist, proposal: head, specialist_review: specialist,
    critic_review: input.actorAgentId === state.critic.agentId, head_review: head, unresolved: head, final: head }[input.kind])) return fail("invalid_dispatch_authority");
  if (input.kind === "critic_review" && input.affectedSpecialistIds.length === 0) return fail("invalid_dispatch");
  if (input.kind === "specialist_review" && !same(input.affectedSpecialistIds, [input.actorAgentId])) return fail("invalid_dispatch");
  if (["specialist_review", "critic_review", "head_review", "final"].includes(input.kind) &&
    (state.proposal === undefined || input.proposalDigest !== state.proposal.digest ||
      state.proposal.positionsDigest !== await consensusPositionsDigest(state.positions))) return fail("stale_proposal");
  if (input.kind === "final" && !hasConsensus(state)) return fail("consensus_not_reached");
  return success(state);
}

export async function reserveConsensusMessage(storage: RegistrarStorage, input: ConsensusDispatch, active: SessionGeneration | undefined): Promise<ConsensusResult<{ confirmed?: ConfirmedAgentMessage }>> {
  const checked = await dispatchState(storage, input, active);
  if (!checked.ok) return checked;
  const reservations = await storage.get<Reservations>(dispatchesKey(input.taskId)) ?? {};
  const old = reservations[input.dispatchId];
  if (old !== undefined) {
    if (!same(old.dispatch, input)) return fail("idempotency_conflict");
    return old.confirmed === undefined ? fail("dispatch_pending") : success({ confirmed: old.confirmed }, true);
  }
  if (Object.keys(reservations).length >= 512) return fail("dispatch_budget_exhausted");
  if (input.kind === "critic_review") {
    for (const id of input.affectedSpecialistIds) {
      const held = Object.values(reservations).filter(r => r.confirmed === undefined && r.dispatch.generation === input.generation &&
        r.dispatch.kind === "critic_review" && r.dispatch.affectedSpecialistIds.includes(id)).length;
      if ((checked.value.critiqueCounts[id] ?? 0) + held >= 7) return fail("critic_limit_reached");
    }
  }
  reservations[input.dispatchId] = { dispatch: structuredClone(input) };
  await storage.put(dispatchesKey(input.taskId), reservations);
  return success({});
}

type MessageInput = Parameters<import("./registrar-do.ts").RegistrarDO["appendConfirmedMessage"]>[0] & { consensusKind: ConsensusDispatch["kind"] | "safety_handoff" };
type PreparedConfirmation = { state: ConsensusState; message: MessageInput; confirmed?: ConfirmedAgentMessage };
function confirmationShape(input: ConsensusConfirmation) {
  return [input.generation, input.taskId, input.dispatchId, input.actorAgentId, input.kind, input.proposalDigest ?? null,
    input.affectedSpecialistIds, input.messageId, input.body, input.addressedTo, input.decision ?? null, input.positionsDigest ?? null, input.safetyHandoff ?? false];
}

export async function prepareConsensusConfirmation(storage: RegistrarStorage, input: ConsensusConfirmation,
  active: SessionGeneration | undefined): Promise<ConsensusResult<PreparedConfirmation>> {
  if (!isSessionId(input.taskId) || !isInternalEventId(input.dispatchId) || input.messageId !== input.dispatchId || !safeText(input.body) ||
    (input.safetyHandoff !== undefined && input.safetyHandoff !== true) ||
    !Array.isArray(input.addressedTo) || input.addressedTo.length > 7 || !distinct(input.addressedTo)) return fail("invalid_confirmation");
  const reservations = await storage.get<Reservations>(dispatchesKey(input.taskId)) ?? {};
  const reserved = reservations[input.dispatchId];
  const dispatch: ConsensusDispatch = { generation: input.generation, taskId: input.taskId, dispatchId: input.dispatchId,
    actorAgentId: input.actorAgentId, kind: input.kind, ...(input.proposalDigest === undefined ? {} : { proposalDigest: input.proposalDigest }), affectedSpecialistIds: input.affectedSpecialistIds };
  if (reserved === undefined || !same(reserved.dispatch, dispatch)) return fail("dispatch_not_reserved");
  const state = await readConsensusState(storage, input.taskId);
  if (state === undefined) return fail("consensus_state_missing");
  if (reserved.confirmed !== undefined) {
    if (reserved.confirmationHash !== await consensusDigest(JSON.stringify(confirmationShape(input)))) return fail("idempotency_conflict");
    return success({ state, message: {} as MessageInput, confirmed: reserved.confirmed }, true);
  }
  const checked = await dispatchState(storage, dispatch, active);
  if (!checked.ok) return checked;
  const actor = actors(state).find(a => a.agentId === input.actorAgentId)!;
  if (input.addressedTo.some(id => !actors(state).some(a => a.agentId === id))) return fail("invalid_recipient");
  // Addressing only Head never hides the counted targets; addressing another
  // specialist cannot evade that specialist's remaining Critic allowance.
  if (input.kind === "critic_review" && input.addressedTo.some(id => state.specialists.some(s => s.agentId === id) &&
    !input.affectedSpecialistIds.includes(id))) return fail("invalid_recipient");
  let updated = structuredClone(state);
  const currentPositionsDigest = await consensusPositionsDigest(state.positions);
  switch (input.kind) {
    case "position":
      updated = { ...updated, status: "working", positions: { ...state.positions,
        [actor.agentId]: { body: input.body, revision: (state.positions[actor.agentId]?.revision ?? 0) + 1 } } };
      break;
    case "proposal":
      if (state.specialists.some(s => state.positions[s.agentId] === undefined) || input.positionsDigest !== currentPositionsDigest) return fail("stale_positions");
      updated = { ...updated, status: "working", proposalVersion: state.proposalVersion + 1, reviews: [], proposal: {
        body: input.body, digest: await consensusDigest(input.body), positionsDigest: currentPositionsDigest,
        positionRevisions: Object.fromEntries(Object.entries(state.positions).map(([id, p]) => [id, p.revision])) } };
      break;
    case "specialist_review": case "critic_review": case "head_review": {
      if (!["agree", "revise", "unresolved"].includes(input.decision ?? "") || input.positionsDigest !== currentPositionsDigest) return fail("invalid_review");
      const counts = { ...state.critiqueCounts };
      if (input.kind === "critic_review") for (const id of input.affectedSpecialistIds) {
        if (counts[id]! >= 7) return fail("critic_limit_reached");
        counts[id] = counts[id]! + 1;
      }
      updated = { ...updated, critiqueCounts: counts, reviews: [...state.reviews, { actorAgentId: actor.agentId,
        proposalDigest: state.proposal!.digest, decision: input.decision!, body: input.body, affectedSpecialistIds: input.affectedSpecialistIds }] };
      updated = { ...updated, status: hasConsensus(updated) ? "consensus" : "working" };
      break;
    }
    case "final":
      if (!hasConsensus(state) || input.body !== state.proposal?.body || input.positionsDigest !== currentPositionsDigest) return fail("consensus_not_reached");
      updated = { ...updated, status: "published", finalBody: input.body };
      break;
    case "unresolved":
      if (!state.specialists.some(s => state.critiqueCounts[s.agentId]! >= 7) && !state.reviews.some(r => r.decision === "unresolved")) return fail("unresolved_not_justified");
      updated = { ...updated, status: "unresolved", finalBody: input.body };
      break;
  }
  if (input.safetyHandoff === true) {
    if (["assignment", "final"].includes(input.kind) || (["critic_review", "specialist_review", "head_review"].includes(input.kind) && input.decision !== "unresolved")) return fail("invalid_safety_handoff");
    updated = { ...updated, status: "unresolved", finalBody: input.body };
  }
  const kind: ConfirmedAgentAuthority["kind"] = input.kind === "assignment" ? "assignment" : input.kind === "critic_review" ? "critique"
    : input.kind === "position" ? state.positions[actor.agentId] === undefined ? "initial_position" : "revision" : "answer";
  return success({ state: updated, message: { generation: input.generation, eventId: input.messageId, role: actor.role, body: input.body,
    language: state.language, consensusKind: input.safetyHandoff ? "safety_handoff" : input.kind, ...(input.addressedTo.length === 0 ? {} : { addressedTo: input.addressedTo.map(id => actors(state).find(a => a.agentId === id)!.role).join("; ") }),
    authority: { agentId: actor.agentId, provider: actor.provider, runtimeSessionRef: actor.runtimeSessionRef, kind } } });
}

export async function commitConsensusConfirmation(storage: RegistrarStorage, input: ConsensusConfirmation, state: ConsensusState, message: ConfirmedAgentMessage): Promise<void> {
  const reservations = (await storage.get<Reservations>(dispatchesKey(input.taskId)))!;
  reservations[input.dispatchId] = { ...reservations[input.dispatchId]!, confirmed: message,
    confirmationHash: await consensusDigest(JSON.stringify(confirmationShape(input))) };
  await writeState(storage, state);
  await storage.put(dispatchesKey(input.taskId), reservations);
}
