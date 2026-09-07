import assert from "node:assert/strict";
import test from "node:test";
import { createMatrixConsultationService } from "../src/godaddy/matrix-consultation-service.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { consensusDigest, consensusPositionsDigest, type ConsensusDispatch, type ConsensusConfirmation } from "../src/consilium/consensus-contract.ts";
import { CONSULTANT_ROLES } from "../src/consilium/consultant-roles.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const role = (id: string) => ({ ...CONSULTANT_ROLES.find(item => item.agentId === id)!,
  provider: id === "critic" ? "claude_code" as const : "codex" as const, runtimeSessionRef: `${id}-runtime` });
const head = role("head"), critic = role("critic"), specialists = [role("finance"), role("strategy")];
const assignments = specialists.map(specialist => ({ agentId: specialist.agentId, question: `Evaluate ${specialist.role}.`,
  expectedOutcome: `Specific ${specialist.role} advice.`, facts: [], constraints: [], dependencies: [] }));

for (const terminal of ["final", "safety"] as const) test(`a durable ${terminal} completion wins over a delayed executor return and the deadline`, async t => {
  const storage = new MemoryRegistrarStorage();
  const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({ sessionId: "recovery-settings", settingsRevision: 1,
    settings: receipt.defaults, capabilityReceipt: receipt }, activeNow);
  assert.ok(snapshot.ok);
  const taskId = "a".repeat(64);
  const bindingHash = "b".repeat(64);
  const ownerTask = "Please assess my business plan in English.";
  await storage.put("worker", { version: 1, bindingHash, consent: true, handled: [], pending: null,
    job: { id: taskId, eventId: "$owner-task-0001", task: ownerTask, documents: [], status: "queued", attempt: 0,
      language: "en", languageConfirmed: true } });
  const committed = deferred(), release = deferred();
  let runCalls = 0;
  const service = createMatrixConsultationService({ storage, registrar, bindingHash, now: () => activeNow,
    executionBudgetMs: 100, progressIntervalMs: 45_000,
    ingress: { async leaseNext() { return undefined; }, async markProcessed() { return true; } },
    leadership: { async acquire() { return true; }, async check() { return true; }, async release() {} },
    assertReady() {}, async afterConfirmed() {}, async prepareSnapshot() { return snapshot.value; },
    executor: {
      async plan() { return { ok: true, kind: "consilium", language: "en", head, critic, specialists, assignments, extractedEvidence: "" }; },
      async run(request) {
        runCalls++;
        assert.ok((await registrar.designateCritic({ generation: request.sessionGeneration, critic })).ok);
        assert.ok((await registrar.initializeConsensus({ generation: request.sessionGeneration, taskId, taskDigest: await consensusDigest(ownerTask),
          language: "en", head, critic, specialists, assignments })).ok);
        let serial = 0;
        const confirm = async (kind: ConsensusDispatch["kind"], actorAgentId: string, body: string,
          extra: Partial<ConsensusConfirmation> = {}) => {
          const dispatch: ConsensusDispatch = { generation: request.sessionGeneration, taskId, dispatchId: `recovery-${++serial}`, kind, actorAgentId,
            affectedSpecialistIds: kind === "critic_review" ? specialists.map(s => s.agentId) : kind === "specialist_review" ? [actorAgentId] : [],
            ...(extra.proposalDigest === undefined ? {} : { proposalDigest: extra.proposalDigest }) };
          assert.ok((await registrar.reserveConsensusDispatch(dispatch)).ok);
          const result = await registrar.confirmConsensusMessage({ ...dispatch, messageId: dispatch.dispatchId, body, addressedTo: [], ...extra });
          assert.ok(result.ok);
          return result.value;
        };
        let final;
        if (terminal === "safety") final = await confirm("position", "finance", "Please seek appropriate immediate human support.", { safetyHandoff: true });
        else {
          for (const specialist of specialists) await confirm("position", specialist.agentId, `Position by ${specialist.role}.`);
          const state = (await registrar.getConsensus(taskId))!;
          const body = "Run a small reversible experiment and measure the actual outcome.";
          const positionsDigest = await consensusPositionsDigest(state.positions);
          await confirm("proposal", "head", body, { positionsDigest });
          const proposalDigest = await consensusDigest(body);
          for (const specialist of specialists) await confirm("specialist_review", specialist.agentId, "I agree with this exact proposal.", { proposalDigest, positionsDigest, decision: "agree" });
          await confirm("critic_review", "critic", "I agree with the current proposal and both specialist positions.", { proposalDigest, positionsDigest, decision: "agree" });
          await confirm("head_review", "head", "I explicitly agree with this proposal.", { proposalDigest, positionsDigest, decision: "agree" });
          final = await confirm("final", "head", body, { proposalDigest, positionsDigest });
        }
        committed.resolve();
        await release.promise; // Models/cleanup/publication callbacks may return late.
        return { ok: true, outcome: terminal === "final" ? "consensus" : "safety_handoff",
          final: { ok: true, visibleSequence: final.sequence, replayed: false } };
      }
    }
  });
  t.after(async () => { release.resolve(); await service.stop(); });
  await service.tick();
  await committed.promise;
  assert.equal((await registrar.getActiveSession())!.phase, "closed");
  await delay(160);
  release.resolve();
  for (let i = 0; i < 20 && service.status().working; i++) await delay(5);
  const state = await storage.get<{ job: { status: string } }>("worker");
  assert.equal(state!.job.status, "completed", "a committed outcome must not become a continuation request");
  assert.equal(runCalls, 1);
  assert.equal((await registrar.getConfirmedMessages(1)).some(message => /write.*Continue|напишіть.*Продовжити/iu.test(message.body)), false);
});

