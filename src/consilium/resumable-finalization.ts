import { confirmedMessageFingerprint, criticReceiptMatches, isConfirmedAgentAuthority, type RegistrarDO } from "../session/registrar-do.ts";
import type { AgentRegistration } from "./roster.ts";

/** Reuse only complete, untampered work in the still-active generation.
 * A visible label, old generation, partial revision or other critic is never
 * sufficient. The router cannot confirm the critique before all first passes.
 */
export async function readResumableFinalization(registrar: RegistrarDO, generation: number): Promise<Readonly<{
  head: AgentRegistration; critic: AgentRegistration;
}> | undefined> {
  const active = await registrar.getActiveSession();
  if (active?.generation !== generation || active.phase !== "active") return undefined;
  const critic = await registrar.getDesignatedCritic(generation);
  const review = await registrar.getCriticReview(generation);
  if (critic === undefined || review === undefined || !criticReceiptMatches(review, critic, generation)) return undefined;
  const messages = await registrar.getConfirmedMessages(generation);
  for (const message of messages) {
    if (message.generation !== generation) return undefined;
    // Control notices have their Matrix reply relation in the outbox, not the
    // transcript. They are not review evidence. Check every agent-bound body.
    if (message.authority !== undefined && (!isConfirmedAgentAuthority(message.authority) ||
      await confirmedMessageFingerprint(message) !== message.bodyHash)) return undefined;
  }
  const critique = messages.find(m => m.sequence === review.sequence && m.internalEventId === review.eventId && m.bodyHash === review.bodyHash);
  if (critique === undefined || critique.authority?.kind !== "critique") return undefined;
  const initial = messages.filter(m => m.authority?.kind === "initial_position");
  if (initial.length < 2 || initial.length > 5 || new Set(initial.map(m => m.authority!.agentId)).size !== initial.length ||
    new Set(initial.map(m => m.authority!.runtimeSessionRef)).size !== initial.length) return undefined;
  for (const position of initial) {
    const identity = position.authority!;
    if (position.sequence >= critique.sequence || identity.provider !== "codex" || identity.agentId === critic.agentId || identity.runtimeSessionRef === critic.runtimeSessionRef) return undefined;
    const revisions = messages.filter(m => m.authority?.kind === "revision" && m.authority.agentId === identity.agentId);
    if (revisions.length !== 1 || revisions[0]!.sequence <= critique.sequence || revisions[0]!.role !== position.role ||
      revisions[0]!.authority!.provider !== identity.provider || revisions[0]!.authority!.runtimeSessionRef !== identity.runtimeSessionRef) return undefined;
  }
  if (messages.filter(m => m.authority?.kind === "revision").length !== initial.length) return undefined;
  const assignment = messages.find(m => m.authority?.kind === "assignment");
  const authority = assignment?.authority;
  if (assignment === undefined || authority === undefined || authority.provider !== "codex" ||
    authority.agentId === critic.agentId || authority.runtimeSessionRef === critic.runtimeSessionRef ||
    initial.some(m => m.authority!.agentId === authority.agentId || m.authority!.runtimeSessionRef === authority.runtimeSessionRef)) return undefined;
  return { head: { agentId: authority.agentId, role: assignment.role, provider: "codex", runtimeSessionRef: authority.runtimeSessionRef }, critic };
}
