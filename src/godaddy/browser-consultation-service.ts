import { createHash, randomUUID } from "node:crypto";

import type { ArchiveService } from "../archive/archive-service.ts";
import type { SessionCloseObserver } from "../consilium/final-recommendation.ts";
import { containsSecretLikeContent } from "../security/content-policy.ts";
import type { EffectiveSessionSnapshot } from "../settings/types.ts";
import type { GoDaddyConsiliumRuntime } from "./consilium-runtime.ts";
import type { ConsultationLeadership } from "./consultation-leadership.ts";
import type { GoDaddyRegistrarRuntime } from "./registrar-runtime.ts";
import type { MySqlKeyValueStorage } from "./mysql-storage.ts";

export type BrowserConsultationStatus = "preparing" | "planning" | "running" | "completed" | "failed" | "stopped";
export type BrowserConsultationRecord = Readonly<{
  version: 1;
  requestId: string;
  sessionId: string;
  generation?: number;
  taskSha256: string;
  status: BrowserConsultationStatus;
  outcome?: "direct" | "clarification" | "consensus" | "unresolved" | "safety_handoff";
  archiveId?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type BrowserConsultationView = Readonly<{
  record: BrowserConsultationRecord;
  messages: Awaited<ReturnType<GoDaddyRegistrarRuntime["registrar"]["getConfirmedMessages"]>>;
}>;

const ACTIVE_KEY = "active";
const LATEST_KEY = "latest";
const recordKey = (requestId: string): string => `request-${requestId}`;
const validRequestId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/u.test(value);
const finished = (status: BrowserConsultationStatus): boolean => ["completed", "failed", "stopped"].includes(status);

export type BrowserConsultationService = Readonly<{
  submit: (input: Readonly<{ requestId?: string; task: string; consent: boolean }>) => Promise<
    | Readonly<{ ok: true; record: BrowserConsultationRecord; replayed: boolean }>
    | Readonly<{ ok: false; code: "invalid_request" | "consent_required" | "secret_detected" | "busy" | "runtime_unavailable" }>
  >;
  latest: () => Promise<BrowserConsultationView | undefined>;
  read: (requestId: string) => Promise<BrowserConsultationView | undefined>;
  stop: (requestId: string) => Promise<Readonly<{ ok: true; record: BrowserConsultationRecord }> | Readonly<{ ok: false; code: "not_found" | "not_running" }>>;
  start: () => Promise<void>;
  close: () => Promise<void>;
}>;

export function createBrowserConsultationService(input: Readonly<{
  storage: MySqlKeyValueStorage;
  registrarRuntime: GoDaddyRegistrarRuntime;
  executor: GoDaddyConsiliumRuntime;
  prepareSnapshot: (sessionId: string) => Promise<EffectiveSessionSnapshot | undefined>;
  archiveService: ArchiveService;
  archiveKey: CryptoKey;
  archiveBeforeClose: SessionCloseObserver;
  leadership: ConsultationLeadership;
  now?: () => Date;
}>): BrowserConsultationService {
  const now = input.now ?? (() => new Date());
  const running = new Map<string, Readonly<{ controller: AbortController; completion: Promise<void> }>>();
  let closing = false;
  let admitting = false;

  const save = async (record: BrowserConsultationRecord): Promise<void> => {
    await input.storage.transaction(async storage => {
      await storage.put(recordKey(record.requestId), record);
      await storage.put(LATEST_KEY, record.requestId);
      await storage.put(ACTIVE_KEY, finished(record.status) ? null : record.requestId);
    });
  };

  const update = async (record: BrowserConsultationRecord, patch: Partial<BrowserConsultationRecord>): Promise<BrowserConsultationRecord> => {
    const next = Object.freeze({ ...record, ...patch, updatedAt: now().toISOString() });
    await save(next);
    return next;
  };

  const seal = async (generation: number): Promise<string | undefined> => {
    const session = await input.registrarRuntime.registrar.getSession(generation);
    if (session === undefined) return undefined;
    const result = await input.archiveService.seal({
      session,
      messages: await input.registrarRuntime.registrar.getConfirmedMessages(generation),
      key: input.archiveKey
    });
    return result.ok ? result.archiveId : undefined;
  };

  const fail = async (record: BrowserConsultationRecord, errorCode: string): Promise<void> => {
    const current = await input.storage.get<BrowserConsultationRecord>(recordKey(record.requestId));
    if (current !== undefined) record = current;
    if (finished(record.status)) return;
    let archiveId: string | undefined;
    if (record.generation !== undefined) {
      await input.registrarRuntime.registrar.stopSession(record.generation).catch(() => undefined);
      archiveId = await seal(record.generation).catch(() => undefined);
    }
    await update(record, { status: "failed", errorCode, ...(archiveId === undefined ? {} : { archiveId }) });
  };

  const execute = async (record: BrowserConsultationRecord, task: string, controller: AbortController): Promise<void> => {
    try {
      const generation = record.generation!;
      record = await update(record, { status: "planning" });
      const plan = await input.executor.plan({ sessionGeneration: generation, task, signal: controller.signal });
      if (controller.signal.aborted) return fail(record, "stopped");
      if (!plan.ok) return fail(record, plan.code);
      if (plan.kind === "direct" || plan.kind === "clarification") {
        const body = plan.answer;
        const eventId = `browser-${createHash("sha256").update(`${record.requestId}\n${body}`).digest("hex")}`;
        const appended = await input.registrarRuntime.registrar.appendConfirmedMessage({
          generation,
          eventId,
          role: "Head Consultant",
          body,
          ...(plan.language === null ? {} : { language: plan.language })
        });
        if (!appended.ok) return fail(record, appended.code);
        const session = await input.registrarRuntime.registrar.getActiveSession();
        if (session?.generation !== generation || session.phase !== "active") return fail(record, "session_unavailable");
        try {
          await input.archiveBeforeClose({ session, messages: await input.registrarRuntime.registrar.getConfirmedMessages(generation) });
        } catch {
          return fail(record, "archive_rejected");
        }
        const closed = await input.registrarRuntime.registrar.closeSession(generation);
        if (!closed.ok) return fail(record, closed.code);
        const archiveId = `session-${session.sessionId}-${generation}`;
        await update(record, { status: "completed", outcome: plan.kind, archiveId });
        return;
      }

      record = await update(record, { status: "running" });
      const result = await input.executor.run({
        sessionGeneration: generation,
        task,
        head: plan.head,
        specialists: plan.specialists,
        critic: plan.critic,
        taskId: record.sessionId,
        language: plan.language,
        assignments: plan.assignments,
        signal: controller.signal
      });
      if (controller.signal.aborted) return fail(record, "stopped");
      if (!result.ok) return fail(record, result.code);
      await update(record, {
        status: "completed",
        outcome: result.outcome ?? "consensus",
        archiveId: `session-${record.sessionId}-${generation}`
      });
    } catch {
      await fail(record, controller.signal.aborted ? "stopped" : "runtime_unavailable");
    } finally {
      running.delete(record.requestId);
      await input.leadership.release().catch(() => undefined);
    }
  };

  const read = async (requestId: string): Promise<BrowserConsultationView | undefined> => {
    if (!validRequestId(requestId)) return undefined;
    const record = await input.storage.get<BrowserConsultationRecord>(recordKey(requestId));
    if (record === undefined || record.version !== 1 || record.requestId !== requestId) return undefined;
    const messages = record.generation === undefined ? Object.freeze([]) : await input.registrarRuntime.registrar.getConfirmedMessages(record.generation);
    return Object.freeze({ record, messages });
  };

  return Object.freeze({
    async submit(value) {
      if (closing || typeof value.task !== "string" || value.task.trim().length === 0 || Buffer.byteLength(value.task, "utf8") > 64 * 1024) {
        return { ok: false as const, code: "invalid_request" as const };
      }
      if (value.consent !== true) return { ok: false as const, code: "consent_required" as const };
      if (containsSecretLikeContent(value.task)) return { ok: false as const, code: "secret_detected" as const };
      const requestId = value.requestId ?? `req-${randomUUID()}`;
      if (!validRequestId(requestId)) return { ok: false as const, code: "invalid_request" as const };
      const existing = await read(requestId);
      if (existing !== undefined) return { ok: true as const, record: existing.record, replayed: true };
      if (admitting) return { ok: false as const, code: "busy" as const };
      admitting = true;
      const sessionId = `session-${requestId}`;
      const createdAt = now().toISOString();
      let record: BrowserConsultationRecord = Object.freeze({
        version: 1, requestId, sessionId,
        taskSha256: createHash("sha256").update(value.task, "utf8").digest("hex"),
        status: "preparing", createdAt, updatedAt: createdAt
      });
      try {
        const activeId = await input.storage.get<unknown>(ACTIVE_KEY);
        if (typeof activeId === "string") {
          const active = await read(activeId);
          if (active !== undefined && !finished(active.record.status)) return { ok: false as const, code: "busy" as const };
        }
        if (!await input.leadership.acquire()) return { ok: false as const, code: "busy" as const };
        await save(record);
        const snapshot = await input.prepareSnapshot(sessionId);
        if (snapshot === undefined) {
          await update(record, { status: "failed", errorCode: "runtime_unavailable" });
          await input.leadership.release();
          return { ok: false as const, code: "runtime_unavailable" as const };
        }
        const started = await input.registrarRuntime.registrar.startSession({ sessionId, settingsSnapshot: snapshot });
        if (!started.ok) {
          await update(record, { status: "failed", errorCode: started.code });
          await input.leadership.release();
          return { ok: false as const, code: started.code === "active_session_exists" ? "busy" as const : "runtime_unavailable" as const };
        }
        record = await update(record, { generation: started.value.generation });
        const controller = new AbortController();
        const completion = execute(record, value.task, controller);
        running.set(requestId, Object.freeze({ controller, completion }));
        return { ok: true as const, record, replayed: false };
      } catch {
        if (record.generation !== undefined) await fail(record, "runtime_unavailable").catch(() => undefined);
        await input.leadership.release().catch(() => undefined);
        return { ok: false as const, code: "runtime_unavailable" as const };
      } finally {
        admitting = false;
      }
    },
    async latest() {
      const requestId = await input.storage.get<unknown>(LATEST_KEY);
      return typeof requestId === "string" ? read(requestId) : undefined;
    },
    read,
    async stop(requestId) {
      const view = await read(requestId);
      if (view === undefined) return { ok: false as const, code: "not_found" as const };
      if (finished(view.record.status)) return { ok: false as const, code: "not_running" as const };
      running.get(requestId)?.controller.abort();
      if (view.record.generation !== undefined) {
        await input.registrarRuntime.registrar.stopSession(view.record.generation).catch(() => undefined);
      }
      const archiveId = view.record.generation === undefined ? undefined : await seal(view.record.generation).catch(() => undefined);
      const record = await update(view.record, { status: "stopped", errorCode: "owner_stopped", ...(archiveId === undefined ? {} : { archiveId }) });
      return { ok: true as const, record };
    },
    async start() {
      const activeId = await input.storage.get<unknown>(ACTIVE_KEY);
      if (typeof activeId !== "string") return;
      const view = await read(activeId);
      if (view === undefined || finished(view.record.status)) return;
      await fail(view.record, "interrupted_before_completion");
      await input.leadership.release().catch(() => undefined);
    },
    async close() {
      closing = true;
      for (const run of running.values()) run.controller.abort();
      await Promise.allSettled([...running.values()].map(run => run.completion));
      await input.leadership.release().catch(() => undefined);
    }
  });
}
