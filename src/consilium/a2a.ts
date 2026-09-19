import { criticBindingMatches, type RegistrarDO, type ConfirmedAgentMessage } from "../session/registrar-do.ts";
import { isAgentId, isInternalEventId } from "../identity/ids.ts";
import type { AgentRegistration } from "./roster.ts";
import type { ConsiliumFailureCause } from "./failures.ts";
import { containsSecretLikeContent } from "../security/content-policy.ts";

export type A2AEnvelope = Readonly<{
  messageId: string;
  sessionGeneration: number;
  fromAgentId: string;
  toAgentId: string;
  kind: "assignment" | "initial_position" | "question" | "answer" | "critique" | "revision";
  body: string;
}>;

export type A2ARouteResult =
  | Readonly<{ ok: true; visibleSequence: number; replayed: boolean }>
  | Readonly<{
      ok: false;
      code: "invalid_envelope" | "agent_not_registered" | "registrar_rejected" | "delivery_rejected";
      cause: ConsiliumFailureCause;
    }>;

export type ConfirmedMessageObserver = (message: ConfirmedAgentMessage) => Promise<void>;

/** One actual head instruction shared by the explicitly registered recipients.
 * It is recorded/delivered once, before any recipient consumes the same body.
 * This is not an output filter or a synthetic specialist identity.
 */
export async function routeHeadAssignment(
  registrar: RegistrarDO,
  roster: readonly AgentRegistration[],
  head: AgentRegistration,
  input: Readonly<{ messageId: string; sessionGeneration: number; toAgentIds: readonly string[]; body: string }>,
  afterConfirmed?: ConfirmedMessageObserver
): Promise<A2ARouteResult> {
  if (!isInternalEventId(input.messageId)) return { ok: false, code: "invalid_envelope", cause: "invalid_message_id" };
  if (!isAgentId(head.agentId)) return { ok: false, code: "invalid_envelope", cause: "invalid_sender_id" };
  const sender = roster.find(agent => agent.agentId === head.agentId);
  if (sender === undefined) return { ok: false, code: "agent_not_registered", cause: "sender_not_registered" };
  if (head.provider !== "codex" || sender.role !== head.role || sender.provider !== head.provider || sender.runtimeSessionRef !== head.runtimeSessionRef) {
    return { ok: false, code: "invalid_envelope", cause: "runtime_identity_mismatch" };
  }
  if (!Array.isArray(input.toAgentIds) || input.toAgentIds.length < 1 || input.toAgentIds.length > 5 ||
    new Set(input.toAgentIds).size !== input.toAgentIds.length || input.toAgentIds.some(id => !isAgentId(id) || id === head.agentId)) {
    return { ok: false, code: "invalid_envelope", cause: "invalid_recipient_id" };
  }
  const recipients = input.toAgentIds.map(id => roster.find(agent => agent.agentId === id));
  if (recipients.some(agent => agent === undefined)) return { ok: false, code: "agent_not_registered", cause: "recipient_not_registered" };
  if (recipients.some(agent => agent!.role.trim().length === 0 || agent!.role.length > 160)) {
    return { ok: false, code: "invalid_envelope", cause: "invalid_recipient_id" };
  }
  if (input.body.length === 0) return { ok: false, code: "invalid_envelope", cause: "empty_body" };
  if (containsSecretLikeContent(input.body)) return { ok: false, code: "invalid_envelope", cause: "invalid_runtime_emission" };
  const registered = await registrar.appendConfirmedMessage({
    generation: input.sessionGeneration, eventId: input.messageId, role: sender.role, body: input.body,
    addressedTo: recipients.map(agent => agent!.role).join("; "),
    authority: { agentId: sender.agentId, provider: sender.provider, runtimeSessionRef: sender.runtimeSessionRef, kind: "assignment" }
  });
  if (!registered.ok) return { ok: false, code: "registrar_rejected", cause: registered.code };
  if (afterConfirmed !== undefined) {
    try { await afterConfirmed(registered.value); }
    catch { return { ok: false, code: "delivery_rejected", cause: "confirmed_delivery_rejected" }; }
  }
  return { ok: true, visibleSequence: registered.value.sequence, replayed: registered.replayed };
}

export async function routeA2AEnvelope(
  registrar: RegistrarDO,
  roster: readonly AgentRegistration[],
  envelope: A2AEnvelope,
  afterConfirmed?: ConfirmedMessageObserver
): Promise<A2ARouteResult> {
  if (!isInternalEventId(envelope.messageId)) return { ok: false, code: "invalid_envelope", cause: "invalid_message_id" };
  if (!isAgentId(envelope.fromAgentId)) return { ok: false, code: "invalid_envelope", cause: "invalid_sender_id" };
  if (!isAgentId(envelope.toAgentId)) return { ok: false, code: "invalid_envelope", cause: "invalid_recipient_id" };
  if (envelope.body.length === 0) return { ok: false, code: "invalid_envelope", cause: "empty_body" };
  if (containsSecretLikeContent(envelope.body)) return { ok: false, code: "invalid_envelope", cause: "invalid_runtime_emission" };
  const sender = roster.find((agent) => agent.agentId === envelope.fromAgentId);
  const recipient = roster.find((agent) => agent.agentId === envelope.toAgentId);
  if (sender === undefined) return { ok: false, code: "agent_not_registered", cause: "sender_not_registered" };
  if (recipient === undefined) return { ok: false, code: "agent_not_registered", cause: "recipient_not_registered" };
  if (envelope.kind === "critique") {
    const designated = await registrar.getDesignatedCritic(envelope.sessionGeneration);
    if (!criticBindingMatches(designated, sender, envelope.sessionGeneration)) {
      return { ok: false, code: "registrar_rejected", cause: "runtime_identity_mismatch" };
    }
  }

  const registered = await registrar.appendConfirmedMessage({
    generation: envelope.sessionGeneration,
    eventId: envelope.messageId,
    role: sender.role,
    body: envelope.body,
    addressedTo: recipient.role,
    authority: { agentId: sender.agentId, provider: sender.provider, runtimeSessionRef: sender.runtimeSessionRef, kind: envelope.kind }
  });
  if (!registered.ok) return { ok: false, code: "registrar_rejected", cause: registered.code };
  if (envelope.kind === "critique") {
    const criticReview = await registrar.recordCriticReview({
      generation: envelope.sessionGeneration,
      eventId: envelope.messageId,
      critic: sender
    });
    if (!criticReview.ok) return { ok: false, code: "registrar_rejected", cause: criticReview.code };
  }
  if (afterConfirmed !== undefined) {
    try {
      await afterConfirmed(registered.value);
    } catch {
      return { ok: false, code: "delivery_rejected", cause: "confirmed_delivery_rejected" };
    }
  }
  return { ok: true, visibleSequence: registered.value.sequence, replayed: registered.replayed };
}
