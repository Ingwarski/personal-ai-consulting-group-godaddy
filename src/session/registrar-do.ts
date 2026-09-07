import type { EffectiveSessionSnapshot } from "../settings/types.ts";
import { isAgentId, isExternalRuntimeId, isInternalEventId, isSessionId } from "../identity/ids.ts";
import type { AgentRegistration } from "../consilium/roster.ts";
import type { RegistrarStorage } from "./storage.ts";

const ACTIVE_SESSION_KEY = "registrar:active-session";
const GENERATION_KEY = "registrar:generation";
const sessionKey = (generation: number): string => `registrar:session:${generation}`;
const controlSequenceKey = (generation: number): string => `registrar:control-sequence:${generation}`;
const revisionKey = (revisionId: string): string => `registrar:revision:${revisionId}`;
const messageKey = (generation: number, sequence: number): string =>
  `registrar:message:${generation}:${sequence}`;
const eventKey = (eventId: string): string => `registrar:event:${eventId}`;
const criticReviewKey = (generation: number): string => `registrar:critic-review:${generation}`;
const criticBindingKey = (generation: number): string => `registrar:critic-binding:${generation}`;
const matrixOutboxKey = (generation: number, sequence: number): string =>
  `registrar:matrix-outbox:${generation}:${sequence}`;

export type SessionPhase = "active" | "stopped" | "closed";

export type SessionGeneration = Readonly<{
  sessionId: string;
  generation: number;
  phase: SessionPhase;
  startedAt: string;
  stoppedAt?: string;
  closedAt?: string;
  previousGeneration?: number;
  settingsSnapshot: EffectiveSessionSnapshot;
  nextSequence: number;
}>;

export type ConfirmedAgentMessage = Readonly<{
  generation: number;
  sequence: number;
  internalEventId: string;
  role: string;
  visibleTime: string;
  body: string;
  bodyFormat: "markdown";
  addressedTo?: string;
  bodyHash: string;
  confirmedAt: string;
  authority?: ConfirmedAgentAuthority;
}>;

export type ConfirmedAgentAuthority = Readonly<{
  agentId: string;
  provider: "codex" | "claude_code";
  runtimeSessionRef: string;
  kind: "assignment" | "initial_position" | "question" | "answer" | "critique" | "revision";
}>;

export type DesignatedCriticBinding = AgentRegistration & Readonly<{
  schemaVersion: "1";
  sessionId: string;
  generation: number;
}>;

export type MatrixOutboxState = "pending" | "leased" | "accepted" | "device_delivered" | "read" | "blocked" | "cancelled";

export type MatrixOutboxRecord = Readonly<{
  generation: number;
  sequence: number;
  transactionId: string;
  state: MatrixOutboxState;
  kind: "message" | "control";
  message: ConfirmedAgentMessage;
  replyToEventId?: string;
  createdAt: string;
}>;

export type ConfirmedMessageOutboxProjection = (
  storage: RegistrarStorage,
  record: MatrixOutboxRecord
) => Promise<void>;

export type RegistrarGenerationFence = (
  storage: RegistrarStorage,
  input: Readonly<{ generation: number; reason: "stopped" | "new_task" | "revision"; fencedAt: string }>
) => Promise<void>;

type EventLedgerEntry = Readonly<{
  bodyHash: string;
  message: ConfirmedAgentMessage;
  /** Legacy entries without a kind are ordinary confirmed agent messages. */
  kind?: "message" | "control";
}>;

type ControlSequence = Readonly<{ generation: number; nextSequence: number }>;
type SessionRevision = Readonly<{ sourceGeneration: number; targetGeneration: number }>;

export type CriticReviewReceipt = DesignatedCriticBinding & Readonly<{
  eventId: string;
  bodyHash: string;
  sequence: number;
  registeredAt: string;
}>;

export function criticBindingMatches(receipt: DesignatedCriticBinding | undefined, critic: AgentRegistration, generation: number): boolean {
  return receipt?.schemaVersion === "1" && receipt.generation === generation &&
    receipt.agentId === critic.agentId && receipt.role === critic.role && receipt.provider === critic.provider &&
    receipt.runtimeSessionRef === critic.runtimeSessionRef;
}

