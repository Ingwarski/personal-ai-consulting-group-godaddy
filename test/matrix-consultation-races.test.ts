import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createMatrixConsultationService, type ConsultationMediaPort } from "../src/godaddy/matrix-consultation-service.ts";
import type { GoDaddyConsiliumRuntime, GoDaddyConsultationPlanRequest, GoDaddyConsultationPlanResult } from "../src/godaddy/consilium-runtime.ts";
import { SERVICE_TRANSLATION_SOURCE, serviceTranslationSourceHash } from "../src/consilium/service-messages.ts";
import { CONSULTANT_ROLES } from "../src/consilium/consultant-roles.ts";
import { consensusDigest } from "../src/consilium/consensus-contract.ts";
import { formatConfirmedMessageContentForMatrix } from "../src/matrix/bridge.ts";
import type { LeasedMatrixIngressIntent, MatrixIngressIntent } from "../src/godaddy/mysql-matrix-outbox.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import type { RegistrarStorage } from "../src/session/storage.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";
import { parseOwnerCommand, parseConsultationControl } from "../src/session/owner-commands.ts";

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(done => setImmediate(done)); };
const realSetTimeout = setTimeout;
const delay = (milliseconds: number) => new Promise<void>(resolve => realSetTimeout(resolve, milliseconds));
async function waitFor(description: string, condition: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!await condition()) {
    if (performance.now() >= deadline) assert.fail(`Timed out waiting for ${description}.`);
    await delay(5);
  }
}
async function waitForJob(f: Awaited<ReturnType<typeof fixture>>, expected: string): Promise<void> {
  // A durable status may be written before finally/media cleanup completes.
  // Wait for both so the next manually driven tick cannot race the old attempt.
  await waitFor(`job ${expected} and its worker to settle`, async () =>
    (await f.state())?.job?.status === expected && !f.service.status().working);
}

