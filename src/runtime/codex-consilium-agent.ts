import type { ConsiliumAgentRuntime, ConsiliumEvidence, ConsiliumPhase, RuntimeEmission } from "../consilium/router.ts";
import type { AgentRegistration } from "../consilium/roster.ts";
import type { ProviderReasoningEffort } from "../settings/types.ts";
import { CodexAppServerThreadClient, type CodexThreadLease } from "./codex-thread-client.ts";
import { deriveInternalEventId } from "../identity/ids.ts";
import { SafeConsiliumFailure } from "../consilium/failures.ts";

const nonEmpty = (value: string, maximum = 32_000): boolean => value.trim().length > 0 && value.length <= maximum;

export type CodexConsiliumAgentRuntimeInput = Readonly<{
  registration: AgentRegistration;
  lease: CodexThreadLease;
  threadClient: CodexAppServerThreadClient;
  criticAgentId: string;
  headAgentId: string;
  reasoningEffort: ProviderReasoningEffort | null;
}>;

function buildPrompt(input: Readonly<{
  role: string;
  phase: ConsiliumPhase;
  task: string;
  assignment: string;
  evidence: readonly ConsiliumEvidence[];
}>): string {
  const evidence = input.evidence.length === 0
    ? "Немає: сформулюйте незалежну первинну позицію."
    : input.evidence.map((item) => `Роль: ${item.fromRole}\nПовна репліка:\n${item.body}`).join("\n\n---\n\n");
  return [
    `Ви — ${input.role} у приватному бізнес-консиліумі.`,
    `Ділове доручення від Головного консультанта:\n${input.assignment}`,
    `Завдання власника:\n${input.task}`,
    `Фаза: ${input.phase}.`,
    "Дайте одну повну професійну репліку для інших учасників. Не скорочуйте її, не додавайте технічних ідентифікаторів, не описуйте прихований хід міркувань і не вдавайте зовнішніх дій.",
    `Докази від інших ролей:\n${evidence}`
  ].join("\n\n");
}

/**
 * One concrete Codex app-server thread per registered role. Registration is
 * refused when a label merely pretends to be an app-server context.
 */
export class CodexConsiliumAgentRuntime implements ConsiliumAgentRuntime {
  readonly registration: AgentRegistration;
  readonly #lease: CodexThreadLease;
  readonly #threadClient: CodexAppServerThreadClient;
  readonly #criticAgentId: string;
  readonly #headAgentId: string;
  readonly #reasoningEffort: ProviderReasoningEffort | null;

  constructor(input: CodexConsiliumAgentRuntimeInput) {
    if (input.registration.provider !== "codex" || input.registration.runtimeSessionRef !== input.lease.threadId) {
      throw new Error("A Codex registration must reference its own real app-server thread.");
    }
    this.registration = input.registration;
    this.#lease = input.lease;
    this.#threadClient = input.threadClient;
    this.#criticAgentId = input.criticAgentId;
    this.#headAgentId = input.headAgentId;
    this.#reasoningEffort = input.reasoningEffort;
  }

  async run(input: Readonly<{
    phase: ConsiliumPhase;
    sessionGeneration: number;
    task: string;
    assignment: string;
    evidence: readonly ConsiliumEvidence[];
  }>, emit: (message: RuntimeEmission) => Promise<void>): Promise<void> {
    if ((input.phase !== "initial_position" && input.phase !== "revision") || !nonEmpty(input.task) || !nonEmpty(input.assignment)) {
      throw new SafeConsiliumFailure("invalid_runtime_emission");
    }
    const result = await this.#threadClient.runTextTurn({
      lease: this.#lease,
      body: buildPrompt({ role: this.registration.role, phase: input.phase, task: input.task, assignment: input.assignment, evidence: input.evidence }),
      reasoningEffort: this.#reasoningEffort
    });
    if (!result.ok) throw new SafeConsiliumFailure(`codex_${result.code}`);
    if (!nonEmpty(result.body)) throw new SafeConsiliumFailure("invalid_runtime_emission");
    const messageId = await deriveInternalEventId("codex", result.turnId);
    if (messageId === undefined) throw new SafeConsiliumFailure("invalid_message_id");
    await emit({
      messageId,
      kind: input.phase === "initial_position" ? "initial_position" : "revision",
      toAgentId: input.phase === "initial_position" ? this.#criticAgentId : this.#headAgentId,
      body: result.body
    });
  }
}

/**
 * The head's real thread is reserved for the post-critic synthesis stage. It
 * is registered with the router now, but cannot accidentally impersonate a
 * specialist during the independent-first-pass phase.
 */
export class CodexHeadThreadRuntime implements ConsiliumAgentRuntime {
  readonly registration: AgentRegistration;

  constructor(input: Readonly<{ registration: AgentRegistration; lease: CodexThreadLease }>) {
    if (input.registration.provider !== "codex" || input.registration.runtimeSessionRef !== input.lease.threadId) {
      throw new Error("The head registration must reference its own real app-server thread.");
    }
    this.registration = input.registration;
  }

  async run(): Promise<void> {
    throw new Error("The head thread cannot run before the registered Claude critique.");
  }
}
