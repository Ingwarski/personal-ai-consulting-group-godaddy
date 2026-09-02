import { isValidFinalRecommendation, type FinalRecommendation } from "../consilium/final-recommendation.ts";
import type { AgentRegistration } from "../consilium/roster.ts";
import type { ProviderReasoningEffort } from "../settings/types.ts";
import type { RegistrarDO } from "../session/registrar-do.ts";
import { CodexAppServerThreadClient, type CodexThreadLease } from "./codex-thread-client.ts";

export type HeadSynthesisResult =
  | Readonly<{ ok: true; messageId: string; recommendation: FinalRecommendation }>
  | Readonly<{ ok: false; code: "critic_not_confirmed" | "missing_consilium_evidence" | "invalid_head_response" | "runtime_failed" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown, limit = 8_000): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= limit;

const finalSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["decision", "actions", "riskOrAssumption", "reviewCondition"],
  properties: {
    decision: { type: "string", minLength: 1, maxLength: 8000 },
    actions: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "owner", "timeframe", "evidence"],
        properties: {
          action: { type: "string", minLength: 1, maxLength: 8000 },
          owner: { type: "string", minLength: 1, maxLength: 8000 },
          timeframe: { type: "string", minLength: 1, maxLength: 8000 },
          evidence: { type: "string", minLength: 1, maxLength: 8000 }
        }
      }
    },
    riskOrAssumption: { type: "string", minLength: 1, maxLength: 8000 },
    reviewCondition: { type: "string", minLength: 1, maxLength: 8000 },
    technicalPart: { type: "string", minLength: 1, maxLength: 8000 }
  }
});

function parseRecommendation(body: string): FinalRecommendation | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !nonEmpty(value.decision) || !Array.isArray(value.actions) ||
    !nonEmpty(value.riskOrAssumption) || !nonEmpty(value.reviewCondition)) return undefined;
  const allowed = new Set(["decision", "actions", "riskOrAssumption", "reviewCondition", "technicalPart"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  const actions = value.actions.map((action) => {
    if (!isRecord(action) || !nonEmpty(action.action) || !nonEmpty(action.owner) || !nonEmpty(action.timeframe) || !nonEmpty(action.evidence)) return undefined;
    if (Object.keys(action).some((key) => !["action", "owner", "timeframe", "evidence"].includes(key))) return undefined;
    return Object.freeze({ action: action.action, owner: action.owner, timeframe: action.timeframe, evidence: action.evidence });
  });
  if (actions.some((action) => action === undefined)) return undefined;
  if (value.technicalPart !== undefined && !nonEmpty(value.technicalPart)) return undefined;
  const recommendation: FinalRecommendation = Object.freeze({
    decision: value.decision,
    actions: Object.freeze(actions as Exclude<(typeof actions)[number], undefined>[]),
    riskOrAssumption: value.riskOrAssumption,
    reviewCondition: value.reviewCondition,
    ...(value.technicalPart === undefined ? {} : { technicalPart: value.technicalPart })
  });
  return isValidFinalRecommendation(recommendation) ? recommendation : undefined;
}

function synthesisPrompt(task: string, evidence: readonly Readonly<{ role: string; body: string }>[]): string {
  const transcript = evidence.map((message) => `Роль: ${message.role}\nПовна репліка:\n${message.body}`).join("\n\n---\n\n");
  return [
    "Ви — головний консультант приватного бізнес-консиліуму.",
    `Завдання власника:\n${task}`,
    `Повний підтверджений консиліум:\n${transcript}`,
    "Синтезуйте одну практичну рекомендацію. Відповідь має бути виключно валідним JSON за заданою схемою. `technicalPart` додавайте лише тоді, коли власник прямо потребує технічного втілення; інакше не включайте це поле. Не вигадуйте факти, не скорочуйте дії та не показуйте прихований хід міркувань."
  ].join("\n\n");
}

/**
 * The head uses its own pre-created Codex thread only after the registrar has
 * visibly recorded the Claude critique. The model produces strict data, while
 * the existing finalizer remains the only component that formats, appends and
 * closes the canonical session.
 */
export class CodexHeadSynthesizer {
  readonly #registrar: RegistrarDO;
  readonly #head: AgentRegistration;
  readonly #critic: AgentRegistration;
  readonly #lease: CodexThreadLease;
  readonly #threadClient: CodexAppServerThreadClient;
  readonly #reasoningEffort: ProviderReasoningEffort | null;

  constructor(input: Readonly<{
    registrar: RegistrarDO;
    head: AgentRegistration;
    critic: AgentRegistration;
    lease: CodexThreadLease;
    threadClient: CodexAppServerThreadClient;
    reasoningEffort: ProviderReasoningEffort | null;
  }>) {
    if (input.head.provider !== "codex" || input.head.runtimeSessionRef !== input.lease.threadId || input.critic.provider !== "claude_code") {
      throw new Error("The final synthesizer needs the registered head thread and Claude critic.");
    }
    this.#registrar = input.registrar;
    this.#head = input.head;
    this.#critic = input.critic;
    this.#lease = input.lease;
    this.#threadClient = input.threadClient;
    this.#reasoningEffort = input.reasoningEffort;
  }

  async synthesize(input: Readonly<{ sessionGeneration: number; task: string }>): Promise<HeadSynthesisResult> {
    const criticReceipt = await this.#registrar.getCriticReview(input.sessionGeneration);
    if (criticReceipt === undefined || criticReceipt.role !== this.#critic.role) return { ok: false, code: "critic_not_confirmed" };
    const evidence = await this.#registrar.getConfirmedMessages(input.sessionGeneration);
    if (evidence.length < 3 || !evidence.some((message) => message.internalEventId === criticReceipt.eventId)) {
      return { ok: false, code: "missing_consilium_evidence" };
    }
    const result = await this.#threadClient.runTextTurn({
      lease: this.#lease,
      body: synthesisPrompt(input.task, evidence.map((message) => ({ role: message.role, body: message.body }))),
      reasoningEffort: this.#reasoningEffort,
      outputSchema: finalSchema
    });
    if (!result.ok) return { ok: false, code: "runtime_failed" };
    const recommendation = parseRecommendation(result.body);
    return recommendation === undefined
      ? { ok: false, code: "invalid_head_response" }
      : { ok: true, messageId: `pc-${result.turnId}`, recommendation };
  }
}
