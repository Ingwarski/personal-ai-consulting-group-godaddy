import { randomUUID } from "node:crypto";
import { classifyConsultationFailure, classifyConsultationResult, type ConsultationFailure } from "./consultation-diagnostics.ts";
import { isSecretLikeMatrixContent } from "../matrix/bridge.ts";
import { parseOwnerCommand, parseConsultationControl } from "../session/owner-commands.ts";
import { canonicalSessionLanguage, explicitSessionLanguage, initialLanguageHint } from "../consilium/language.ts";
import { LANGUAGE_QUESTION, parseLanguageAnswer, serviceMessage, supportedServiceLanguage, validateServiceTranslationCatalog, type ServiceTranslationCatalog } from "../consilium/service-messages.ts";
import { consensusDigest } from "../consilium/consensus-contract.ts";
import type { RegistrarDO } from "../session/registrar-do.ts";
import type { RegistrarStorage } from "../session/storage.ts";
import type { EffectiveSessionSnapshot } from "../settings/types.ts";
import type { GoDaddyConsiliumRuntime } from "./consilium-runtime.ts";
import type { ConsultationLeadership } from "./consultation-leadership.ts";
import type { LeasedMatrixIngressIntent, MatrixIngressIntent, MySqlMatrixIngressReceipts } from "./mysql-matrix-outbox.ts";
import { formatBriefIntakeQuestion, MAX_BRIEF_INTAKE_QUESTIONS, parseBriefIntakeControl, requestsBriefIntake, validBriefIntakeState,
  type BriefIntakeState } from "../consilium/brief-intake.ts";

const KEY = "worker";
const MAX_TASK_BYTES = 24_000;
const MAX_HANDLED = 64;
const NOTICE_CONSENT = "Перед початком потрібна ваша одноразова згода на обробку звичайних бізнес-даних обраними ШІ-провайдерами. Не надсилайте паролі, ключі доступу, повні банківські реквізити чи державні ідентифікатори. Напишіть «Погоджуюсь на обробку» або «Не погоджуюсь». Це не дозвіл на зовнішні дії чи чутливі документи.";
const NOTICE_DOCUMENT = "Вкладення ще не передано ШІ. Його чутливість не визначена. Перевірте, що в ньому немає секретів, і дайте відповідь саме на повідомлення з вкладенням: «Підтверджую документ без секретів». Для відмови: «Відхиляю документ». Підтвердження стосується лише цього вкладення.";
const NOTICE_CONTINUE = "Роботу призупинено до стандартної десятихвилинної межі; готової відповіді ще немає. Потрібен додатковий час. Напишіть «Продовжити», щоб дозволити наступний обмежений цикл, або «Стоп».";
const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

export type ConsultationDocument = Readonly<{
  eventHash: string;
  eventId: string;
  manifest: MatrixIngressIntent["media"];
  confirmed: boolean;
}>;
export type ConsultationMediaInput = Readonly<{
  images: readonly Readonly<{ mime: "image/png" | "image/jpeg"; bytes: Uint8Array }>[];
  text: string;
  release(): void;
}>;
export interface ConsultationMediaPort {
  prepare(documents: readonly ConsultationDocument[], signal?: AbortSignal): Promise<ConsultationMediaInput | undefined>;
  erase(eventHash: string): Promise<void>;
  purgeExpired(): Promise<void>;
}
type JobStatus = "awaiting_language" | "awaiting_consent" | "awaiting_document" | "awaiting_clarification" | "queued" | "planning" | "running"
  | "awaiting_continuation" | "interrupted" | "completed" | "stopped" | "failed";
type Job = {
  id: string;
  eventId: string;
  task: string;
  documents: ConsultationDocument[];
  status: JobStatus;
  attempt: number;
  language?: string;
  languageConfirmed?: boolean;
  generation?: number;
  sessionId?: string;
  resumeFinalization?: true;
  briefIntake?: BriefIntakeState;
};
type Handled = { hash: string; sessionId: string; generation: number };
type PendingInput = {
  hash: string;
  eventId: string;
  consent: boolean;
  job: Job | null;
  notice: string;
  renderedNotice?: string;
  noticeLanguage?: string;
  skipNotice?: true;
  cancelGeneration?: number;
  revisionGeneration?: number;
  erase: string[];
  mutatesJob: boolean;
  cancelExecution?: boolean;
};
type WorkerState = {
  version: 1;
  bindingHash: string;
  consent: boolean;
  job: Job | null;
  handled: Handled[];
  pending: PendingInput | null;
};

export type MatrixConsultationService = Readonly<{
  start(): Promise<void>;
  wake(): void;
  stop(): Promise<void>;
  requestStop(): void;
  /** Deterministic credential-free adapter verification; not an HTTP route. */
  tick(): Promise<void>;
  status(): Readonly<{ working: boolean; blocked: boolean; lastFailure?: ConsultationFailure }>;
}>;

/** Drains durable intents, not ephemeral sidecar callbacks. It commits each
 * input decision before applying replay-safe registrar effects. A provider
 * attempt is marked dispatched BEFORE it starts; an uncertain attempt after
 * restart is never automatically replayed. Only one MySQL lock holder runs. */
