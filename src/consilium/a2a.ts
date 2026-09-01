import type { RegistrarDO, ConfirmedAgentMessage } from "../session/registrar-do.ts";
import { isAgentId, isInternalEventId } from "../identity/ids.ts";
import type { AgentRegistration } from "./roster.ts";
import type { ConsiliumFailureCause } from "./failures.ts";

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
  const sender = roster.find((agent) => agent.agentId === envelope.fromAgentId);
  const recipient = roster.find((agent) => agent.agentId === envelope.toAgentId);
  if (sender === undefined) return { ok: false, code: "agent_not_registered", cause: "sender_not_registered" };
  if (recipient === undefined) return { ok: false, code: "agent_not_registered", cause: "recipient_not_registered" };

  const registered = await registrar.appendConfirmedMessage({
    generation: envelope.sessionGeneration,
    eventId: envelope.messageId,
    role: sender.role,
    body: envelope.body,
    addressedTo: recipient.role
  });
  if (!registered.ok) return { ok: false, code: "registrar_rejected", cause: registered.code };
  if (envelope.kind === "critique" && sender.provider === "claude_code") {
    const criticReview = await registrar.recordCriticReview({
      generation: envelope.sessionGeneration,
      eventId: envelope.messageId,
      role: sender.role
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
