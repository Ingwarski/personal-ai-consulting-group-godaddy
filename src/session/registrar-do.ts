import type { EffectiveSessionSnapshot } from "../settings/types.ts";
import { isInternalEventId, isSessionId } from "../identity/ids.ts";
import type { RegistrarStorage } from "./storage.ts";

const ACTIVE_SESSION_KEY = "registrar:active-session";
const GENERATION_KEY = "registrar:generation";
const sessionKey = (generation: number): string => `registrar:session:${generation}`;
const messageKey = (generation: number, sequence: number): string =>
  `registrar:message:${generation}:${sequence}`;
const eventKey = (eventId: string): string => `registrar:event:${eventId}`;
const criticReviewKey = (generation: number): string => `registrar:critic-review:${generation}`;
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
  input: Readonly<{ generation: number; reason: "stopped" | "new_task"; fencedAt: string }>
) => Promise<void>;

type EventLedgerEntry = Readonly<{
  bodyHash: string;
  message: ConfirmedAgentMessage;
}>;

export type CriticReviewReceipt = Readonly<{
  generation: number;
  eventId: string;
  role: string;
  registeredAt: string;
}>;

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
}>): Promise<string> {
  return hashValue({
    role: input.role,
    body: input.body,
    addressedTo: input.addressedTo ?? null,
    replyToEventId: input.replyToEventId ?? null
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
  }>): Promise<RegistrarResult<ConfirmedAgentMessage>> {
    if (
      !isInternalEventId(input.eventId) || !isVisibleRole(input.role) || input.body.length === 0 ||
      utf8Length(input.body) > 65_536
    ) {
      return { ok: false, code: "invalid_event" };
    }

    const immutableBody = input.body;
    const bodyHash = await confirmedMessageFingerprint(input);
    return this.#storage.transaction(async (storage) => {
      const recordedEvent = await storage.get<EventLedgerEntry>(eventKey(input.eventId));
      if (recordedEvent !== undefined) {
        if (recordedEvent.bodyHash !== bodyHash) return { ok: false, code: "idempotency_conflict" };
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
        confirmedAt: now.toISOString()
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
        await storage.put(eventKey(controlMessage.internalEventId), { bodyHash, message: controlMessage });
        await this.#projectConfirmedMessage(storage, controlRecord);
      }
      await storage.put(sessionKey(generation), stopped);
      await storage.put(ACTIVE_SESSION_KEY, stopped);
      return { ok: true, value: stopped, replayed: false };
    });
  }

  async recordCriticReview(input: Readonly<{
    generation: number;
    eventId: string;
    role: string;
  }>): Promise<RegistrarResult<CriticReviewReceipt>> {
    if (!isInternalEventId(input.eventId) || !isVisibleRole(input.role)) {
      return { ok: false, code: "invalid_event" };
    }

    return this.#storage.transaction(async (storage) => {
      const existing = await storage.get<CriticReviewReceipt>(criticReviewKey(input.generation));
      if (existing !== undefined) return { ok: true, value: existing, replayed: true };

      const event = await storage.get<EventLedgerEntry>(eventKey(input.eventId));
      if (event === undefined || event.message.generation !== input.generation || event.message.role !== input.role) {
        return { ok: false, code: "invalid_event" };
      }

      const receipt = deepFreeze({
        generation: input.generation,
        eventId: input.eventId,
        role: input.role,
        registeredAt: this.#now().toISOString()
      });
      await storage.put(criticReviewKey(input.generation), receipt);
      return { ok: true, value: receipt, replayed: false };
    });
  }

  async getCriticReview(generation: number): Promise<CriticReviewReceipt | undefined> {
    return this.#storage.get<CriticReviewReceipt>(criticReviewKey(generation));
  }

  async getActiveSession(): Promise<SessionGeneration | undefined> {
    return this.#storage.get<SessionGeneration>(ACTIVE_SESSION_KEY);
  }

  async getConfirmedMessages(generation: number): Promise<readonly ConfirmedAgentMessage[]> {
    const session = await this.#storage.get<SessionGeneration>(sessionKey(generation));
    if (session === undefined) return Object.freeze([]);

    const messages = await Promise.all(
      Array.from({ length: session.nextSequence - 1 }, async (_, index) =>
        this.#storage.get<ConfirmedAgentMessage>(messageKey(generation, index + 1))
      )
    );
    return deepFreeze(messages.filter((message): message is ConfirmedAgentMessage => message !== undefined));
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
