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
}>;

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

  constructor(options: RegistrarOptions) {
    this.#storage = options.storage;
    this.#now = options.now;
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
  }>): Promise<RegistrarResult<ConfirmedAgentMessage>> {
    if (!isInternalEventId(input.eventId) || !isVisibleRole(input.role) || input.body.length === 0) {
      return { ok: false, code: "invalid_event" };
    }

    const immutableBody = input.body;
    const bodyHash = await hashValue({ role: input.role, body: immutableBody, addressedTo: input.addressedTo ?? null });
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
      await storage.put(messageKey(active.generation, message.sequence), message);
      await storage.put(eventKey(input.eventId), { bodyHash, message });
      await storage.put(sessionKey(active.generation), updated);
      await storage.put(ACTIVE_SESSION_KEY, updated);
      return { ok: true, value: message, replayed: false };
    });
  }

  async stopSession(generation: number): Promise<RegistrarResult<SessionGeneration>> {
    return this.#storage.transaction(async (storage) => {
      const active = await storage.get<SessionGeneration>(ACTIVE_SESSION_KEY);
      if (active === undefined) return { ok: false, code: "no_active_session" };
      if (active.generation !== generation) return { ok: false, code: "obsolete_generation" };
      if (active.phase === "stopped") return { ok: true, value: active, replayed: true };
      if (active.phase !== "active") return { ok: false, code: "session_not_active" };

      const stopped = Object.freeze({ ...active, phase: "stopped" as const, stoppedAt: this.#now().toISOString() });
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