test("a changed authorized document changes the consensus task digest even when the owner text is unchanged", async t => {
  const observed: string[] = [];
  for (const documentHash of ["c".repeat(64), "d".repeat(64)]) {
    const storage = new MemoryRegistrarStorage();
    const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
    const receipt = createCapabilityReceipt();
    const snapshot = resolveEffectiveSessionSnapshot({ sessionId: "document-recovery-settings", settingsRevision: 1,
      settings: receipt.defaults, capabilityReceipt: receipt }, activeNow);
    assert.ok(snapshot.ok);
    const bindingHash = "b".repeat(64);
    await storage.put("worker", { version: 1, bindingHash, consent: true, handled: [], pending: null,
      job: { id: "a".repeat(64), eventId: "$owner-docs-0001", task: "Please assess this business report in English.",
        documents: [{ eventHash: documentHash, eventId: "$owner-file-0001", confirmed: true,
          manifest: [{ sha256: documentHash, length: 128, declaredMime: "application/pdf" }] }],
        status: "queued", attempt: 0, language: "en", languageConfirmed: true } });
    const executed = deferred();
    const service = createMatrixConsultationService({ storage, registrar, bindingHash, now: () => activeNow,
      ingress: { async leaseNext() { return undefined; }, async markProcessed() { return true; } },
      leadership: { async acquire() { return true; }, async check() { return true; }, async release() {} },
      assertReady() {}, async afterConfirmed() {}, async prepareSnapshot() { return snapshot.value; },
      media: { async prepare() { return { images: [], text: documentHash.startsWith("c") ? "Revenue declined." : "Revenue increased.", release() {} }; },
        async erase() {}, async purgeExpired() {} },
      executor: {
        async plan() { return { ok: true, kind: "consilium", language: "en", head, critic, specialists, assignments, extractedEvidence: "" }; },
        async run(request) { observed.push(request.taskDigest!); executed.resolve(); return { ok: false, code: "runtime_unavailable" }; }
      }
    });
    t.after(() => service.stop());
    await service.tick();
    await executed.promise;
    await service.stop();
  }
  assert.equal(observed.length, 2);
  assert.notEqual(observed[0], observed[1], "new evidence must invalidate approvals; hashing only owner text loses document changes");
});
