import type { ConsiliumAgentRuntime, ConsiliumEvidence, ConsiliumRuntimeInput, RuntimeEmission } from "../consilium/router.ts";
import { consensusPrompt, parseConsensusOutput } from "../consilium/consensus-prompts.ts";
import type { AgentRegistration } from "../consilium/roster.ts";
import type { ProviderReadiness } from "./provider-preflight.ts";
import type { ProviderModelCapability, ProviderReasoningEffort } from "../settings/types.ts";
import { deriveInternalEventId, isAgentId, isExternalRuntimeId } from "../identity/ids.ts";
import { SafeConsiliumFailure, type ConsiliumFailureCause } from "../consilium/failures.ts";

export type ClaudeCodeSubscriptionStatus = Readonly<{
  processRef: string;
  authMode: "claude_code_oauth" | "other";
  readiness: ProviderReadiness;
  privateSingleOwner: boolean;
  bareMode: boolean;
  fastModeEnabled: boolean;
  extraUsageEnabled: boolean;
  models: readonly ProviderModelCapability[];
  resetAt?: string;
}>;

/**
 * The future Container adapter owns the setup-token secret. It may expose a
 * content-free readiness report and one completed critic body, never the
 * token, browser URL, auth code or raw execution transcript.
 */
export interface ClaudeCodeSubscriptionProcess {
  inspectSubscription(): Promise<ClaudeCodeSubscriptionStatus>;
  runCritique(input: Readonly<{
    modelId: string;
    runtimeModelId: string;
    reasoningEffort: ProviderReasoningEffort | null;
    prompt: string;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ turnRef: string; body: string }>>;
}

export type ClaudeCodeCriticRuntimeInput = Readonly<{
  registration: AgentRegistration;
  process: ClaudeCodeSubscriptionProcess;
  headAgentId: string;
  modelId: string;
  reasoningEffort: ProviderReasoningEffort | null;
  signal?: AbortSignal;
}>;

const nonEmpty = (value: unknown, maximum = 32_000): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;

function supportsSelectedEffort(model: ProviderModelCapability, reasoningEffort: ProviderReasoningEffort | null): boolean {
  return model.availability === "available" &&
    (reasoningEffort === null ||
      (model.supportedReasoningEfforts.includes(reasoningEffort) &&
        typeof model.reasoningMappings[reasoningEffort] === "string"));
}

function criticPrompt(task: string, assignment: string, evidence: readonly ConsiliumEvidence[]): string {
  const evidenceText = evidence.map((item) => `Роль: ${item.fromRole}\nПовна репліка:\n${item.body}`).join("\n\n---\n\n");
  return [
    "Ви — незалежний критик бізнес-консиліуму.",
    `Ділове доручення від Головного консультанта:\n${assignment}`,
    `Завдання власника:\n${task}`,
    `Повні первинні репліки агентів:\n${evidenceText}`,
    "Перевірте припущення, суперечності, ризики й відсутні дані. Дайте одну повну критичну репліку для головного консультанта. Не скорочуйте її, не показуйте прихований хід міркувань, не додавайте технічних ідентифікаторів і не імітуйте зовнішніх дій."
  ].join("\n\n");
}

/**
 * Separate Claude Code critic boundary. Every turn rechecks the process state
 * before sending content, so an expired OAuth login, Fast Mode, API/PAYG path,
 * bare mode, model drift or effort downgrade stops the critique fail-closed.
 */
export class ClaudeCodeCriticRuntime implements ConsiliumAgentRuntime {
  readonly registration: AgentRegistration;
  readonly #process: ClaudeCodeSubscriptionProcess;
  readonly #headAgentId: string;
  readonly #modelId: string;
  readonly #reasoningEffort: ProviderReasoningEffort | null;
  readonly #signal: AbortSignal | undefined;

  constructor(input: ClaudeCodeCriticRuntimeInput) {
    if (input.registration.provider !== "claude_code" || !isExternalRuntimeId(input.registration.runtimeSessionRef) || !isAgentId(input.headAgentId)) {
      throw new Error("A Claude critic needs a separate registered process reference.");
    }
    this.registration = input.registration;
    this.#process = input.process;
    this.#headAgentId = input.headAgentId;
    this.#modelId = input.modelId;
    this.#reasoningEffort = input.reasoningEffort;
    this.#signal = input.signal;
  }

  async run(input: ConsiliumRuntimeInput, emit: (message: RuntimeEmission) => Promise<void>): Promise<void> {
    if (this.#signal?.aborted || input.phase !== "critique" || !nonEmpty(input.task) || !nonEmpty(input.assignment) || input.evidence.length < 2) {
      throw new SafeConsiliumFailure("invalid_runtime_emission");
    }
    let status: ClaudeCodeSubscriptionStatus;
    try {
      status = await this.#process.inspectSubscription();
    } catch {
      throw new SafeConsiliumFailure("claude_status_unavailable");
    }
    const eligibilityFailure = this.#eligibilityFailure(status);
    if (eligibilityFailure !== undefined) throw new SafeConsiliumFailure(eligibilityFailure, status.resetAt);
    const model = status.models.find((candidate) => candidate.productId === this.#modelId);
    if (model === undefined || !supportsSelectedEffort(model, this.#reasoningEffort)) {
      throw new SafeConsiliumFailure(model === undefined ? "claude_model_not_available" : "claude_effort_unavailable");
    }
    const completed = await this.#process.runCritique({
      modelId: model.productId,
      runtimeModelId: model.runtimeModelId,
      reasoningEffort: this.#reasoningEffort,
      prompt: input.consensus === undefined ? criticPrompt(input.task, input.assignment, input.evidence) : consensusPrompt(this.registration.role, input),
      ...(this.#signal === undefined ? {} : { signal: this.#signal })
    });
    const messageId = await deriveInternalEventId("claude", completed.turnRef);
    if (this.#signal?.aborted || messageId === undefined || !nonEmpty(completed.body)) {
      throw new SafeConsiliumFailure("claude_invalid_completion");
    }
    const content = input.consensus === undefined ? { body: completed.body } : parseConsensusOutput(completed.body, input);
    if (content === undefined) throw new SafeConsiliumFailure("claude_invalid_completion");
    await emit({
      messageId,
      kind: "critique",
      toAgentId: this.#headAgentId,
      ...content
    });
  }

  #eligibilityFailure(status: ClaudeCodeSubscriptionStatus): ConsiliumFailureCause | undefined {
    if (status.processRef !== this.registration.runtimeSessionRef || !status.privateSingleOwner) return "private_boundary_failed";
    if (status.authMode !== "claude_code_oauth" || status.bareMode) return "claude_auth_mode_invalid";
    if (status.fastModeEnabled || status.extraUsageEnabled) return "claude_paid_acceleration_forbidden";
    if (status.readiness === "auth_required") return "claude_auth_required";
    if (status.readiness === "quota_blocked") return "claude_quota_blocked";
    if (status.readiness !== "ready") return "claude_unavailable";
    return undefined;
  }
}