export const criticReceiptMatches = criticBindingMatches;

export function isConfirmedAgentAuthority(value: unknown): value is ConfirmedAgentAuthority {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).length === 4 && Object.keys(fields).every((key) => ["agentId", "provider", "runtimeSessionRef", "kind"].includes(key)) &&
    isAgentId(fields.agentId) && (fields.provider === "codex" || fields.provider === "claude_code") && isExternalRuntimeId(fields.runtimeSessionRef) &&
    typeof fields.kind === "string" && ["assignment", "initial_position", "question", "answer", "critique", "revision"].includes(fields.kind);
}

export type RegistrarResult<T> =
  | Readonly<{ ok: true; value: T; replayed: boolean }>
  | Readonly<{
      ok: false;
      code:
        | "active_session_exists"
        | "no_active_session"
        | "obsolete_generation"
        | "session_not_active"
        | "invalid_session_id"
        | "invalid_event"
        | "idempotency_conflict";
    }>;

export type RegistrarOptions = Readonly<{
  storage: RegistrarStorage;
  now: () => Date;
  projectConfirmedMessage?: ConfirmedMessageOutboxProjection;
  fenceGeneration?: RegistrarGenerationFence;
}>;

export type StopSessionOptions = Readonly<{
  /** Publish the product-defined Stop notice after fencing message rows. */
  publishControl?: boolean;
}>;

export const matrixTransactionIdFor = (
  message: Pick<ConfirmedAgentMessage, "generation" | "sequence" | "bodyHash">
): string => `pc-${message.generation}-${message.sequence}-${message.bodyHash.slice(0, 24)}`;

const formatVisibleTime = (date: Date): string =>
  new Intl.DateTimeFormat("uk-UA", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Europe/Kyiv"
  }).format(date);

const isVisibleRole = (role: string): boolean => role.trim().length > 0 && role.length <= 160;

async function hashValue(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function confirmedMessageFingerprint(input: Readonly<{
  role: string;
  body: string;
  addressedTo?: string;
  replyToEventId?: string;
  authority?: ConfirmedAgentAuthority;
}>): Promise<string> {
  return hashValue({
    role: input.role,
    body: input.body,
    addressedTo: input.addressedTo ?? null,
    replyToEventId: input.replyToEventId ?? null,
    // JSON columns may reorder nested keys. Keep the existing producer order
    // explicitly so persisted agent identity still verifies after a DB read.
    ...(input.authority === undefined ? {} : { authority: {
      agentId: input.authority.agentId,
      provider: input.authority.provider,
      runtimeSessionRef: input.authority.runtimeSessionRef,
      kind: input.authority.kind
    } })
  });
}

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
    Object.freeze(value);
  }
  return value;
}

function immutableSnapshot(snapshot: EffectiveSessionSnapshot): EffectiveSessionSnapshot {
  return deepFreeze(structuredClone(snapshot));
}

export class RegistrarDO {
  readonly #storage: RegistrarStorage;
  readonly #now: () => Date;
  readonly #projectConfirmedMessage: ConfirmedMessageOutboxProjection;
  readonly #fenceGeneration: RegistrarGenerationFence;

