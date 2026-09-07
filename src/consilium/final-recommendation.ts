import type { A2AEnvelope } from "./a2a.ts";
import type { ConfirmedMessageObserver } from "./a2a.ts";
import type { AgentRegistration } from "./roster.ts";
import type { ConfirmedAgentMessage, RegistrarDO, SessionGeneration } from "../session/registrar-do.ts";
import { criticReceiptMatches } from "../session/registrar-do.ts";
import { isSecretLikeMatrixContent } from "../matrix/bridge.ts";

export type FinalAction = Readonly<{
  action: string;
  owner: string;
  timeframe: string;
  evidence: string;
}>;

export type FinalRecommendation = Readonly<{
  decision: string;
  actions: readonly FinalAction[];
  riskOrAssumption: string;
  reviewCondition: string;
  technicalPart?: string;
}>;

export type FinalRecommendationResult =
  | Readonly<{ ok: true; visibleSequence: number; replayed: boolean }>
  | Readonly<{
      ok: false;
      code:
        | "critic_not_ready"
        | "invalid_final_recommendation"
        | "invalid_final_sender"
        | "registrar_rejected"
        | "delivery_rejected"
        | "archive_rejected";
    }>;

/** A close observer must finish before the final can close a session. */
export type SessionCloseObserver = (input: Readonly<{
  session: SessionGeneration;
  messages: readonly ConfirmedAgentMessage[];
}>) => Promise<void>;

const isMeaningful = (value: string): boolean => value.trim().length > 0 && value.length <= 8_000;

export function isValidFinalRecommendation(value: FinalRecommendation): boolean {
  return isMeaningful(value.decision) &&
    value.actions.length <= 3 &&
    value.actions.every((action) =>
      isMeaningful(action.action) &&
      isMeaningful(action.owner) &&
      isMeaningful(action.timeframe) &&
      isMeaningful(action.evidence)
    ) &&
    isMeaningful(value.riskOrAssumption) &&
    isMeaningful(value.reviewCondition) &&
    (value.technicalPart === undefined || isMeaningful(value.technicalPart));
}

function formatAction(action: FinalAction, index: number): string {
  return `${index + 1}. **${action.action}**  \
Відповідальний: ${action.owner}. Строк: ${action.timeframe}. Ознака виконання: ${action.evidence}.`;
}

/** The formatted body is created once and then handed to the Registrar intact. */
export function formatFinalRecommendation(value: FinalRecommendation): string {
  const sections = [
    `## Рішення\n\n${value.decision}`,
    `## Що робимо зараз\n\n${value.actions.length === 0 ? "Окремих дій не потрібно." : value.actions.map(formatAction).join("\n\n")}`,
    `## Ризик або припущення\n\n${value.riskOrAssumption}`,
    `## Умова перегляду\n\n${value.reviewCondition}`
  ];
  if (value.technicalPart !== undefined) sections.push(`## Технічна частина\n\n${value.technicalPart}`);
  return sections.join("\n\n");
}

export class CriticGatedFinalizer {
  readonly #registrar: RegistrarDO;
  readonly #head: AgentRegistration;
  readonly #critic: AgentRegistration;
  readonly #afterConfirmed: ConfirmedMessageObserver | undefined;
  readonly #beforeStop: SessionCloseObserver | undefined;

  constructor(input: Readonly<{
    registrar: RegistrarDO;
    head: AgentRegistration;
    critic: AgentRegistration;
    afterConfirmed?: ConfirmedMessageObserver;
    beforeStop?: SessionCloseObserver;
  }>) {
    this.#registrar = input.registrar;
    this.#head = input.head;
    this.#critic = input.critic;
    this.#afterConfirmed = input.afterConfirmed;
    this.#beforeStop = input.beforeStop;
  }

  async publish(input: Readonly<{
    sessionGeneration: number;
    messageId: string;
    recommendation: FinalRecommendation;
  }>): Promise<FinalRecommendationResult> {
    if (await this.#registrar.getConsensusTask(input.sessionGeneration) !== undefined) return { ok: false, code: "critic_not_ready" };
    if (!this.validatesHead(this.#head)) return { ok: false, code: "invalid_final_sender" };
    if (!isValidFinalRecommendation(input.recommendation)) return { ok: false, code: "invalid_final_recommendation" };
    const body = formatFinalRecommendation(input.recommendation);
    if (isSecretLikeMatrixContent(body)) return { ok: false, code: "invalid_final_recommendation" };

    const criticReview = await this.#registrar.getCriticReview(input.sessionGeneration);
    if (!criticReceiptMatches(criticReview, this.#critic, input.sessionGeneration)) {
      return { ok: false, code: "critic_not_ready" };
    }

    const appended = await this.#registrar.appendConfirmedMessage({
      generation: input.sessionGeneration,
      eventId: input.messageId,
      role: this.#head.role,
      body
    });
    if (!appended.ok) return { ok: false, code: "registrar_rejected" };
    if (this.#afterConfirmed !== undefined) {
      try {
        await this.#afterConfirmed(appended.value);
      } catch {
        // The transcript remains intact and can be retried by the same event id;
        // do not close the session before Element has a delivery receipt.
        return { ok: false, code: "delivery_rejected" };
      }
    }
    if (this.#beforeStop !== undefined) {
      const session = await this.#registrar.getActiveSession();
      if (session === undefined || session.generation !== input.sessionGeneration || session.phase !== "active") {
        return { ok: false, code: "registrar_rejected" };
      }
      try {
        await this.#beforeStop({
          session,
          messages: await this.#registrar.getConfirmedMessages(input.sessionGeneration)
        });
      } catch {
        // The final remains append-only and retryable by the same message id.
        // Do not stop before its encrypted whole-session copy is committed.
        return { ok: false, code: "archive_rejected" };
      }
    }

    // Normal completion must not use cancellation: the durable final is often
    // still pending in the outbox when this call runs.
    const closed = await this.#registrar.closeSession(input.sessionGeneration);
    if (!closed.ok) return { ok: false, code: "registrar_rejected" };
    return { ok: true, visibleSequence: appended.value.sequence, replayed: appended.replayed };
  }

  acceptsCritique(envelope: A2AEnvelope): boolean {
    return envelope.kind === "critique" && envelope.fromAgentId === this.#critic.agentId;
  }

  validatesHead(agent: AgentRegistration): boolean {
    return agent.agentId === this.#head.agentId && agent.provider === "codex" && agent.runtimeSessionRef.trim().length > 0;
  }
}
