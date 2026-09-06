import type {
  ConfirmedAgentMessage,
  CriticReviewReceipt,
  DesignatedCriticBinding,
  RegistrarResult,
  SessionGeneration
} from "../session/registrar-do.ts";
import { RegistrarDO } from "../session/registrar-do.ts";
import type { EffectiveSessionSnapshot } from "../settings/types.ts";
import { DurableObjectKeyValueStorage } from "./durable-object-storage.ts";

export type RegistrarDurableObjectRpc = Readonly<{
  startSession: (input: Readonly<{ sessionId: string; settingsSnapshot: EffectiveSessionSnapshot }>) => Promise<RegistrarResult<SessionGeneration>>;
  startNewTask: (input: Readonly<{ sessionId: string; settingsSnapshot: EffectiveSessionSnapshot }>) => Promise<RegistrarResult<SessionGeneration>>;
  appendConfirmedMessage: (input: Parameters<RegistrarDO["appendConfirmedMessage"]>[0]) => Promise<RegistrarResult<ConfirmedAgentMessage>>;
  stopSession: (generation: number) => Promise<RegistrarResult<SessionGeneration>>;
  designateCritic: (input: Parameters<RegistrarDO["designateCritic"]>[0]) => Promise<RegistrarResult<DesignatedCriticBinding>>;
  getDesignatedCritic: (generation: number) => Promise<DesignatedCriticBinding | undefined>;
  recordCriticReview: (input: Parameters<RegistrarDO["recordCriticReview"]>[0]) => Promise<RegistrarResult<CriticReviewReceipt>>;
  getCriticReview: (generation: number) => Promise<CriticReviewReceipt | undefined>;
  getActiveSession: () => Promise<SessionGeneration | undefined>;
  getConfirmedMessages: (generation: number) => Promise<readonly ConfirmedAgentMessage[]>;
}>;

/**
 * The one production Durable Object behind the owner session. It is deliberately
 * a thin RPC adapter: session rules remain in `RegistrarDO`, while Cloudflare
 * provides the per-owner durable storage and serial execution boundary.
 *
 * This class is never exposed through a public HTTP route. Future Matrix bridge
 * and agent runtime bindings obtain its fixed instance by name and can only use
 * these append-only/session-lifecycle methods.
 */
export class RegistrarDurableObject implements RegistrarDurableObjectRpc {
  readonly #registrar: RegistrarDO;

  constructor(state: DurableObjectState) {
    this.#registrar = new RegistrarDO({
      storage: new DurableObjectKeyValueStorage(state.storage),
      now: () => new Date()
    });
  }

  startSession(input: Readonly<{ sessionId: string; settingsSnapshot: EffectiveSessionSnapshot }>) {
    return this.#registrar.startSession(input);
  }

  startNewTask(input: Readonly<{ sessionId: string; settingsSnapshot: EffectiveSessionSnapshot }>) {
    return this.#registrar.startNewTask(input);
  }

  appendConfirmedMessage(input: Parameters<RegistrarDO["appendConfirmedMessage"]>[0]) {
    return this.#registrar.appendConfirmedMessage(input);
  }

  stopSession(generation: number) {
    return this.#registrar.stopSession(generation);
  }

  designateCritic(input: Parameters<RegistrarDO["designateCritic"]>[0]) {
    return this.#registrar.designateCritic(input);
  }

  getDesignatedCritic(generation: number) {
    return this.#registrar.getDesignatedCritic(generation);
  }

  recordCriticReview(input: Parameters<RegistrarDO["recordCriticReview"]>[0]) {
    return this.#registrar.recordCriticReview(input);
  }

  getCriticReview(generation: number) {
    return this.#registrar.getCriticReview(generation);
  }

  getActiveSession() {
    return this.#registrar.getActiveSession();
  }

  getConfirmedMessages(generation: number) {
    return this.#registrar.getConfirmedMessages(generation);
  }
}