  constructor(options: RegistrarOptions) {
    this.#storage = options.storage;
    this.#now = options.now;
    this.#projectConfirmedMessage = options.projectConfirmedMessage ?? (async (storage, record) => {
      await storage.put(matrixOutboxKey(record.generation, record.sequence), record);
    });
    this.#fenceGeneration = options.fenceGeneration ?? (async () => undefined);
  }

  async startSession(input: Readonly<{ sessionId: string; settingsSnapshot: EffectiveSessionSnapshot }>): Promise<RegistrarResult<SessionGeneration>> {
    if (!isSessionId(input.sessionId)) return { ok: false, code: "invalid_session_id" };

    return this.#storage.transaction(async (storage) => {
      const active = await storage.get<SessionGeneration>(ACTIVE_SESSION_KEY);
      if (active !== undefined && active.phase === "active") {
        if (active.sessionId === input.sessionId) return { ok: true, value: active, replayed: true };
        return { ok: false, code: "active_session_exists" };
      }
      return this.#createSession(storage, input.sessionId, input.settingsSnapshot);
    });
  }

  async startNewTask(input: Readonly<{ sessionId: string; settingsSnapshot: EffectiveSessionSnapshot }>): Promise<RegistrarResult<SessionGeneration>> {
    if (!isSessionId(input.sessionId)) return { ok: false, code: "invalid_session_id" };

    return this.#storage.transaction(async (storage) => {
      const active = await storage.get<SessionGeneration>(ACTIVE_SESSION_KEY);
      if (active !== undefined && active.sessionId === input.sessionId) {
        return { ok: true, value: active, replayed: true };
      }
      if (active !== undefined) {
        await this.#fenceGeneration(storage, {
          generation: active.generation,
          reason: "new_task",
          fencedAt: this.#now().toISOString()
        });
        const closed = Object.freeze({ ...active, phase: "closed" as const, closedAt: this.#now().toISOString() });
        await storage.put(sessionKey(active.generation), closed);
      }
      return this.#createSession(storage, input.sessionId, input.settingsSnapshot);
    });
  }

  async appendConfirmedMessage(input: Readonly<{
    generation: number;
    eventId: string;
    role: string;
    body: string;
    addressedTo?: string;
    replyToEventId?: string;
    authority?: ConfirmedAgentAuthority;
  }>): Promise<RegistrarResult<ConfirmedAgentMessage>> {
    if (
      !isInternalEventId(input.eventId) || !isVisibleRole(input.role) || input.body.length === 0 ||
      utf8Length(input.body) > 65_536 || (input.authority !== undefined && !isConfirmedAgentAuthority(input.authority))
    ) {
      return { ok: false, code: "invalid_event" };
    }

    const immutableBody = input.body;
    const bodyHash = await confirmedMessageFingerprint(input);
    return this.#storage.transaction(async (storage) => {
      const recordedEvent = await storage.get<EventLedgerEntry>(eventKey(input.eventId));
      if (recordedEvent !== undefined) {
        if (recordedEvent.message.generation !== input.generation) return { ok: false, code: "obsolete_generation" };
        if (recordedEvent.kind === "control" || recordedEvent.bodyHash !== bodyHash) return { ok: false, code: "idempotency_conflict" };
        return { ok: true, value: recordedEvent.message, replayed: true };
      }

      const active = await storage.get<SessionGeneration>(ACTIVE_SESSION_KEY);
      if (active === undefined) return { ok: false, code: "no_active_session" };
      if (active.generation !== input.generation) return { ok: false, code: "obsolete_generation" };
      if (active.phase !== "active") return { ok: false, code: "session_not_active" };

      const now = this.#now();
      const message: ConfirmedAgentMessage = deepFreeze({
        generation: active.generation,
        sequence: active.nextSequence,
        internalEventId: input.eventId,
        role: input.role,
        visibleTime: formatVisibleTime(now),
        body: immutableBody,
        bodyFormat: "markdown",
        ...(input.addressedTo === undefined ? {} : { addressedTo: input.addressedTo }),
        bodyHash,
        confirmedAt: now.toISOString(),
        ...(input.authority === undefined ? {} : { authority: input.authority })
      });
      const updated = Object.freeze({ ...active, nextSequence: active.nextSequence + 1 });
      const outboxRecord: MatrixOutboxRecord = deepFreeze({
        generation: message.generation,
        sequence: message.sequence,
        transactionId: matrixTransactionIdFor(message),
        state: "pending",
        kind: "message",
        message,
        ...(input.replyToEventId === undefined ? {} : { replyToEventId: input.replyToEventId }),
        createdAt: now.toISOString()
      });
      await storage.put(messageKey(active.generation, message.sequence), message);
      await storage.put(eventKey(input.eventId), { bodyHash, message });
      await storage.put(sessionKey(active.generation), updated);
      await storage.put(ACTIVE_SESSION_KEY, updated);
      await this.#projectConfirmedMessage(storage, outboxRecord);
      return { ok: true, value: message, replayed: false };
    });
  }

  /**
   * Trusted composition-only operational notices. This does not give an agent
   * authority to publish after Stop or to satisfy a Critic review. Before the
   * first consultation, a private sequence reserves a global generation without
   * inventing an active session or a settings snapshot.
   */
  async appendControlNotice(input: Readonly<{
    eventId: string;
    body: string;
    replyToEventId?: string;
  }>): Promise<RegistrarResult<ConfirmedAgentMessage>> {
    if (
      !isInternalEventId(input.eventId) || typeof input.body !== "string" || input.body.length === 0 ||
      utf8Length(input.body) > 65_536 || Object.keys(input).some((key) => !["eventId", "body", "replyToEventId"].includes(key)) ||
      (input.replyToEventId !== undefined && !/^\$[A-Za-z0-9$:_-]{8,255}$/.test(input.replyToEventId))
    ) return { ok: false, code: "invalid_event" };

    const controlInput = {
      role: "Система", body: input.body,
      ...(input.replyToEventId === undefined ? {} : { replyToEventId: input.replyToEventId })
    };
    const bodyHash = await confirmedMessageFingerprint(controlInput);
    return this.#storage.transaction(async (storage) => {
      const recorded = await storage.get<EventLedgerEntry>(eventKey(input.eventId));
      if (recorded !== undefined) return recorded.kind === "control" && recorded.bodyHash === bodyHash
        ? { ok: true, value: recorded.message, replayed: true }
        : { ok: false, code: "idempotency_conflict" };

      const active = await storage.get<SessionGeneration>(ACTIVE_SESSION_KEY);
      let sequence: ControlSequence;
      if (active !== undefined) {
        sequence = active;
      } else {
        const priorGeneration = (await storage.get<number>(GENERATION_KEY)) ?? 0;
        const privateSequence = await storage.get<ControlSequence>(controlSequenceKey(priorGeneration));
        sequence = privateSequence ?? { generation: priorGeneration + 1, nextSequence: 1 };
        if (privateSequence === undefined) await storage.put(GENERATION_KEY, sequence.generation);
      }

      const now = this.#now();
      const message: ConfirmedAgentMessage = deepFreeze({
        generation: sequence.generation,
        sequence: sequence.nextSequence,
        internalEventId: input.eventId,
        role: controlInput.role,
        visibleTime: formatVisibleTime(now),
        body: controlInput.body,
        bodyFormat: "markdown",
        bodyHash,
        confirmedAt: now.toISOString()
      });
      const outboxRecord: MatrixOutboxRecord = deepFreeze({
        generation: message.generation,
        sequence: message.sequence,
        transactionId: matrixTransactionIdFor(message),
        state: "pending",
        kind: "control",
        message,
        ...(input.replyToEventId === undefined ? {} : { replyToEventId: input.replyToEventId }),
        createdAt: now.toISOString()
      });
      await storage.put(messageKey(message.generation, message.sequence), message);
      await storage.put(eventKey(input.eventId), { kind: "control", bodyHash, message });
      if (active !== undefined) {
        const updated = Object.freeze({ ...active, nextSequence: active.nextSequence + 1 });
        await storage.put(sessionKey(active.generation), updated);
        await storage.put(ACTIVE_SESSION_KEY, updated);
      } else {
        await storage.put(controlSequenceKey(sequence.generation), { ...sequence, nextSequence: sequence.nextSequence + 1 });
      }
      await this.#projectConfirmedMessage(storage, outboxRecord);
      return { ok: true, value: message, replayed: false };
    });
  }

  /** Normal completion rejects late appends but preserves already-confirmed delivery. */
  async closeSession(generation: number): Promise<RegistrarResult<SessionGeneration>> {
    return this.#storage.transaction(async (storage) => {
      const active = await storage.get<SessionGeneration>(ACTIVE_SESSION_KEY);
      if (active === undefined) return { ok: false, code: "no_active_session" };
      if (active.generation !== generation) return { ok: false, code: "obsolete_generation" };
      if (active.phase === "closed") return { ok: true, value: active, replayed: true };
      if (active.phase !== "active") return { ok: false, code: "session_not_active" };
      const closed = Object.freeze({ ...active, phase: "closed" as const, closedAt: this.#now().toISOString() });
      await storage.put(sessionKey(generation), closed);
      await storage.put(ACTIVE_SESSION_KEY, closed);
      return { ok: true, value: closed, replayed: false };
    });
  }

  /**
   * An owner-authorized clarification or continuation keeps its logical session
   * and immutable settings, but fences old runtime output. Composition must
   * abort/drain the old runner before calling this. Stop is never undone here.
   */
  async reviseSession(input: Readonly<{
    generation: number;
    revisionId: string;
  }>): Promise<RegistrarResult<SessionGeneration>> {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1 || !isInternalEventId(input.revisionId)) {
      return { ok: false, code: "invalid_event" };
    }
    return this.#storage.transaction(async (storage) => {
      const recorded = await storage.get<SessionRevision>(revisionKey(input.revisionId));
      if (recorded !== undefined) {
        if (recorded.sourceGeneration !== input.generation) return { ok: false, code: "idempotency_conflict" };
        const replacement = await storage.get<SessionGeneration>(sessionKey(recorded.targetGeneration));
        if (replacement === undefined) throw new Error("Registrar revision session is missing.");
        return { ok: true, value: replacement, replayed: true };
      }
      const active = await storage.get<SessionGeneration>(ACTIVE_SESSION_KEY);
      if (active === undefined) return { ok: false, code: "no_active_session" };
      if (active.generation !== input.generation) return { ok: false, code: "obsolete_generation" };
      if (active.phase !== "active" && active.phase !== "closed") return { ok: false, code: "session_not_active" };

      const now = this.#now().toISOString();
      await this.#fenceGeneration(storage, { generation: active.generation, reason: "revision", fencedAt: now });
      const priorGeneration = (await storage.get<number>(GENERATION_KEY)) ?? active.generation;
      const replacement: SessionGeneration = deepFreeze({
        sessionId: active.sessionId,
        generation: priorGeneration + 1,
        previousGeneration: active.generation,
        phase: "active",
        startedAt: active.startedAt,
        settingsSnapshot: immutableSnapshot(active.settingsSnapshot),
        nextSequence: 1
      });
      const closed = Object.freeze({ ...active, phase: "closed" as const, closedAt: active.closedAt ?? now });
      await storage.put(sessionKey(active.generation), closed);
      await storage.put(GENERATION_KEY, replacement.generation);
      await storage.put(sessionKey(replacement.generation), replacement);
      await storage.put(ACTIVE_SESSION_KEY, replacement);
      await storage.put(revisionKey(input.revisionId), { sourceGeneration: active.generation, targetGeneration: replacement.generation });
      return { ok: true, value: replacement, replayed: false };
    });
  }

  async stopSession(
    generation: number,
    options: StopSessionOptions = {}
  ): Promise<RegistrarResult<SessionGeneration>> {
    return this.#storage.transaction(async (storage) => {
      const active = await storage.get<SessionGeneration>(ACTIVE_SESSION_KEY);
      if (active === undefined) return { ok: false, code: "no_active_session" };
      if (active.generation !== generation) return { ok: false, code: "obsolete_generation" };
      if (active.phase === "stopped") return { ok: true, value: active, replayed: true };
      if (active.phase !== "active") return { ok: false, code: "session_not_active" };

      const now = this.#now();
      await this.#fenceGeneration(storage, { generation, reason: "stopped", fencedAt: now.toISOString() });
      const stopped = Object.freeze({
        ...active,
        phase: "stopped" as const,
        stoppedAt: now.toISOString(),
        nextSequence: active.nextSequence + (options.publishControl === true ? 1 : 0)
      });
      if (options.publishControl === true) {
        const controlInput = {
          role: "Система",
          body: "Сесію зупинено. Нові відповіді для цієї сесії не публікуються."
        } as const;
        const bodyHash = await confirmedMessageFingerprint(controlInput);
        const controlMessage: ConfirmedAgentMessage = deepFreeze({
          generation,
          sequence: active.nextSequence,
          internalEventId: `control-stop-event-${generation}`,
          role: controlInput.role,
          visibleTime: formatVisibleTime(now),
          body: controlInput.body,
          bodyFormat: "markdown",
          bodyHash,
          confirmedAt: now.toISOString()
        });
        const controlRecord: MatrixOutboxRecord = deepFreeze({
          generation,
          sequence: controlMessage.sequence,
          transactionId: matrixTransactionIdFor(controlMessage),
          state: "pending",
          kind: "control",
          message: controlMessage,
          createdAt: now.toISOString()
        });
        await storage.put(messageKey(generation, controlMessage.sequence), controlMessage);
        await storage.put(eventKey(controlMessage.internalEventId), { kind: "control", bodyHash, message: controlMessage });
        await this.#projectConfirmedMessage(storage, controlRecord);
      }
      await storage.put(sessionKey(generation), stopped);
      await storage.put(ACTIVE_SESSION_KEY, stopped);
      return { ok: true, value: stopped, replayed: false };
    });
  }

  /** Trusted composition records the actual runtime identity before any critique. */
  async designateCritic(input: Readonly<{ generation: number; critic: AgentRegistration }>): Promise<RegistrarResult<DesignatedCriticBinding>> {
    if (!isConfirmedAgentAuthority({ agentId: input.critic.agentId, provider: input.critic.provider, runtimeSessionRef: input.critic.runtimeSessionRef, kind: "critique" }) || !isVisibleRole(input.critic.role)) return { ok: false, code: "invalid_event" };
    return this.#storage.transaction(async (storage) => {
      const active = await storage.get<SessionGeneration>(ACTIVE_SESSION_KEY);
      if (active === undefined) return { ok: false, code: "no_active_session" };
      if (active.generation !== input.generation) return { ok: false, code: "obsolete_generation" };
      if (active.phase !== "active") return { ok: false, code: "session_not_active" };
      // Old immutable snapshots retain their historical Claude meaning.
      const settings = active.settingsSnapshot.settings;
      const provider = "critic" in settings ? settings.critic.provider : "claude_code";
      if (input.critic.provider !== provider) return { ok: false, code: "invalid_event" };
      const binding = deepFreeze({ schemaVersion: "1" as const, sessionId: active.sessionId, generation: input.generation, ...input.critic });
      const existing = await storage.get<DesignatedCriticBinding>(criticBindingKey(input.generation));
      if (existing !== undefined) return JSON.stringify(existing) === JSON.stringify(binding)
        ? { ok: true, value: existing, replayed: true } : { ok: false, code: "idempotency_conflict" };
      await storage.put(criticBindingKey(input.generation), binding);
      return { ok: true, value: binding, replayed: false };
    });
  }

  async getDesignatedCritic(generation: number): Promise<DesignatedCriticBinding | undefined> {
    return this.#storage.get<DesignatedCriticBinding>(criticBindingKey(generation));
  }

  async recordCriticReview(input: Readonly<{
    generation: number;
    eventId: string;
    critic: AgentRegistration;
  }>): Promise<RegistrarResult<CriticReviewReceipt>> {
    if (!isInternalEventId(input.eventId) || input.critic === undefined || !isVisibleRole(input.critic.role)) {
      return { ok: false, code: "invalid_event" };
    }

    return this.#storage.transaction(async (storage) => {
      const active = await storage.get<SessionGeneration>(ACTIVE_SESSION_KEY);
      if (active === undefined) return { ok: false, code: "no_active_session" };
      if (active.generation !== input.generation) return { ok: false, code: "obsolete_generation" };
      if (active.phase !== "active") return { ok: false, code: "session_not_active" };
      const binding = await storage.get<DesignatedCriticBinding>(criticBindingKey(input.generation));
      if (binding === undefined || binding.sessionId !== active.sessionId || !criticBindingMatches(binding, input.critic, input.generation)) {
        return { ok: false, code: "invalid_event" };
      }
      const existing = await storage.get<CriticReviewReceipt>(criticReviewKey(input.generation));
      if (existing !== undefined) return criticReceiptMatches(existing, input.critic, input.generation) && existing.eventId === input.eventId
        ? { ok: true, value: existing, replayed: true } : { ok: false, code: "idempotency_conflict" };

      const event = await storage.get<EventLedgerEntry>(eventKey(input.eventId));
      const authority = event?.message.authority;
      if (event === undefined || event.message.generation !== input.generation || event.message.role !== input.critic.role ||
        authority?.kind !== "critique" || authority.agentId !== binding.agentId || authority.provider !== binding.provider ||
        authority.runtimeSessionRef !== binding.runtimeSessionRef) {
        return { ok: false, code: "invalid_event" };
      }

      const receipt = deepFreeze({
        ...binding,
        eventId: input.eventId,
        bodyHash: event.message.bodyHash,
        sequence: event.message.sequence,
        registeredAt: this.#now().toISOString()
      });
      await storage.put(criticReviewKey(input.generation), receipt);
      return { ok: true, value: receipt, replayed: false };
    });
  }

  async getCriticReview(generation: number): Promise<CriticReviewReceipt | undefined> {
    const active = await this.getActiveSession();
    if (active?.generation !== generation || active.phase !== "active") return undefined;
    const receipt = await this.#storage.get<CriticReviewReceipt>(criticReviewKey(generation));
    const binding = await this.getDesignatedCritic(generation);
    if (binding === undefined || receipt?.sessionId !== active.sessionId || !criticReceiptMatches(receipt, binding, generation)) return undefined;
    const event = await this.#storage.get<EventLedgerEntry>(eventKey(receipt!.eventId));
    const message = event?.message;
    const canonical = await this.#storage.get<ConfirmedAgentMessage>(messageKey(generation, receipt!.sequence));
    if (message === undefined || canonical === undefined || JSON.stringify(canonical) !== JSON.stringify(message) ||
      message.role !== binding.role || await confirmedMessageFingerprint(message) !== message.bodyHash) return undefined;
    return message.generation === generation && message.sequence === receipt!.sequence && message.bodyHash === receipt!.bodyHash &&
      message.authority?.kind === "critique" && message.authority.agentId === binding.agentId &&
      message.authority.provider === binding.provider && message.authority.runtimeSessionRef === binding.runtimeSessionRef ? receipt : undefined;
  }

  async getActiveSession(): Promise<SessionGeneration | undefined> {
    return this.#storage.get<SessionGeneration>(ACTIVE_SESSION_KEY);
  }

  async getSession(generation: number): Promise<SessionGeneration | undefined> {
    return this.#storage.get<SessionGeneration>(sessionKey(generation));
  }

  async getConfirmedMessages(generation: number): Promise<readonly ConfirmedAgentMessage[]> {
    const sequenceState = await this.#storage.get<SessionGeneration>(sessionKey(generation))
      ?? await this.#storage.get<ControlSequence>(controlSequenceKey(generation));
    if (sequenceState === undefined) return Object.freeze([]);

    // The shared database pool also serves Settings and the Matrix pumps.
    // Keep a transcript read to one outstanding query regardless of its size,
    // preserving queue capacity for those other operations and canonical order.
    const messages: ConfirmedAgentMessage[] = [];
    for (let sequence = 1; sequence < sequenceState.nextSequence; sequence += 1) {
      const message = await this.#storage.get<ConfirmedAgentMessage>(messageKey(generation, sequence));
      if (message !== undefined) messages.push(message);
    }
    return deepFreeze(messages);
  }

  /**
   * Local/domain-test inspection for the default RegistrarStorage projection.
   * The GoDaddy runtime replaces that projection with the dedicated MySQL
   * outbox table and consumes it only through runtime.matrixOutbox.
   */
  async getLocalMatrixOutboxRecordForTest(generation: number, sequence: number): Promise<MatrixOutboxRecord | undefined> {
    return this.#storage.get<MatrixOutboxRecord>(matrixOutboxKey(generation, sequence));
  }

  async #createSession(
    storage: RegistrarStorage,
    sessionId: string,
    settingsSnapshot: EffectiveSessionSnapshot
  ): Promise<RegistrarResult<SessionGeneration>> {
    const priorGeneration = (await storage.get<number>(GENERATION_KEY)) ?? 0;
    const generation = priorGeneration + 1;
    const session = deepFreeze({
      sessionId,
      generation,
      phase: "active" as const,
      startedAt: this.#now().toISOString(),
      settingsSnapshot: immutableSnapshot(settingsSnapshot),
      nextSequence: 1
    });
    await storage.put(GENERATION_KEY, generation);
    await storage.put(sessionKey(generation), session);
    await storage.put(ACTIVE_SESSION_KEY, session);
    return { ok: true, value: session, replayed: false };
  }
}