export function createMatrixConsultationService(input: Readonly<{
  storage: RegistrarStorage;
  ingress: Pick<MySqlMatrixIngressReceipts, "leaseNext" | "markProcessed">;
  registrar: RegistrarDO;
  executor: Pick<GoDaddyConsiliumRuntime, "plan" | "run"> & Partial<Pick<GoDaddyConsiliumRuntime, "canResumeFinalization" | "resumeFinalization" | "translateServiceMessages">>;
  prepareSnapshot(sessionId: string): Promise<EffectiveSessionSnapshot | undefined>;
  resolveReplySession?: (matrixEventId: string) => Promise<string | undefined>;
  afterConfirmed: () => void | Promise<void>;
  leadership: ConsultationLeadership;
  bindingHash: string;
  assertReady(): void;
  media?: ConsultationMediaPort;
  now?: () => Date;
  intervalMs?: number;
  executionBudgetMs?: number;
  progressIntervalMs?: number;
}>): MatrixConsultationService {
  if (!/^[a-f0-9]{64}$/.test(input.bindingHash)) throw new Error("Invalid consultation binding.");
  const now = input.now ?? (() => new Date());
  const intervalMs = input.intervalMs ?? 1_000;
  const budgetMs = input.executionBudgetMs ?? 540_000;
  const progressMs = input.progressIntervalMs ?? 45_000;
  if (![intervalMs, budgetMs, progressMs].every(n => Number.isSafeInteger(n) && n > 0)
    || budgetMs > 540_000 || intervalMs > 1_000 || progressMs > 45_000) throw new Error("Invalid consultation limits.");
  const owner = randomUUID().replaceAll("-", "");
  let started = false, stopping = false, acquired = false, recovered = false, blocked = false;
  let diagnosticStage = "readiness";
  let lastFailure: ConsultationFailure | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking: Promise<void> | undefined;
  let execution: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let ownedGeneration: number | undefined;
  let publishing = 0;
  const translatedNotices = new Map<string, ServiceTranslationCatalog>();
  let serial = Promise.resolve();
  const empty = (): WorkerState => ({ version: 1, bindingHash: input.bindingHash, consent: false, job: null, handled: [], pending: null });
  const validate = (state: WorkerState): WorkerState => {
    // Jobs already dispatched by the pre-language protocol were Ukrainian.
    // Carry that legacy choice forward without rewriting any transcript.
    if (state?.job !== null && state?.job !== undefined && state.job.language === undefined && state.job.generation !== undefined
      && state.job.status !== "awaiting_language") state.job.language = "uk";
    const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    const validJob = (job: Job | null): boolean => job === null || (
      typeof job === "object" && hash(job.id) && typeof job.eventId === "string"
      && /^\$[A-Za-z0-9$:_-]{8,255}$/.test(job.eventId)
      && typeof job.task === "string" && byteLength(job.task) <= MAX_TASK_BYTES
      && Number.isSafeInteger(job.attempt) && job.attempt >= 0
      && (job.language === undefined || canonicalSessionLanguage(job.language) === job.language)
      && (job.languageConfirmed === undefined || typeof job.languageConfirmed === "boolean")
      && (job.resumeFinalization === undefined || job.resumeFinalization === true)
      && (job.briefIntake === undefined || validBriefIntakeState(job.briefIntake))
      && ["awaiting_language", "awaiting_consent", "awaiting_document", "awaiting_clarification", "queued", "planning", "running",
        "awaiting_continuation", "interrupted", "completed", "stopped", "failed"].includes(job.status)
      && (job.generation === undefined || (Number.isSafeInteger(job.generation) && job.generation > 0
        && typeof job.sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(job.sessionId)))
      && Array.isArray(job.documents) && job.documents.length <= 4
      && job.documents.every(d => d !== null && typeof d === "object" && hash(d.eventHash)
        && typeof d.confirmed === "boolean" && typeof d.eventId === "string" && /^\$[A-Za-z0-9$:_-]{8,255}$/.test(d.eventId)
        && Array.isArray(d.manifest) && d.manifest.length > 0 && d.manifest.length <= 4
        && d.manifest.every(m => m !== null && typeof m === "object" && hash(m.sha256)
          && ["image/png", "image/jpeg", "application/pdf"].includes(m.declaredMime)
          && Number.isSafeInteger(m.length) && m.length > 0 && m.length <= 20 * 1024 * 1024))
      && job.documents.reduce((total, d) => total + d.manifest.length, 0) <= 4
      && job.documents.reduce((total, d) => total + d.manifest.reduce((n,m) => n + m.length, 0), 0) <= 64 * 1024 * 1024
    );
    if (state?.version !== 1 || state.bindingHash !== input.bindingHash || typeof state.consent !== "boolean"
      || !Array.isArray(state.handled) || state.handled.length > MAX_HANDLED
      || state.handled.some(h => !hash(h.hash) || typeof h.sessionId !== "string"
        || !Number.isSafeInteger(h.generation) || h.generation < 1)
      || !validJob(state.job)
      || (state.pending !== null && (!hash(state.pending.hash) || !validJob(state.pending.job)
        || typeof state.pending.mutatesJob !== "boolean" || typeof state.pending.consent !== "boolean"
        || typeof state.pending.notice !== "string" || byteLength(state.pending.notice) > 4000
        || (state.pending.renderedNotice !== undefined && (typeof state.pending.renderedNotice !== "string" || byteLength(state.pending.renderedNotice) > 8192))
        || (state.pending.noticeLanguage !== undefined && canonicalSessionLanguage(state.pending.noticeLanguage) !== state.pending.noticeLanguage)
        || (state.pending.skipNotice !== undefined && state.pending.skipNotice !== true)
        || !Array.isArray(state.pending.erase) || state.pending.erase.length > 4 || !state.pending.erase.every(hash)))) throw new Error("Consultation state is invalid.");
    return state;
  };
  const mutate = <T>(operation: (state: WorkerState) => Promise<T> | T): Promise<T> => {
    const result = serial.then(() => input.storage.transaction(async storage => {
      const state = validate(await storage.get<WorkerState>(KEY) ?? empty());
      const value = await operation(state);
      await storage.put(KEY, validate(state));
      return value;
    }));
    serial = result.then(() => undefined, () => undefined);
    return result;
  };
  const read = (): Promise<WorkerState> => mutate(state => structuredClone(state));
  const hasDurableConsensusOutcome = async (job: Job): Promise<boolean> => {
    if (job.generation === undefined) return false;
    const consensus = await input.registrar.getConsensus(job.id);
    return consensus !== undefined && consensus.generation === job.generation &&
      ["published", "unresolved"].includes(consensus.status) && typeof consensus.finalBody === "string" && consensus.finalBody.length > 0;
  };
  // A short DB-only publication boundary. Provider calls never hold it. It
  // prevents a control's copied decision racing a completed model result.
  const withInputBarrier = async <T>(operation: () => Promise<T>): Promise<T> => {
    await ticking;
    publishing += 1;
    try { return await operation(); } finally { publishing -= 1; }
  };
  const renderNotice = async (body: string, language?: string): Promise<string> => {
    if (language !== undefined && supportedServiceLanguage(language) === undefined && !translatedNotices.has(language)) {
      const cached = await validateServiceTranslationCatalog(await input.storage.get(`service-translation:${language}`), language);
      if (cached !== undefined) translatedNotices.set(language, cached);
    }
    return body === LANGUAGE_QUESTION ? body : serviceMessage(body, language, language === undefined ? undefined : translatedNotices.get(language));
  };
  const notice = async (id: string, body: string, replyToEventId?: string, selectedLanguage?: string, alreadyRendered = false) => {
    const language = selectedLanguage ?? (await read()).job?.language;
    const result = await input.registrar.appendControlNotice({
      eventId: id, body: alreadyRendered ? body : await renderNotice(body, language),
      ...(language === undefined ? {} : { language }), ...(replyToEventId === undefined ? {} : { replyToEventId })
    });
    if (!result.ok) throw new Error("Consultation notice was not committed.");
    await input.afterConfirmed();
    return result.value;
  };
  const readyStatus = (job: Job, consent: boolean): JobStatus =>
    job.language === undefined ? "awaiting_language"
      : !consent ? "awaiting_consent" : job.documents.some(d => !d.confirmed) ? "awaiting_document" : "queued";
  const newJob = (lease: LeasedMatrixIngressIntent, consent: boolean): Job => {
    const e = lease.workIntent;
    const explicitLanguage = explicitSessionLanguage(e.body ?? "");
    const language = explicitLanguage ?? initialLanguageHint(e.body ?? "");
    const job: Job = { id: lease.eventHash, eventId: e.eventId, task: e.body ?? "",
      documents: e.media.length === 0 ? [] : [{ eventHash: lease.eventHash, eventId: e.eventId, manifest: e.media, confirmed: false }],
      status: "queued", attempt: 0, briefIntake: { requested: requestsBriefIntake(e.body ?? ""), skipRemaining: false, rounds: [] },
      ...(language === null ? {} : { language, languageConfirmed: explicitLanguage !== undefined }) };
    job.status = readyStatus(job, consent);
    return job;
  };
  const planInput = (state: WorkerState, lease: LeasedMatrixIngressIntent, confirmedReplySession?: string): PendingInput => {
    const e = lease.workIntent;
    const body = e.body ?? "";
    const pending: PendingInput = { hash: lease.eventHash, eventId: e.eventId, consent: state.consent,
      job: state.job === null ? null : structuredClone(state.job), notice: "", erase: [], mutatesJob: false };
    const job = pending.job;
    // Controls are exact text-only owner events, never instructions in files.
    const command = e.media.length === 0 ? parseOwnerCommand(body) : { kind: "ordinary_message" as const };
    const control = e.media.length === 0 ? parseConsultationControl(body) : undefined;
    if (command.kind === "stop" || command.kind === "new_task") {
      pending.mutatesJob = true;
      pending.cancelExecution = true;
      if (job?.generation !== undefined) pending.cancelGeneration = job.generation;
      if (job !== null) { pending.erase = job.documents.map(d => d.eventHash); job.status = "stopped"; }
      pending.notice = command.kind === "stop" ? "Сесію зупинено. Нові відповіді цієї задачі не публікуватимуться."
        : "Попередню роботу зупинено. Надішліть нову задачу окремим повідомленням.";
      if (command.kind === "new_task") pending.job = null;
      return pending;
    }
    if (command.kind === "costs") {
      pending.notice = "Фактична вартість цієї сесії — невідомо. Дані про використання та вартість не отримано; приблизну ціну токенів не підставлено.";
      return pending;
    }
    if (isSecretLikeMatrixContent(body) || byteLength(body) > MAX_TASK_BYTES) {
      pending.notice = "Повідомлення не передано агентам: воно містить можливий секрет або перевищує межу розміру. Надішліть коротший текст без секретів.";
      pending.erase = e.media.length === 0 ? [] : [lease.eventHash];
      return pending;
    }
    if (job !== null && job.status === "awaiting_language" && e.media.length === 0) {
      const selected = explicitSessionLanguage(body) ?? parseLanguageAnswer(body) ?? initialLanguageHint(body);
      pending.mutatesJob = true;
      if (selected !== null && selected !== undefined) {
        job.language = selected;
        job.languageConfirmed = true;
        if (parseLanguageAnswer(body) === undefined) {
          const amended = `${job.task}\n\nOwner clarification:\n${body}`;
          if (byteLength(amended) > MAX_TASK_BYTES) { pending.notice = LANGUAGE_QUESTION; return pending; }
          job.task = amended;
        }
        job.status = readyStatus(job, state.consent);
        pending.notice = !state.consent ? NOTICE_CONSENT : job.status === "awaiting_document" ? NOTICE_DOCUMENT : "Запит прийнято. Визначаю потрібний формат консультації.";
      } else pending.notice = LANGUAGE_QUESTION;
      return pending;
    }
    if (!state.consent && control === "consent") {
      pending.mutatesJob = true;
      pending.consent = true;
      if (job !== null) job.status = readyStatus(job, true);
      pending.notice = job?.status === "awaiting_document" ? NOTICE_DOCUMENT : "Згоду збережено. " + (job === null ? "Надішліть задачу." : "Запит прийнято.");
      return pending;
    }
    if (!state.consent && control === "decline_consent") {
      pending.mutatesJob = true;
      pending.erase = job?.documents.map(d => d.eventHash) ?? [];
      pending.job = null;
      pending.notice = "Обробку не розпочато. Згоду не надано.";
      return pending;
    }
    if (job !== null && e.media.length === 0
      && (control === "confirm_document" || control === "reject_document")) {
      const document = job.documents.find(d => d.eventId === e.relationEventId && !d.confirmed);
      if (document === undefined || !state.consent || job.status !== "awaiting_document") {
        pending.notice = "Дозвіл не застосовано. Спершу надайте загальну згоду, потім дайте відповідь саме на непідтверджене вкладення.";
        return pending;
      }
      if (control === "confirm_document") {
        job.documents = job.documents.map(d => d === document ? { ...d, confirmed: true } : d);
      } else {
        job.documents = job.documents.filter(d => d !== document);
        pending.erase.push(document.eventHash);
      }
      pending.mutatesJob = true;
      job.status = readyStatus(job, state.consent);
      if (job.task.trim().length === 0 && job.documents.length === 0) job.status = "completed";
      pending.notice = job.status === "awaiting_document" ? NOTICE_DOCUMENT : job.status === "completed"
        ? "Вкладення відхилено. Обробку не розпочато." : "Рішення щодо вкладення збережено. Запит прийнято.";
      return pending;
    }
    if (control === "continue") {
      if (job === null || !["awaiting_continuation", "interrupted", "failed"].includes(job.status)) {
        pending.notice = "Немає призупиненої роботи, що очікує цього дозволу.";
        return pending;
      }
      if (job.generation !== undefined) pending.revisionGeneration = job.generation;
      delete job.resumeFinalization;
      pending.mutatesJob = true;
      pending.cancelExecution = true;
      job.status = readyStatus(job, state.consent);
      pending.notice = "Дозвіл на наступний обмежений цикл збережено. Налаштування цієї сесії не змінюються.";
      return pending;
    }
    if (job !== null && !["completed", "stopped"].includes(job.status)) {
      if (e.relationEventId !== undefined && e.relationEventId !== job.eventId
        && !job.documents.some(d => d.eventId === e.relationEventId)
        && (job.sessionId === undefined || confirmedReplySession !== job.sessionId)) {
        pending.notice = "Уточнення не приєднано: відповідь посилається не на поточну задачу. Надішліть уточнення без reply або дайте відповідь на її початкове повідомлення.";
        pending.erase = e.media.length ? [lease.eventHash] : [];
        return pending;
      }
      const explicitLanguage = explicitSessionLanguage(body);
      if (explicitLanguage !== undefined) { job.language = explicitLanguage; job.languageConfirmed = true; }
      let clarification = body;
      let clarificationQuestion: string | undefined;
      if (job.status === "awaiting_clarification") {
        const state = job.briefIntake ?? { requested: false, skipRemaining: false, rounds: [] };
        const rounds = state.rounds.map(round => ({ ...round }));
        const current = rounds.at(-1);
        const intakeControl = e.media.length === 0 ? parseBriefIntakeControl(body) : undefined;
        if (current !== undefined && current.answer === undefined) {
          clarificationQuestion = current.question;
          const usesRecommendation = intakeControl === "use_recommendation" || intakeControl === "skip_questions";
          clarification = usesRecommendation ? current.recommendedAnswer : body;
          rounds[rounds.length - 1] = { ...current, answer: clarification, ...(usesRecommendation ? { usedRecommendation: true as const } : {}) };
        }
        job.briefIntake = { ...state, skipRemaining: state.skipRemaining || intakeControl === "skip_questions", rounds };
      }
      const amended = job.task + (clarification.trim() ? clarificationQuestion === undefined
        ? "\n\nOwner clarification:\n" + clarification
        : "\n\nHead Consultant clarification:\n" + clarificationQuestion + "\n\nOwner answer:\n" + clarification : "");
      // Changed owner input requires a fresh reviewed generation.
      delete job.resumeFinalization;
      const mediaBytes = job.documents.reduce((n, d) => n + d.manifest.reduce((size, m) => size + m.length, 0), 0)
        + e.media.reduce((n, m) => n + m.length, 0);
      if (byteLength(amended) > MAX_TASK_BYTES || job.documents.reduce((n,d) => n + d.manifest.length, 0) + e.media.length > 4
        || mediaBytes > 64 * 1024 * 1024) {
        pending.notice = "Уточнення не додано: контекст або вкладення перевищують безпечну межу. Сформулюйте коротше уточнення або почніть «Нова задача».";
        pending.erase = e.media.length ? [lease.eventHash] : [];
        return pending;
      }
      job.task = amended;
      pending.mutatesJob = true;
      pending.cancelExecution = true;
      if (e.media.length) job.documents.push({ eventHash: lease.eventHash, eventId: e.eventId, manifest: e.media, confirmed: false });
      if (job.generation !== undefined) pending.revisionGeneration = job.generation;
      job.status = readyStatus(job, state.consent);
      pending.notice = job.status === "awaiting_language" ? LANGUAGE_QUESTION : !state.consent ? NOTICE_CONSENT : job.status === "awaiting_document" ? NOTICE_DOCUMENT
        : "Уточнення прийнято до поточної задачі. Попереднє виконання скасовується; чинні налаштування сесії збережено.";
      return pending;
    }
    pending.job = newJob(lease, state.consent);
    pending.mutatesJob = true;
    pending.notice = pending.job.status === "awaiting_language" ? LANGUAGE_QUESTION : !state.consent ? NOTICE_CONSENT : pending.job.status === "awaiting_document" ? NOTICE_DOCUMENT : "Запит прийнято. Визначаю потрібний формат консультації.";
    return pending;
  };

  const processInput = async (lease: LeasedMatrixIngressIntent): Promise<void> => {
    diagnosticStage = "input_state";
    let prior = await read();
    let handled = prior.handled.find(h => h.hash === lease.eventHash);
    if (handled === undefined && prior.pending === null && prior.job !== null && await hasDurableConsensusOutcome(prior.job)) {
      const completed = prior.job;
      await mutate(state => { if (state.job?.id === completed.id && state.job.generation === completed.generation) state.job.status = "completed"; });
      // A delayed Continue racing an already committed final is an ACK-only
      // replay, not authority to create another generation or repeat models.
      if (lease.workIntent.media.length === 0 && parseConsultationControl(lease.workIntent.body ?? "") === "continue") {
        handled = { hash: lease.eventHash, sessionId: completed.sessionId!, generation: completed.generation! };
        const result = handled;
        await mutate(state => { state.handled = [...state.handled, result].slice(-MAX_HANDLED); });
      }
      prior = await read();
    }
    if (handled === undefined) {
      let pending = prior.pending;
      if (pending !== null && pending.hash !== lease.eventHash) throw new Error("Consultation input order changed.");
      if (pending === null) {
        const relation = lease.workIntent.relationEventId;
        const text = lease.workIntent.body ?? "";
        const isControl = parseOwnerCommand(text).kind !== "ordinary_message" || parseConsultationControl(text) !== undefined;
        const confirmedReplySession = relation === undefined || isControl ? undefined : await input.resolveReplySession?.(relation);
        pending = planInput(prior, lease, confirmedReplySession);
        diagnosticStage = "input_resume_probe";
        let resumableFinalization = false;
        if (parseConsultationControl(text) === "continue" && lease.workIntent.media.length === 0 && pending.revisionGeneration !== undefined
          && pending.job !== null && pending.job.documents.length === 0 && input.executor.resumeFinalization !== undefined) {
          try {
            resumableFinalization = await input.executor.canResumeFinalization?.(pending.revisionGeneration) === true;
          } catch {
            // This is only a reuse optimization. If its read cannot prove a
            // complete final-only checkpoint, continue through the normal
            // atomic revision path; that path retains every authority fence.
            resumableFinalization = false;
          }
        }
        if (resumableFinalization && pending.job !== null) {
          // Do not mint a new generation or substitute its Critic. Reuse only
          // the complete verified review in this exact still-active session.
          delete pending.revisionGeneration;
          pending.job.resumeFinalization = true;
          pending.notice = "Продовжую лише фінальний підсумок. Підтверджені позиції, окрему критику й доопрацювання збережено; повторних викликів спеціалістів або Критика не буде.";
        }
        diagnosticStage = "input_pending_store";
        await mutate(state => { state.pending = pending; });
      }
      if (pending.cancelExecution) controller?.abort();
      if (pending.cancelGeneration !== undefined) {
        diagnosticStage = "input_cancel";
        const stopped = await input.registrar.stopSession(pending.cancelGeneration);
        if (!stopped.ok && !["session_not_active", "obsolete_generation"].includes(stopped.code)) throw new Error("Session cancellation failed.");
      }
      if (pending.revisionGeneration !== undefined) {
        diagnosticStage = "input_revision";
        const revision = await input.registrar.reviseSession({ generation: pending.revisionGeneration, revisionId: "mx-revision-" + pending.hash });
        if (!revision.ok) {
          if (pending.job !== null && await hasDurableConsensusOutcome(pending.job)) {
            if (lease.workIntent.media.length === 0 && parseConsultationControl(lease.workIntent.body ?? "") === "continue") {
              pending.job.status = "completed";
              pending.skipNotice = true;
            } else {
              // A real new message racing completion still needs its own
              // work intent; never discard it as a failed old-generation edit.
              pending.job = newJob(lease, pending.consent);
              pending.notice = pending.job.status === "awaiting_language" ? LANGUAGE_QUESTION : !pending.consent ? NOTICE_CONSENT
                : pending.job.status === "awaiting_document" ? NOTICE_DOCUMENT : "Запит прийнято. Визначаю потрібний формат консультації.";
              delete pending.renderedNotice; delete pending.noticeLanguage;
            }
          } else {
            if (pending.job !== null) pending.job.status = "stopped";
            pending.notice = "Попередню сесію вже зупинено. Щоб почати нову роботу, надішліть «Нова задача».";
            delete pending.renderedNotice; delete pending.noticeLanguage;
          }
        } else if (pending.job !== null) {
          pending.job.generation = revision.value.generation;
          pending.job.sessionId = revision.value.sessionId;
        }
        diagnosticStage = "input_pending_store";
        await mutate(state => { state.pending = pending; });
      }
      diagnosticStage = "input_media";
      for (const hash of pending.erase) await input.media?.erase(hash);
      diagnosticStage = "input_notice";
      if (!pending.skipNotice && pending.renderedNotice === undefined) {
        const language = pending.job?.language ?? prior.job?.language;
        pending.renderedNotice = await renderNotice(pending.notice, language);
        if (language !== undefined) pending.noticeLanguage = language;
        // Freeze the actual displayed bytes before registrar publication. A
        // cache refresh or deployment must not change an in-flight retry hash.
        await mutate(state => { state.pending = pending; });
      }
      const committed = pending.skipNotice ? { generation: pending.job!.generation! }
        : await notice("mx-notice-" + pending.hash, pending.renderedNotice!, pending.eventId, pending.noticeLanguage, true);
      diagnosticStage = "input_commit";
      handled = { hash: pending.hash, sessionId: pending.job?.sessionId ?? "control-" + committed.generation, generation: committed.generation };
      const result = handled;
      await mutate(state => {
        state.consent = pending!.consent;
        if (pending!.mutatesJob) state.job = pending!.job;
        state.handled = [...state.handled, result].slice(-MAX_HANDLED);
        state.pending = null;
      });
    }
    diagnosticStage = "input_ack";
    if (!await input.ingress.markProcessed({ eventId: lease.eventId, eventHash: lease.eventHash,
      leaseOwner: lease.leaseOwner, leaseEpoch: lease.leaseEpoch, sessionId: handled.sessionId,
      generation: handled.generation, now: now() })) throw new Error("Consultation input lease was lost.");
    lastFailure = undefined;
  };

  const recover = async (): Promise<void> => {
    const state = await read();
    const job = state.job;
    if (job !== null && ["planning", "running"].includes(job.status)) {
      const session = job.generation === undefined ? undefined : await input.registrar.getSession(job.generation);
      const consensus = await input.registrar.getConsensus(job.id);
      const completed = consensus === undefined ? session?.phase === "closed" : await hasDurableConsensusOutcome(job);
      await mutate(s => { if (s.job?.id === job.id) s.job.status = completed ? "completed" : "interrupted"; });
      if (!completed) {
        if (session?.phase === "active") await input.registrar.closeSession(session.generation);
        await notice("mx-interrupted-" + job.id + "-" + job.attempt,
          "Виконання перервалося під час перезапуску. Підтверджені репліки збережено. Повторний запуск не виконано автоматично: напишіть «Продовжити» або «Стоп».", job.eventId);
      }
    }
    recovered = true;
  };

  const execute = async (initial: Job): Promise<void> => {
    let job = initial;
    let media: ConsultationMediaInput | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let progress: ReturnType<typeof setInterval> | undefined;
    let expired = false;
    const abort = new AbortController();
    const attemptedTranslations = new Set<string>();
    controller = abort;
    const matches = (state: WorkerState) => (state.pending === null || !state.pending.mutatesJob) && state.job?.id === job.id
      && state.job.attempt === job.attempt && state.job.generation === job.generation
      && ["planning", "running"].includes(state.job.status);
    const fail = async (body: string, status: "failed" | "awaiting_continuation" | "interrupted") => {
      if (await hasDurableConsensusOutcome(job)) {
        await withInputBarrier(() => mutate(state => {
          if (state.job?.id === job.id && state.job.generation === job.generation && state.job.attempt === job.attempt) state.job.status = "completed";
        }));
        return;
      }
      const changed = await withInputBarrier(() => mutate(state => {
        if (!matches(state)) return false;
        state.job!.status = status;
        return true;
      }));
      if (changed) await notice("mx-outcome-" + job.id + "-" + job.attempt, body, job.eventId);
    };
    const ensureNoticeTranslation = async (): Promise<void> => {
      const language = job.language;
      if (language === undefined || supportedServiceLanguage(language) !== undefined || translatedNotices.has(language) ||
        attemptedTranslations.has(language) || input.executor.translateServiceMessages === undefined || job.generation === undefined) return;
      const cached = await validateServiceTranslationCatalog(await input.storage.get(`service-translation:${language}`), language);
      if (cached !== undefined) { translatedNotices.set(language, cached); return; }
      const state = await read();
      if (!state.consent || !matches(state) || abort.signal.aborted) return;
      attemptedTranslations.add(language);
      // Only language, session binding and app-owned strings cross this seam.
      // User task, attachments, prior transcript and personal details do not.
      let translated: Awaited<ReturnType<NonNullable<typeof input.executor.translateServiceMessages>>>;
      try { translated = await input.executor.translateServiceMessages({ sessionGeneration: job.generation, language, signal: abort.signal }); }
      catch { return; }
      if (!translated.ok || abort.signal.aborted) return;
      const catalog = await validateServiceTranslationCatalog(translated.catalog, language);
      if (catalog === undefined) return;
      await input.storage.transaction(async storage => { await storage.put(`service-translation:${language}`, catalog); });
      translatedNotices.set(language, catalog);
    };
    try {
      input.assertReady();
      if (!await input.leadership.check()) throw new Error("Consultation leadership lost.");
      const claimed = await withInputBarrier(() => mutate(state => {
        if (state.pending !== null || state.job?.id !== job.id || state.job.status !== "queued") return false;
        job = { ...job, attempt: job.attempt + 1, status: "planning" };
        state.job = job;
        return true;
      }));
      if (!claimed) return;
      ownedGeneration = job.generation;
      // The deadline publishes its pause independently of provider abort
      // completion; an unresponsive provider cannot silence the notice.
      deadline = setTimeout(() => {
        expired = true; abort.abort();
        void fail(NOTICE_CONTINUE, "awaiting_continuation").catch(() => { blocked = true; });
      }, budgetMs);
      if (job.generation === undefined) {
        const sessionId = "mx-" + job.id;
        const snapshot = await input.prepareSnapshot(sessionId);
        if (snapshot === undefined) {
          await fail("Не вдалося розпочати консультацію: перевірте вибрані моделі й каталог у Налаштуваннях власника. Після виправлення напишіть «Продовжити».", "failed");
          return;
        }
        const attached = await withInputBarrier(async () => {
          if (abort.signal.aborted || !matches(await read())) return false;
          const session = await input.registrar.startSession({ sessionId, settingsSnapshot: snapshot });
          if (!session.ok) throw new Error("Consultation session unavailable.");
          job = { ...job, generation: session.value.generation, sessionId: session.value.sessionId };
          ownedGeneration = job.generation;
          await mutate(state => { state.job = job; });
          return true;
        });
        if (!attached) return;
      }
      await ensureNoticeTranslation();
      if (abort.signal.aborted) return;
      let progressNumber = 0, progressBusy = false;
      progress = setInterval(() => {
        if (progressBusy || abort.signal.aborted) return;
        progressBusy = true;
        void (async () => {
          await ticking;
          if (!matches(await read()) || abort.signal.aborted) return;
          const messages = await input.registrar.getConfirmedMessages(job.generation!);
          const latest = messages.at(-1);
          if (latest !== undefined && now().getTime() - Date.parse(latest.confirmedAt) < progressMs) return;
          await notice("mx-wait-" + job.id + "-" + job.attempt + "-" + (++progressNumber),
            "Очікую завершення поточного запиту до обраного ШІ-провайдера. Нової підтвердженої репліки ще немає.", job.eventId);
        })().catch(error => {
          // This is an optional visibility notice, not an authority fence. Its
          // transient delivery failure must not cancel the provider turn whose
          // eventual messages remain protected by the durable registrar/outbox.
          blocked = true;
          lastFailure = classifyConsultationFailure("progress_notice", error);
        }).finally(() => { progressBusy = false; });
      }, progressMs);
      if (job.resumeFinalization && job.documents.length === 0 && input.executor.resumeFinalization !== undefined) {
        const result = await input.executor.resumeFinalization({ sessionGeneration: job.generation!, task: job.task, signal: abort.signal });
        if (abort.signal.aborted) { if (expired) await fail(NOTICE_CONTINUE, "awaiting_continuation"); return; }
        if (!result.ok) {
          await fail("Фінальний підсумок ще не підтверджено. Збережену критику не повторювали. Напишіть «Продовжити» для повтору лише фінального етапу або «Стоп».", "failed");
          return;
        }
        await withInputBarrier(() => mutate(state => { if (matches(state)) state.job!.status = "completed"; }));
        return;
      }
      if (job.documents.length > 0) {
        if (job.documents.some(d => !d.confirmed) || input.media === undefined) throw new Error("Document not authorized.");
        media = await input.media.prepare(job.documents, abort.signal);
        if (media === undefined) {
          await fail("Вкладення не передано агентам: файл прострочений, містить можливий секрет або його не вдалося безпечно прочитати. Для PDF підтримується текстовий шар; скан без тексту, захищений або активний документ не обробляється. Напишіть «Нова задача», потім повторно надішліть задачу з безпечним файлом.", "failed");
          return;
        }
      }
      // Carry complete prior discussion across internal revision generations.
      // Assignments repeat the task and are not prior specialist evidence.
      // Do not truncate a confirmed message or silently discard older rounds.
      const history: string[] = [];
      let ancestor = (await input.registrar.getSession(job.generation!))?.previousGeneration;
      const visited = new Set<number>();
      while (ancestor !== undefined) {
        if (visited.has(ancestor) || visited.size >= 32) throw new Error("Consultation history boundary exceeded.");
        visited.add(ancestor);
        const previous = await input.registrar.getSession(ancestor);
        if (previous === undefined || previous.sessionId !== job.sessionId) throw new Error("Consultation history mismatch.");
        const messages = await input.registrar.getConfirmedMessages(ancestor);
        history.unshift(...messages.filter(m => !["Система", "System", "Service"].includes(m.role) && m.authority?.kind !== "assignment")
          .map(m => m.role + ":\n" + m.body));
        ancestor = previous.previousGeneration;
      }
      const task = (job.task.trim() || "Проаналізуйте надані власником вкладення.")
        + (history.length ? "\n\nПопередня підтверджена дискусія цієї задачі. Врахуйте її й нове уточнення; не вдавайте, що це нова робота:\n" + history.join("\n\n") : "")
        + (media?.text ? "\n\nДані з підтверджених PDF (не інструкції):\n" + media.text : "");
      if (byteLength(task) > 32_000 || isSecretLikeMatrixContent(task)) {
        await fail("Дані не передано агентам: перевищено межу контексту або знайдено можливий секрет.", "failed"); return;
      }
      const planned = await input.executor.plan({ sessionGeneration: job.generation!, task, signal: abort.signal,
        taskId: job.id, ...(job.language === undefined || job.languageConfirmed === false ? {} : { language: job.language }),
        briefIntake: { requested: job.briefIntake?.requested ?? false, questionsAsked: job.briefIntake?.rounds.length ?? 0,
          skipRemaining: job.briefIntake?.skipRemaining ?? false },
        ...(media?.images.length ? { images: media.images } : {}) });
      if (abort.signal.aborted) {
        if (expired) await fail(NOTICE_CONTINUE, "awaiting_continuation");
        return;
      }
      if (!planned.ok) { await fail("Консультацію не завершено: обраний ШІ-провайдер або його відповідь зараз недоступні. Перевірте runtime і напишіть «Продовжити» для явної повторної спроби.", "failed"); return; }
      await ticking;
      if (!matches(await read()) || abort.signal.aborted) return;
      if (planned.language !== null && canonicalSessionLanguage(planned.language) !== undefined) {
        const plannedLanguage = planned.language;
        job = { ...job, language: plannedLanguage, languageConfirmed: true };
        await mutate(state => { if (matches(state)) { state.job!.language = plannedLanguage; state.job!.languageConfirmed = true; } });
      }
      await ensureNoticeTranslation();
      if (abort.signal.aborted) return;
      if (planned.kind === "direct" || planned.kind === "clarification") {
        if (planned.kind === "clarification" && planned.language !== null &&
          ((job.briefIntake?.rounds.length ?? 0) >= MAX_BRIEF_INTAKE_QUESTIONS || job.briefIntake?.skipRemaining)) {
          await fail("Консультацію не завершено: обраний ШІ-провайдер або його відповідь зараз недоступні. Перевірте runtime і напишіть «Продовжити» для явної повторної спроби.", "failed");
          return;
        }
        const answer = planned.kind === "clarification" && planned.language !== null
          ? formatBriefIntakeQuestion(planned.answer, planned.recommendedAnswer, job.language)
          : planned.answer;
        if (isSecretLikeMatrixContent(answer)) { await fail("Відповідь заблоковано перевіркою конфіденційності.", "failed"); return; }
        await withInputBarrier(async () => {
        if (!matches(await read()) || abort.signal.aborted) return;
        const appended = await input.registrar.appendConfirmedMessage({ generation: job.generation!, eventId: "mx-direct-" + job.id + "-" + job.attempt,
          role: "Head Consultant", body: answer, replyToEventId: job.eventId,
          ...(job.language === undefined ? {} : { language: job.language }) });
        if (!appended.ok) return;
        await input.afterConfirmed();
        if (planned.kind === "direct") {
          const closed = await input.registrar.closeSession(job.generation!);
          if (!closed.ok) throw new Error("Consultation close failed.");
        }
        await mutate(state => {
          if (!matches(state)) return;
          state.job!.status = planned.kind === "clarification" ? "awaiting_clarification" : "completed";
          if (planned.kind === "clarification" && planned.language !== null) {
            const intake = state.job!.briefIntake ?? { requested: false, skipRemaining: false, rounds: [] };
            state.job!.briefIntake = { ...intake, rounds: [...intake.rounds, {
              question: planned.answer, recommendedAnswer: planned.recommendedAnswer
            }] };
          }
        });
        });
      } else {
        const extraction = "extractedEvidence" in planned && typeof planned.extractedEvidence === "string" ? planned.extractedEvidence : "";
        const combined = task + (extraction ? "\n\nПідтверджена видима інтерпретація зображень головним консультантом (може містити помилки):\n" + extraction : "");
        if (byteLength(combined) > 32_000 || isSecretLikeMatrixContent(combined)) { await fail("Отриманий матеріал перевищує межу контексту або не пройшов перевірку конфіденційності.", "failed"); return; }
        if (extraction) {
          const observation = { eventId: "mx-image-" + job.id + "-" + job.attempt, body: extraction, replyToEventId: job.eventId,
            ...(job.language === undefined ? {} : { language: job.language }) };
          const bound = await input.registrar.getConsensusTask(job.generation!);
          // Fresh image reading is an intake observation, not an approval from
          // the previous head context. Preserve it verbatim with a service
          // observation header, then feed it to the actual consensus run.
          const appended = bound === undefined
            ? await input.registrar.appendConfirmedMessage({ ...observation, generation: job.generation!, role: "Head Consultant" })
            : await input.registrar.appendControlNotice(observation);
          if (!appended.ok) return;
          await input.afterConfirmed();
        }
        await mutate(state => { if (matches(state)) state.job!.status = "running"; });
        const result = await input.executor.run({ sessionGeneration: job.generation!, task: combined,
          taskId: job.id, taskDigest: await consensusDigest(job.documents.length === 0 ? job.task : JSON.stringify({ task: job.task,
            documents: job.documents.filter(document => document.confirmed).map(document => ({ eventId: document.eventId, eventHash: document.eventHash,
              manifest: document.manifest.map(item => ({ declaredMime: item.declaredMime, length: item.length, sha256: item.sha256 })) })) })),
          language: planned.language, assignments: planned.assignments,
          head: planned.head, specialists: planned.specialists, critic: planned.critic, signal: abort.signal });
        if (abort.signal.aborted) { if (expired) await fail(NOTICE_CONTINUE, "awaiting_continuation"); return; }
        if (!result.ok) {
          lastFailure = classifyConsultationResult("execution", result);
          await fail("Консультацію не завершено. Критичний або фінальний етап не підтверджено; готову рекомендацію не оголошено. Напишіть «Продовжити» для явної повторної спроби або «Стоп».", "failed");
          return;
        }
      }
      await withInputBarrier(() => mutate(state => { if (matches(state)) state.job!.status = "completed"; }));
      const finished = (await read()).job;
      if (finished?.id === job.id && finished.attempt === job.attempt && finished.status === "completed") {
        for (const document of job.documents) await input.media?.erase(document.eventHash);
      }
    } catch {
      if (expired) await fail(NOTICE_CONTINUE, "awaiting_continuation");
      else if (!abort.signal.aborted) await fail("Консультацію перервано без готової відповіді. Повторного запуску не буде без команди «Продовжити».", "failed");
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      if (progress !== undefined) clearInterval(progress);
      media?.release();
      if (abort.signal.aborted && !expired && !stopping) {
        await fail("Роботу перервано через зміну доступності або керування сесією. Підтверджені репліки збережено; автоматичного повтору немає. Напишіть «Продовжити» або «Стоп».", "interrupted");
      }
      if (controller === abort) controller = undefined;
      ownedGeneration = undefined;
    }
  };

  const tickInternal = async () => {
    if (stopping || publishing > 0) return;
    try {
      // Short-lived encrypted plaintext staging expires even when room or
      // provider readiness is blocked. Maintenance does not contact Matrix.
      diagnosticStage = "media_maintenance";
      await input.media?.purgeExpired();
      diagnosticStage = "readiness";
      // Matrix transport readiness gates NEW model work. Once a provider turn
      // has begun, its confirmed messages are durable in MySQL and may safely
      // wait in the outbox while Matrix reconnects. A transient send/reconcile
      // state must not cancel paid work or force the owner to type Continue.
      if (execution === undefined) input.assertReady();
      diagnosticStage = "leadership";
      if (!acquired) { acquired = await input.leadership.acquire(); if (!acquired) return; }
      if (!await input.leadership.check()) {
        controller?.abort();
        if (ownedGeneration !== undefined) await input.registrar.stopSession(ownedGeneration);
        await input.leadership.release();
        acquired = false; recovered = false; blocked = true;
        return;
      }
      diagnosticStage = "recovery";
      if (!recovered && execution === undefined) await recover();
      // Inputs stay responsive while provider calls run in the separate promise.
      for (let count = 0; count < 8; count++) {
        diagnosticStage = "ingress_lease";
        const lease = await input.ingress.leaseNext({ leaseOwner: owner, now: now(), leaseMilliseconds: 60_000 });
        if (lease === undefined) break;
        await processInput(lease);
      }
      diagnosticStage = "worker_state";
      const state = await read();
      if (recovered && execution === undefined && state.pending === null && state.job?.status === "queued") {
        execution = execute(state.job).catch(error => { blocked = true; lastFailure = classifyConsultationFailure("execution", error); }).finally(() => { execution = undefined; });
      }
      blocked = false;
    } catch (error) {
      blocked = true;
      lastFailure = classifyConsultationFailure(diagnosticStage, error);
      // Non-readiness failures here include leadership/DB/input faults and must
      // still fence an active provider. Ordinary transport readiness is never
      // checked in this loop while execution is active.
      controller?.abort();
      recovered = false;
    }
  };
  const tick = (): Promise<void> => ticking ??= tickInternal().finally(() => { ticking = undefined; });
  const schedule = () => {
    if (!started || stopping || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void tick().finally(schedule); }, intervalMs);
    timer.unref?.();
  };
  const requestStop = () => {
    stopping = true;
    if (timer !== undefined) clearTimeout(timer);
    controller?.abort();
  };
  return Object.freeze({
    async start() { if (stopping || started) return; started = true; await tick(); schedule(); },
    wake() {
      if (!started || stopping) return;
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      void tick().finally(schedule);
    },
    async stop() {
      requestStop();
      await ticking;
      await execution;
      await input.leadership.release();
    },
    tick,
    requestStop,
    status: () => Object.freeze({ working: execution !== undefined, blocked, ...(lastFailure === undefined ? {} : { lastFailure }) })
  });
}