class SerialMemoryStorage extends MemoryRegistrarStorage {
  #tail = Promise.resolve();
  override transaction<T>(operation: (storage: RegistrarStorage) => Promise<T>): Promise<T> {
    const run = this.#tail.then(() => super.transaction(operation));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

async function fixture(executionBudgetMs?: number, media?: ConsultationMediaPort, explicitFixtureLanguage = true) {
  const storage = new SerialMemoryStorage();
  const registrar = new RegistrarDO({ storage: new SerialMemoryStorage(), now: () => activeNow });
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({ sessionId: "race-source", settingsRevision: 7,
    settings: receipt.defaults, capabilityReceipt: receipt }, activeNow);
  if (!snapshot.ok) throw new Error("Fixture snapshot unavailable.");
  const bindingHash = "b".repeat(64);
  await storage.put("worker", { version: 1, bindingHash, consent: true, job: null, handled: [], pending: null });
  const queue: LeasedMatrixIngressIntent[] = [];
  const plan = deferred<GoDaddyConsultationPlanResult>();
  const planEntered = deferred<void>();
  const prepareEntered = deferred<void>();
  let prepareGate: Promise<void> | undefined;
  let noticeGate: Promise<void> | undefined;
  let noticeEntered = deferred<void>();
  let ready = true;
  let leadership = true;
  let planCalls = 0;
  let snapshotCalls = 0;
  let eventNumber = 0;
  const requests: GoDaddyConsultationPlanRequest[] = [];
  let runPlan = (_request: GoDaddyConsultationPlanRequest): Promise<GoDaddyConsultationPlanResult> => plan.promise;
  let translate: GoDaddyConsiliumRuntime["translateServiceMessages"] | undefined;
  let translationCalls = 0;
  let run: GoDaddyConsiliumRuntime["run"] = async () => { throw new Error("Unexpected consilium execution."); };
  let canResumeFinalization: NonNullable<GoDaddyConsiliumRuntime["canResumeFinalization"]> = async () => false;
  let resumeFinalization: NonNullable<GoDaddyConsiliumRuntime["resumeFinalization"]> = async () => { throw new Error("Unexpected final-only recovery."); };
  const replySessions = new Map<string, string>();
  let signal: AbortSignal | undefined;
  const service = createMatrixConsultationService({
    storage, registrar, bindingHash, now: () => activeNow,
    ...(executionBudgetMs === undefined ? {} : { executionBudgetMs }),
    ...(media === undefined ? {} : { media }),
    resolveReplySession: async eventId => replySessions.get(eventId),
    ingress: {
      async leaseNext() { return queue.shift(); },
      async markProcessed() { return true; }
    },
    executor: {
      async plan(request) { planCalls += 1; requests.push(request); signal = request.signal; planEntered.resolve(); return runPlan(request); },
      async translateServiceMessages(request) { translationCalls++; return translate?.(request) ?? { ok: false, code: "translation_failed" as const }; },
      async run(request) { return run(request); },
      async canResumeFinalization(generation) { return canResumeFinalization(generation); },
      async resumeFinalization(request) { return resumeFinalization(request); }
    },
    async prepareSnapshot() { snapshotCalls += 1; prepareEntered.resolve(); await prepareGate; return snapshot.value; },
    async afterConfirmed() { if (noticeGate !== undefined) { noticeEntered.resolve(); await noticeGate; } },
    leadership: { async acquire() { return leadership; }, async check() { return leadership; }, async release() {} },
    assertReady() { if (!ready) throw new Error("Room temporarily unavailable."); }
  });
  return {
    service, storage, registrar, snapshot: snapshot.value, plan, planEntered, prepareEntered,
    enqueue(body: string, relationEventId?: string, media: MatrixIngressIntent["media"] = []) {
      // These historic race fixtures focus on transaction ordering, not language
      // ambiguity. Make their original Ukrainian-language choice explicit.
      if (explicitFixtureLanguage && parseOwnerCommand(body).kind === "ordinary_message" && parseConsultationControl(body) === undefined)
        body = "Відповідай українською. " + body;
      const eventId = `$owner-race-${++eventNumber}-${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
      const eventHash = createHash("sha256").update(eventId).digest("hex");
      const lease: LeasedMatrixIngressIntent = { eventId, eventHash, leaseOwner: "fixture-owner", leaseEpoch: 1,
        workIntent: { eventId, roomId: "!fixture:matrix.test", ownerMxid: "@owner:matrix.test", senderDeviceId: "DEVICE", body, media,
          ...(relationEventId === undefined ? {} : { relationEventId }) } };
      queue.push(lease);
      return lease;
    },
    replay(lease: LeasedMatrixIngressIntent) { queue.push(structuredClone(lease)); },
    usePlan(handler: typeof runPlan) { runPlan = handler; },
    useTranslation(handler: NonNullable<typeof translate>) { translate = handler; },
    useRun(handler: typeof run) { run = handler; },
    useFinalizationProbe(handler: typeof canResumeFinalization) { canResumeFinalization = handler; },
    useFinalizationRecovery(handler: typeof resumeFinalization) { resumeFinalization = handler; },
    translationCalls: () => translationCalls,
    setReplySession(eventId: string, sessionId: string) { replySessions.set(eventId, sessionId); },
    holdPrepare(gate: Promise<void>) { prepareGate = gate; },
    holdNotices(gate: Promise<void>) { noticeGate = gate; noticeEntered = deferred<void>(); return noticeEntered.promise; },
    clearNotices() { noticeGate = undefined; },
    setReady(value: boolean) { ready = value; },
    setLeadership(value: boolean) { leadership = value; },
    planCalls: () => planCalls,
    snapshotCalls: () => snapshotCalls,
    requests: () => requests,
    planSignal: () => signal,
    state: () => storage.get<{ job: null | { id: string; status: string; task: string; language?: string; languageConfirmed?: boolean; generation?: number }; pending: unknown }>("worker")
  };
}

test("a non-mutating owner command cannot swallow a concurrent direct answer or strand the job", async t => {
  const f = await fixture();
  const noticeRelease = deferred<void>();
  t.after(async () => { noticeRelease.resolve(); f.plan.resolve({ ok: false, code: "runtime_unavailable" }); await f.service.stop(); });
  f.enqueue("Скільки буде два плюс два?");
  await f.service.tick();
  await f.planEntered.promise;
  const noticeEntered = f.holdNotices(noticeRelease.promise);
  f.enqueue("Витрати");
  const controlTick = f.service.tick();
  await noticeEntered;
  f.plan.resolve({ ok: true, kind: "direct", answer: "Чотири." });
  await flush();
  f.clearNotices(); noticeRelease.resolve();
  await controlTick;
  await waitForJob(f, "completed");
  await f.service.tick();
  const session = await f.registrar.getActiveSession();
  assert.equal((await f.state())?.job?.status, "completed");
  assert.equal(session?.phase, "closed");
  assert.equal(f.planCalls(), 1, "a completed provider result must not require a second subscription turn");
  assert.equal((await f.registrar.getConfirmedMessages(session!.generation)).filter(message => message.body === "Чотири.").length, 1);
});

test("English first message localizes consent before provider work and the model confirms persistent language", async t => {
  const f = await fixture(undefined, undefined, false);
  t.after(() => f.service.stop());
  const state = await f.storage.get<{ consent: boolean }>("worker");
  state!.consent = false; await f.storage.put("worker", state);
  f.usePlan(async request => {
    assert.equal(request.language, undefined, "a provisional offline hint is not imposed on semantic language detection");
    assert.equal(request.taskId, (await f.state())?.job?.id);
    return { ok: true, kind: "direct", language: "en", answer: "Test one market before increasing spending." };
  });
  f.enqueue("How should I improve my business with the resources I have?");
  await f.service.tick();
  assert.equal((await f.state())?.job?.status, "awaiting_consent");
  assert.equal((await f.state())?.job?.language, "en");
  assert.equal((await f.state())?.job?.languageConfirmed, false);
  assert.equal(f.planCalls(), 0); assert.equal(f.snapshotCalls(), 0);
  const consentNotice = (await f.registrar.getConfirmedMessages(1)).at(-1)!;
  assert.match(consentNotice.body, /I consent to processing/u);
  assert.equal(consentNotice.language, "en");
  f.enqueue("I consent to processing");
  await f.service.tick(); await waitForJob(f, "completed");
  assert.equal((await f.state())?.job?.languageConfirmed, true);
  const session = await f.registrar.getActiveSession();
  const answer = (await f.registrar.getConfirmedMessages(session!.generation)).find(message => message.body.startsWith("Test one market"));
  assert.equal(answer?.role, "Head Consultant"); assert.equal(answer?.language, "en");
});

test("ambiguous first text asks one language question and never starts models before locale and consent", async t => {
  const f = await fixture(undefined, undefined, false);
  t.after(() => f.service.stop());
  const state = await f.storage.get<{ consent: boolean }>("worker");
  state!.consent = false; await f.storage.put("worker", state);
  f.usePlan(async request => {
    assert.equal(request.language, "es");
    return { ok: true, kind: "clarification", language: "es", answer: "¿Qué resultado quieres conseguir?" };
  });
  const event = f.enqueue("🚀");
  await f.service.tick();
  assert.equal((await f.state())?.job?.status, "awaiting_language");
  assert.equal(f.planCalls(), 0); assert.equal(f.snapshotCalls(), 0);
  const before = await f.registrar.getConfirmedMessages(1);
  assert.equal(before.length, 1); assert.match(before[0]!.body, /Which language/u);
  f.replay(event); await f.service.tick();
  assert.equal((await f.registrar.getConfirmedMessages(1)).length, 1);
  f.enqueue("Español"); await f.service.tick();
  assert.equal((await f.state())?.job?.status, "awaiting_consent");
  assert.equal((await f.state())?.job?.language, "es");
  assert.equal(f.planCalls(), 0);
  assert.match((await f.registrar.getConfirmedMessages(1)).at(-1)!.body, /Acepto el tratamiento/u);
  f.enqueue("Acepto el tratamiento"); await f.service.tick(); await waitForJob(f, "awaiting_clarification");
  assert.equal(f.planCalls(), 1);
});

test("an additional locale is not forced to English: consent precedes content-free translation and source-bound cache survives the next turn", async t => {
  const f = await fixture(undefined, undefined, false);
  t.after(() => f.service.stop());
  const state = await f.storage.get<{ consent: boolean }>("worker");
  state!.consent = false; await f.storage.put("worker", state);
  f.useTranslation(async request => {
    assert.deepEqual(Object.keys(request).sort(), ["language", "sessionGeneration", "signal"]);
    assert.equal(request.language, "ja");
    assert.equal((await f.storage.get<{ consent: boolean }>("worker"))?.consent, true);
    assert.ok(await f.registrar.getSession(request.sessionGeneration));
    const messages = Object.fromEntries(Object.entries(SERVICE_TRANSLATION_SOURCE).map(([id, body]) => [id, "翻訳テスト: " + body]));
    return { ok: true, catalog: { language: "ja", sourceHash: await serviceTranslationSourceHash(), messages } };
  });
  let turns = 0;
  f.usePlan(async request => {
    assert.equal(request.language, "ja"); turns++;
    return turns === 1 ? { ok: true, kind: "clarification", language: "ja", answer: "予算はいくらですか?" }
      : { ok: true, kind: "direct", language: "ja", answer: "小さな実験から始めましょう。" };
  });
  f.enqueue("Please reply in Japanese. Compare my two business options.");
  await f.service.tick();
  assert.equal((await f.state())?.job?.status, "awaiting_consent");
  assert.equal((await f.state())?.job?.language, "ja");
  assert.equal(f.translationCalls(), 0); assert.equal(f.planCalls(), 0);
  f.enqueue("I consent to processing"); await f.service.tick(); await waitForJob(f, "awaiting_clarification");
  assert.equal(f.translationCalls(), 1);
  assert.equal((await f.storage.get<{ language: string }>("service-translation:ja"))?.language, "ja");
  f.enqueue("My budget is one thousand dollars."); await f.service.tick(); await waitForJob(f, "completed");
  assert.equal(f.translationCalls(), 1, "the unchanged source catalog is not translated for every message or continuation");
  assert.equal((await f.state())?.job?.language, "ja");
  const session = await f.registrar.getActiveSession();
  const notices = await f.registrar.getConfirmedMessages(session!.generation);
  assert.ok(notices.some(message => message.body.startsWith("翻訳テスト:")));
  assert.ok(notices.some(message => message.body === "小さな実験から始めましょう。" && message.language === "ja"));
});

test("bound-consensus image observation is recorded verbatim without fake prior head authority and reaches the executor", async t => {
  const f = await fixture(undefined, {
    async prepare() { return { images: [{ mime: "image/jpeg", bytes: Uint8Array.from([255, 216, 255, 0, 1, 2, 3, 4]) }], text: "", release() {} }; },
    async erase() {}, async purgeExpired() {}
  }, false);
  t.after(() => f.service.stop());
  const role = (id: string) => ({ ...CONSULTANT_ROLES.find(item => item.agentId === id)!, provider: id === "critic" ? "claude_code" as const : "codex" as const, runtimeSessionRef: `${id}-image-fixture` });
  const head = role("head"), critic = role("critic"), specialists = [role("strategy"), role("finance")];
  const assignments = specialists.map(item => ({ agentId: item.agentId, question: `Assess ${item.role}.`, expectedOutcome: `Specific ${item.role} finding.`, facts: [], constraints: [], dependencies: [] }));
  const task = "Please assess the new financial chart in English.";
  const taskId = "a".repeat(64);
  const started = await f.registrar.startSession({ sessionId: "image-continuation-fixture", settingsSnapshot: f.snapshot });
  assert.ok(started.ok);
  assert.ok((await f.registrar.designateCritic({ generation: started.value.generation, critic })).ok);
  assert.ok((await f.registrar.initializeConsensus({ generation: started.value.generation, taskId, taskDigest: await consensusDigest(task), language: "en", head, critic, specialists, assignments })).ok);
  await f.storage.put("worker", { version: 1, bindingHash: "b".repeat(64), consent: true, handled: [], pending: null,
    job: { id: taskId, eventId: "$owner-image-task-0001", task, status: "queued", attempt: 1, generation: started.value.generation,
      sessionId: started.value.sessionId, language: "en", languageConfirmed: true,
      documents: [{ eventId: "$owner-image-file-0001", eventHash: "c".repeat(64), confirmed: true,
        manifest: [{ declaredMime: "image/jpeg", sha256: "d".repeat(64), length: 8 }] }] } });
  const observation = "The chart shows lower revenue in the second period; the vertical-axis unit is unreadable.";
  f.usePlan(async request => {
    assert.equal(request.images?.length, 1);
    return { ok: true, kind: "consilium", head, critic, specialists, assignments, language: "en", extractedEvidence: observation };
  });
  let calls = 0;
  f.useRun(async request => {
    calls++;
    assert.ok(request.task.includes(observation));
    assert.equal(request.taskId, taskId);
    assert.equal(request.language, "en");
    assert.deepEqual(request.assignments, assignments);
    return { ok: false, code: "runtime_unavailable" };
  });
  await f.service.tick(); await waitForJob(f, "failed");
  assert.equal(calls, 1);
  const message = (await f.registrar.getConfirmedMessages(started.value.generation)).find(item => item.body === observation);
  assert.ok(message);
  assert.equal(message.role, "Service"); assert.equal(message.authority, undefined);
  assert.match(formatConfirmedMessageContentForMatrix(message).body, /^🧭 Head Consultant · image observation/u);
  assert.ok(formatConfirmedMessageContentForMatrix(message).body.endsWith(observation));
});

test("quotes cannot switch confirmed language; explicit owner choice changes future messages without rewriting history", async t => {
  const f = await fixture(undefined, undefined, false);
  t.after(() => f.service.stop());
  let calls = 0;
  f.usePlan(async request => {
    calls++;
    if (calls === 1) return { ok: true, kind: "clarification", language: "en", answer: "What budget is available?" };
    if (calls === 2) {
      assert.equal(request.language, "en");
      return { ok: true, kind: "clarification", language: "en", answer: "What is your deadline?" };
    }
    assert.equal(request.language, "es");
    return { ok: true, kind: "direct", language: "es", answer: "Primero prueba una opción dentro del presupuesto." };
  });
  f.enqueue("Please reply in English. Help me compare the two business options.");
  await f.service.tick(); await waitForJob(f, "awaiting_clarification");
  const firstSession = await f.registrar.getActiveSession();
  const firstMessages = await f.registrar.getConfirmedMessages(firstSession!.generation);
  f.enqueue('> Reply in Spanish.\nMy budget is one thousand dollars.');
  await f.service.tick(); await waitForJob(f, "awaiting_clarification");
  assert.equal((await f.state())?.job?.language, "en");
  f.enqueue("Please reply in Spanish. The deadline is next week.");
  await f.service.tick(); await waitForJob(f, "completed");
  assert.equal((await f.state())?.job?.language, "es");
  assert.deepEqual((await f.registrar.getConfirmedMessages(firstSession!.generation)).slice(0, firstMessages.length), firstMessages);
});

test("Stop while snapshot preparation waits cannot leave a new active registrar session behind", async t => {
  const f = await fixture();
  const prepareRelease = deferred<void>();
  f.holdPrepare(prepareRelease.promise);
  t.after(async () => { prepareRelease.resolve(); f.plan.resolve({ ok: false, code: "runtime_unavailable" }); await f.service.stop(); });
  f.enqueue("Розгляньмо фінансове питання.");
  await f.service.tick();
  await f.prepareEntered.promise;
  f.enqueue("Стоп");
  await f.service.tick();
  prepareRelease.resolve();
  await waitForJob(f, "stopped");
  const session = await f.registrar.getActiveSession();
  assert.notEqual(session?.phase, "active", "cancelled intake must not reserve an orphan active consultation");
  assert.equal((await f.state())?.job?.status, "stopped");
  assert.equal(f.planCalls(), 0);
});

test("temporary readiness loss leaves an explicit resumable interruption, not a running job without execution", async t => {
  const f = await fixture();
  t.after(async () => { f.plan.resolve({ ok: false, code: "runtime_unavailable" }); await f.service.stop(); });
  f.enqueue("Допоможіть з робочою задачею.");
  await f.service.tick();
  await f.planEntered.promise;
  f.setReady(false);
  await f.service.tick();
  assert.equal(f.planSignal()?.aborted, true);
  f.plan.resolve({ ok: false, code: "runtime_unavailable" });
  await waitFor("the interrupted worker to settle", async () => !f.service.status().working);
  f.setReady(true);
  await f.service.tick();
  await flush();
  assert.equal(f.service.status().working, false);
  assert.ok(["interrupted", "failed", "stopped"].includes((await f.state())?.job?.status ?? ""),
    "readiness loss must persist a terminal/resumable attempt state");
  assert.equal(f.planCalls(), 1);
});

test("a stale leader may not stop the replacement leader's new generation", async t => {
  const f = await fixture();
  t.after(async () => { f.plan.resolve({ ok: false, code: "runtime_unavailable" }); await f.service.stop(); });
  f.enqueue("Початкове питання.");
  await f.service.tick();
  await f.planEntered.promise;
  const oldSession = await f.registrar.getActiveSession();
  assert.ok(oldSession);
  const revised = await f.registrar.reviseSession({ generation: oldSession.generation, revisionId: "replacement-leader-clarification" });
  assert.equal(revised.ok, true);
  if (!revised.ok) return;
  await f.storage.transaction(async storage => {
    const state = await storage.get<{ job: { generation: number } }>("worker");
    assert.ok(state);
    state.job.generation = revised.value.generation;
    await storage.put("worker", state);
  });
  f.setLeadership(false);
  await f.service.tick();
  assert.equal((await f.registrar.getSession(revised.value.generation))?.phase, "active",
    "stale ownership must never fence a generation read from the replacement worker's state");
});

test("the execution deadline asks for continuation even when the provider ignores cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(1_000);
  t.after(async () => { f.plan.resolve({ ok: false, code: "runtime_unavailable" }); await f.service.stop(); });
  f.enqueue("Довга консультація.");
  await f.service.tick();
  await f.planEntered.promise;
  // The injected provider deliberately never reacts to AbortSignal until cleanup.
  t.mock.timers.tick(1_000);
  await waitFor("the independent continuation notice", async () => {
    const session = await f.registrar.getActiveSession();
    return (await f.state())?.job?.status === "awaiting_continuation" && session !== undefined
      && (await f.registrar.getConfirmedMessages(session.generation)).some(message => message.body.includes("Напишіть «Продовжити»"));
  });
  assert.equal(f.planSignal()?.aborted, true);
  assert.equal((await f.state())?.job?.status, "awaiting_continuation");
  const session = await f.registrar.getActiveSession();
  assert.ok(session);
  const messages = await f.registrar.getConfirmedMessages(session.generation);
  assert.equal(messages.filter(message => message.body.includes("Напишіть «Продовжити»")).length, 1,
    "the time limit notice cannot wait for a provider response that may never arrive");
});

test("ordinary consultation requires one-time consent and does not ask again for a later task", async t => {
  // Confirmation hashing uses the native thread pool. Keep it pending beyond
  // a few event-loop turns so this test also exercises a slower Linux runner.
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, "digest", async (...arguments_: Parameters<typeof digest>) => {
    await delay(25);
    return digest(...arguments_);
  });
  const f = await fixture();
  t.after(() => f.service.stop());
  await f.storage.transaction(async storage => {
    const state = await storage.get<{ consent: boolean }>("worker");
    assert.ok(state); state.consent = false; await storage.put("worker", state);
  });
  f.usePlan(async () => ({ ok: true, kind: "direct", answer: "Відповідь на погоджений запит." }));
  f.enqueue("Як порівняти два робочі варіанти?");
  await f.service.tick(); await flush();
  assert.equal((await f.state())?.job?.status, "awaiting_consent");
  assert.equal(f.planCalls(), 0);
  assert.equal(f.snapshotCalls(), 0);
  f.enqueue("Ще одне уточнення до питання.");
  await f.service.tick(); await flush();
  assert.equal(f.planCalls(), 0);
  f.enqueue("Погоджуюсь на обробку");
  await f.service.tick(); await waitForJob(f, "completed");
  assert.equal(f.planCalls(), 1);
  assert.equal((await f.state())?.job?.status, "completed");
  f.enqueue("Інше коротке питання.");
  await f.service.tick(); await waitForJob(f, "completed");
  assert.equal(f.planCalls(), 2);
  assert.equal((await f.state())?.job?.status, "completed");
  assert.equal((await f.storage.get<{ consent: boolean }>("worker"))?.consent, true);
});

test("declining consent clears the held task without preparing settings or invoking the head", async t => {
  const f = await fixture();
  t.after(() => f.service.stop());
  await f.storage.transaction(async storage => {
    const state = await storage.get<{ consent: boolean }>("worker");
    assert.ok(state); state.consent = false; await storage.put("worker", state);
  });
  f.enqueue("Необроблена бізнес-задача.");
  await f.service.tick();
  f.enqueue("Не погоджуюсь");
  await f.service.tick(); await flush();
  assert.equal((await f.state())?.job, null);
  assert.equal((await f.storage.get<{ consent: boolean }>("worker"))?.consent, false);
  assert.equal(f.snapshotCalls(), 0);
  assert.equal(f.planCalls(), 0);
  assert.equal(await f.registrar.getActiveSession(), undefined);
});

test("replaying the same Matrix event during and after execution invokes the head exactly once", async t => {
  const f = await fixture();
  t.after(async () => { f.plan.resolve({ ok: false, code: "runtime_unavailable" }); await f.service.stop(); });
  const original = f.enqueue("Потрібна одна коротка відповідь.");
  await f.service.tick(); await f.planEntered.promise;
  f.replay(original);
  await f.service.tick(); await flush();
  assert.equal(f.planCalls(), 1);
  f.plan.resolve({ ok: true, kind: "direct", answer: "Єдина відповідь." });
  await waitForJob(f, "completed");
  f.replay(original);
  await f.service.tick(); await flush();
  assert.equal(f.planCalls(), 1);
  assert.equal(f.snapshotCalls(), 1);
  const session = await f.registrar.getActiveSession();
  assert.ok(session);
  assert.equal((await f.registrar.getConfirmedMessages(session.generation)).filter(m => m.body === "Єдина відповідь.").length, 1);
  assert.equal((await f.state())?.job?.status, "completed");
});

async function seedUncertainRun(f: Awaited<ReturnType<typeof fixture>>, closed = false) {
  const task = "Порівняйте інвестицію у виробниче обладнання та покращення процесу.";
  const id = createHash("sha256").update(task).digest("hex");
  const eventId = "$owner-crashed-task";
  const session = await f.registrar.startSession({ sessionId: "mx-" + id, settingsSnapshot: f.snapshot });
  assert.equal(session.ok, true);
  if (!session.ok) throw new Error("Could not seed registrar checkpoint.");
  await f.registrar.appendConfirmedMessage({ generation: session.value.generation, eventId: "prior-confirmed-evidence",
    role: "Фінансовий консультант", body: "Підтверджене попереднє спостереження: строк окупності ще невідомий." });
  if (closed) await f.registrar.closeSession(session.value.generation);
  await f.storage.put("worker", {
    version: 1, bindingHash: "b".repeat(64), consent: true,
    job: { id, eventId, task, documents: [], status: "running", attempt: 1,
      generation: session.value.generation, sessionId: session.value.sessionId },
    handled: [{ hash: id, sessionId: session.value.sessionId, generation: session.value.generation }], pending: null
  });
  return session.value;
}

test("uncertain running checkpoint never auto-relaunches; explicit continuation preserves snapshot and prior evidence", async t => {
  const f = await fixture();
  t.after(() => f.service.stop());
  const original = await seedUncertainRun(f);
  f.usePlan(async () => ({ ok: true, kind: "direct", answer: "Продовжена відповідь з попереднім контекстом." }));
  await f.service.tick(); await flush();
  await f.service.tick(); await flush();
  assert.equal(f.planCalls(), 0);
  assert.equal(f.snapshotCalls(), 0);
  assert.equal((await f.state())?.job?.status, "interrupted");
  assert.equal((await f.registrar.getSession(original.generation))?.phase, "closed");
  f.enqueue("Продовжити");
  await f.service.tick(); await waitForJob(f, "completed");
  assert.equal(f.planCalls(), 1);
  assert.equal(f.snapshotCalls(), 0, "continuation must not refresh original settings");
  assert.match(f.requests()[0]!.task, /Порівняйте інвестицію/u);
  assert.match(f.requests()[0]!.task, /строк окупності ще невідомий/u);
  const resumed = await f.registrar.getActiveSession();
  assert.ok(resumed);
  assert.equal(resumed.previousGeneration, original.generation);
  assert.equal(resumed.sessionId, original.sessionId);
  assert.equal(resumed.startedAt, original.startedAt);
  assert.deepEqual(resumed.settingsSnapshot, original.settingsSnapshot);
  assert.equal((await f.state())?.job?.status, "completed");
});

test("a failed final-only reuse probe falls back to the fenced full continuation instead of blocking ingress", async t => {
  const f = await fixture();
  t.after(() => f.service.stop());
  const original = await seedUncertainRun(f);
  f.useFinalizationProbe(async () => { throw new Error("simulated unreadable optional checkpoint"); });
  f.usePlan(async () => ({ ok: true, kind: "direct", answer: "Recovered through the normal continuation path." }));
  await f.service.tick();
  f.enqueue("Продовжити");
  await f.service.tick();
  await waitForJob(f, "completed");
  assert.equal(f.service.status().blocked, false);
  assert.equal(f.planCalls(), 1);
  const resumed = await f.registrar.getActiveSession();
  assert.equal(resumed?.generation, original.generation + 1);
  assert.equal(resumed?.previousGeneration, original.generation);
});

test("answering a head clarification keeps the logical session, original settings and full question context", async t => {
  const f = await fixture();
  t.after(() => f.service.stop());
  f.usePlan(async () => f.planCalls() === 1
    ? { ok: true, kind: "clarification", answer: "Який бюджет цього рішення?" }
    : { ok: true, kind: "direct", answer: "Тепер можна порівняти варіанти в межах зазначеного бюджету." });
  const initial = f.enqueue("Порівняйте два варіанти розвитку бізнесу.");
  await f.service.tick(); await waitForJob(f, "awaiting_clarification");
  const firstSession = await f.registrar.getActiveSession();
  assert.ok(firstSession);
  assert.equal(firstSession.phase, "active");
  assert.equal((await f.state())?.job?.status, "awaiting_clarification");
  f.enqueue("Бюджет становить сто тисяч гривень.", initial.eventId);
  await f.service.tick(); await waitForJob(f, "completed");
  const resumed = await f.registrar.getActiveSession();
  assert.ok(resumed);
  assert.equal(f.planCalls(), 2);
  assert.equal(f.snapshotCalls(), 1);
  assert.equal(resumed.sessionId, firstSession.sessionId);
  assert.deepEqual(resumed.settingsSnapshot, firstSession.settingsSnapshot);
  assert.equal(resumed.previousGeneration, firstSession.generation);
  assert.match(f.requests()[1]!.task, /Порівняйте два варіанти/u);
  assert.match(f.requests()[1]!.task, /Який бюджет цього рішення/u);
  assert.match(f.requests()[1]!.task, /сто тисяч гривень/u);
  assert.equal((await f.state())?.job?.status, "completed");
});

test("Stop prevents a late provider final even when the provider resolves successfully after cancellation", async t => {
  const f = await fixture();
  t.after(async () => { f.plan.resolve({ ok: false, code: "runtime_unavailable" }); await f.service.stop(); });
  f.enqueue("Питання, яке буде скасовано.");
  await f.service.tick(); await f.planEntered.promise;
  const session = await f.registrar.getActiveSession();
  assert.ok(session);
  f.enqueue("Стоп");
  await f.service.tick();
  assert.equal(f.planSignal()?.aborted, true);
  f.plan.resolve({ ok: true, kind: "direct", answer: "Ця запізніла відповідь не має бути опублікована." });
  await waitForJob(f, "stopped");
  assert.equal((await f.state())?.job?.status, "stopped");
  assert.equal((await f.registrar.getSession(session.generation))?.phase, "stopped");
  assert.equal((await f.registrar.getConfirmedMessages(session.generation)).some(m => m.body.includes("Ця запізніла відповідь")), false);
  assert.equal(f.planCalls(), 1);
});

test("a committed normal close at the crash checkpoint is recovered as completed without another provider call", async t => {
  const f = await fixture();
  t.after(() => f.service.stop());
  const original = await seedUncertainRun(f, true);
  const before = await f.registrar.getConfirmedMessages(original.generation);
  await f.service.tick(); await flush();
  assert.equal((await f.state())?.job?.status, "completed");
  assert.equal(f.planCalls(), 0);
  assert.equal(f.snapshotCalls(), 0);
  assert.deepEqual(await f.registrar.getConfirmedMessages(original.generation), before);
});

test("confirmed attachments remain available through clarification and are erased only after final completion", async t => {
  let available = true;
  let preparations = 0;
  const erased: string[] = [];
  const f = await fixture(undefined, {
    async prepare(documents) {
      preparations += 1;
      assert.equal(documents.every(document => document.confirmed), true);
      return available ? { images: [], text: "Підтверджені дані: результат за минулий рік зріс.", release() {} } : undefined;
    },
    async erase(hash) { erased.push(hash); available = false; },
    async purgeExpired() {}
  });
  t.after(() => f.service.stop());
  f.usePlan(async () => f.planCalls() === 1
    ? { ok: true, kind: "clarification", answer: "З яким попереднім періодом порівняти документ?" }
    : { ok: true, kind: "direct", answer: "Документ порівняно з указаним періодом." });
  const document = f.enqueue("Проаналізуйте цей звіт.", undefined, [
    { declaredMime: "application/pdf", length: 128, sha256: "a".repeat(64) }
  ]);
  await f.service.tick(); await flush();
  assert.equal(f.planCalls(), 0);
  f.enqueue("Підтверджую документ без секретів", document.eventId);
  await f.service.tick(); await waitForJob(f, "awaiting_clarification");
  assert.equal((await f.state())?.job?.status, "awaiting_clarification");
  assert.equal(f.planCalls(), 1);
  assert.deepEqual(erased, [], "clarification is not a completed consultation");
  f.enqueue("Порівняйте з попереднім роком.", document.eventId);
  await f.service.tick(); await waitForJob(f, "completed");
  assert.equal(f.planCalls(), 2);
  assert.equal(preparations, 2);
  assert.match(f.requests()[1]!.task, /Підтверджені дані/u);
  assert.equal((await f.state())?.job?.status, "completed");
  assert.deepEqual(erased, [document.eventHash]);
});

test("a native reply to the bot clarification joins only its confirmed logical session", async t => {
  const f = await fixture();
  t.after(() => f.service.stop());
  f.usePlan(async () => f.planCalls() === 1
    ? { ok: true, kind: "clarification", answer: "Якого результату потрібно досягти?" }
    : { ok: true, kind: "direct", answer: "Відповідь у контексті підтвердженої сесії." });
  f.enqueue("Потрібна порада щодо операційного процесу.");
  await f.service.tick(); await waitForJob(f, "awaiting_clarification");
  const original = await f.registrar.getActiveSession();
  assert.ok(original);
  f.setReplySession("$bot-unrelated-session-event", "some-other-logical-session");
  f.enqueue("Це уточнення стосується іншої задачі.", "$bot-unrelated-session-event");
  await f.service.tick(); await flush();
  assert.equal(f.planCalls(), 1);
  assert.equal((await f.state())?.job?.status, "awaiting_clarification");
  assert.equal((await f.registrar.getActiveSession())?.generation, original.generation);
  f.setReplySession("$bot-confirmed-question-event", original.sessionId);
  f.enqueue("Хочу скоротити час виконання замовлень.", "$bot-confirmed-question-event");
  await f.service.tick(); await waitForJob(f, "completed");
  assert.equal(f.planCalls(), 2);
  assert.equal((await f.registrar.getActiveSession())?.sessionId, original.sessionId);
  assert.match(f.requests()[1]!.task, /скоротити час виконання/u);
  assert.doesNotMatch(f.requests()[1]!.task, /Це уточнення стосується іншої задачі/u);
  assert.equal((await f.state())?.job?.status, "completed");
});

test("attachments across separate messages cannot exceed the total byte bound or poison durable control state", async t => {
  const erased: string[] = [];
  const f = await fixture(undefined, {
    async prepare() { throw new Error("Unconfirmed documents must never reach a provider."); },
    async erase(hash) { erased.push(hash); }, async purgeExpired() {}
  });
  t.after(() => f.service.stop());
  const manifest = { declaredMime: "application/pdf" as const, length: 20 * 1024 * 1024, sha256: "c".repeat(64) };
  const first = f.enqueue("Зіставте ці документи.", undefined, [manifest, manifest, manifest]);
  await f.service.tick();
  const excess = f.enqueue("Ще один документ.", first.eventId, [manifest]);
  await f.service.tick(); await flush();
  assert.equal(f.service.status().blocked, false);
  assert.equal(f.planCalls(), 0);
  assert.equal((await f.state())?.job?.status, "awaiting_document");
  assert.deepEqual(erased, [excess.eventHash]);
  f.enqueue("Стоп");
  await f.service.tick();
  assert.equal((await f.state())?.job?.status, "stopped");
  assert.deepEqual(erased, [excess.eventHash, first.eventHash]);
});
