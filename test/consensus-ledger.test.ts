import assert from "node:assert/strict";
import test from "node:test";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { consensusDigest, consensusPositionsDigest, hasConsensus, type ConsensusConfirmation, type ConsensusDispatch } from "../src/consilium/consensus-contract.ts";
import { CONSULTANT_ROLES } from "../src/consilium/consultant-roles.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

async function fixture(projectConfirmedMessage?: ConstructorParameters<typeof RegistrarDO>[0]["projectConfirmedMessage"]) {
  const storage = new MemoryRegistrarStorage();
  const registrar = new RegistrarDO({ storage, now: () => activeNow, ...(projectConfirmedMessage ? { projectConfirmedMessage } : {}) });
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({ sessionId: "task-source", settingsRevision: 1, settings: receipt.defaults, capabilityReceipt: receipt }, activeNow);
  assert.ok(snapshot.ok);
  await registrar.startSession({ sessionId: "consensus-task", settingsSnapshot: snapshot.value });
  const role = (id: string) => ({ ...CONSULTANT_ROLES.find(a => a.agentId === id)!,
    provider: (id === "critic" ? "claude_code" : "codex") as "claude_code" | "codex", runtimeSessionRef: `thread-${id}` });
  const head = role("head"), critic = role("critic"), specialists = [role("strategy"), role("finance")];
  const assignments = specialists.map(a => ({ agentId: a.agentId, question: `Evaluate ${a.agentId}`, expectedOutcome: `A ${a.agentId} decision`, facts: [], constraints: [], dependencies: [] }));
  const initialization = { generation: 1, taskId: "logical-task-0001", taskDigest: await consensusDigest("Original owner request"), language: "en", head, critic, specialists, assignments };
  assert.ok((await registrar.designateCritic({ generation: 1, critic })).ok);
  assert.ok((await registrar.initializeConsensus(initialization)).ok);
  let serial = 0;
  const dispatch = (kind: ConsensusDispatch["kind"], actorAgentId: string, affectedSpecialistIds: string[] = [], proposalDigest?: string): ConsensusDispatch => ({
    generation: 1, taskId: initialization.taskId, dispatchId: `consensus-message-${++serial}`, kind, actorAgentId, affectedSpecialistIds,
    ...(proposalDigest === undefined ? {} : { proposalDigest }) });
  const commit = async (d: ConsensusDispatch, body: string, extra: Partial<ConsensusConfirmation> = {}) => {
    assert.ok((await registrar.reserveConsensusDispatch(d)).ok);
    return registrar.confirmConsensusMessage({ ...d, messageId: d.dispatchId, body, addressedTo: [], ...extra });
  };
  const proposal = async () => {
    for (const specialist of specialists) assert.ok((await commit(dispatch("position", specialist.agentId), `Position by ${specialist.agentId}`)).ok);
    const state = (await registrar.getConsensus(initialization.taskId))!;
    const body = "Choose a reversible pilot. Owner: you. Review actual costs next week.";
    const positionsDigest = await consensusPositionsDigest(state.positions);
    assert.ok((await commit(dispatch("proposal", "head"), body, { positionsDigest })).ok);
    return { body, digest: await consensusDigest(body), positionsDigest };
  };
  return { registrar, storage, initialization, dispatch, commit, proposal };
}

test("Critic message, count and canonical outbox commit exactly once", async () => {
  const f = await fixture(); const p = await f.proposal();
  const d = f.dispatch("critic_review", "critic", ["strategy", "finance"], p.digest);
  const confirmation = { ...d, messageId: d.dispatchId, body: "Agree; the limits are explicit.", addressedTo: ["strategy", "finance"], decision: "agree" as const, positionsDigest: p.positionsDigest };
  assert.ok((await f.registrar.reserveConsensusDispatch(d)).ok);
  assert.equal((await f.registrar.reserveConsensusDispatch(d)).ok, false, "in-flight replay must not dispatch again");
  const result = await f.registrar.confirmConsensusMessage(confirmation); assert.ok(result.ok);
  assert.equal((await f.registrar.confirmConsensusMessage(confirmation)).replayed, true);
  const replay = await f.registrar.reserveConsensusDispatch(d); assert.ok(replay.ok); assert.equal(replay.value.confirmed?.body, confirmation.body);
  assert.deepEqual((await f.registrar.getConsensus(f.initialization.taskId))?.critiqueCounts, { strategy: 1, finance: 1 });
  assert.equal((await f.registrar.getLocalMatrixOutboxRecordForTest(1, result.value.sequence))?.message.body, confirmation.body);
  assert.equal((await f.registrar.confirmConsensusMessage({ ...confirmation, decision: "revise" })).ok, false);
});

test("concurrent reservations cannot create the eighth Critic message, including approvals", async () => {
  const f = await fixture(); const p = await f.proposal();
  for (let index = 0; index < 6; index++) assert.ok((await f.commit(f.dispatch("critic_review", "critic", ["strategy"], p.digest), "Agree with the current proposal.", { decision: "agree", positionsDigest: p.positionsDigest })).ok);
  const seventh = f.dispatch("critic_review", "critic", ["strategy"], p.digest);
  const eighth = f.dispatch("critic_review", "critic", ["strategy", "finance"], p.digest);
  const results = await Promise.all([f.registrar.reserveConsensusDispatch(seventh), f.registrar.reserveConsensusDispatch(eighth)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.ok((await f.registrar.confirmConsensusMessage({ ...seventh, messageId: seventh.dispatchId, body: "Agree.", addressedTo: ["strategy"], decision: "agree", positionsDigest: p.positionsDigest })).ok);
  assert.deepEqual(await f.registrar.reserveConsensusDispatch(eighth), { ok: false, code: "critic_limit_reached" });
  assert.equal((await f.registrar.getConsensus(f.initialization.taskId))?.critiqueCounts.strategy, 7);
});

test("outbox failure rolls back the count, message and proposal approval together", async () => {
  let failProjection = false;
  const f = await fixture(async (storage, record) => {
    if (failProjection) throw new Error("projection unavailable");
    await storage.put(`registrar:matrix-outbox:${record.generation}:${record.sequence}`, record);
  });
  const p = await f.proposal(); failProjection = true;
  const d = f.dispatch("critic_review", "critic", ["strategy"], p.digest);
  assert.ok((await f.registrar.reserveConsensusDispatch(d)).ok);
  const confirmation = { ...d, messageId: d.dispatchId, body: "Agree.", addressedTo: ["strategy"], decision: "agree" as const, positionsDigest: p.positionsDigest };
  await assert.rejects(f.registrar.confirmConsensusMessage(confirmation), /projection unavailable/);
  assert.equal((await f.registrar.getConsensus(f.initialization.taskId))?.critiqueCounts.strategy, 0);
  assert.equal((await f.registrar.getConfirmedMessages(1)).length, 3);
  failProjection = false; assert.ok((await f.registrar.confirmConsensusMessage(confirmation)).ok);
  assert.equal((await f.registrar.getConsensus(f.initialization.taskId))?.critiqueCounts.strategy, 1);
});

test("all actors must explicitly agree to the same exact proposal; final is immutable and unique", async () => {
  const f = await fixture(); const p = await f.proposal();
  const final = f.dispatch("final", "head", [], p.digest);
  assert.equal((await f.registrar.reserveConsensusDispatch(final)).ok, false);
  for (const id of ["strategy", "finance"]) {
    assert.ok((await f.commit(f.dispatch("specialist_review", id, [id], p.digest), "Agree.", { decision: "agree", positionsDigest: p.positionsDigest })).ok);
    assert.ok((await f.commit(f.dispatch("critic_review", "critic", [id], p.digest), "Agree; evidence is qualified.", { decision: "agree", positionsDigest: p.positionsDigest })).ok);
  }
  assert.equal(hasConsensus((await f.registrar.getConsensus(f.initialization.taskId))!), false);
  assert.ok((await f.commit(f.dispatch("head_review", "head", [], p.digest), "I agree with this exact candidate.", { decision: "agree", positionsDigest: p.positionsDigest })).ok);
  assert.equal(hasConsensus((await f.registrar.getConsensus(f.initialization.taskId))!), true);
  assert.ok((await f.registrar.reserveConsensusDispatch(final)).ok);
  const confirmation = { ...final, messageId: final.dispatchId, body: p.body, addressedTo: [], positionsDigest: p.positionsDigest };
  assert.equal((await f.registrar.confirmConsensusMessage({ ...confirmation, body: p.body + " Also guarantee profit." })).ok, false);
  const done = await f.registrar.confirmConsensusMessage(confirmation); assert.ok(done.ok);
  assert.equal((await f.registrar.getActiveSession())?.phase, "closed");
  assert.equal((await f.registrar.getConsensus(f.initialization.taskId))?.status, "published");
  assert.equal((await f.registrar.confirmConsensusMessage(confirmation)).replayed, true);
  assert.equal((await f.registrar.reserveConsensusDispatch(f.dispatch("final", "head", [], p.digest))).ok, false);
});

test("position changes invalidate old approvals and stale review reservations", async () => {
  const f = await fixture(); const p = await f.proposal();
  const stale = f.dispatch("critic_review", "critic", ["strategy"], p.digest);
  assert.ok((await f.registrar.reserveConsensusDispatch(stale)).ok);
  assert.ok((await f.commit(f.dispatch("position", "strategy"), "A newly qualified position.")).ok);
  assert.equal((await f.registrar.confirmConsensusMessage({ ...stale, messageId: stale.dispatchId, body: "Agree.", addressedTo: [], decision: "agree", positionsDigest: p.positionsDigest })).ok, false);
  assert.equal(hasConsensus((await f.registrar.getConsensus(f.initialization.taskId))!), false);
});

test("restart and explicit Continue preserve task counts, reject a new task ID on revision", async () => {
  const f = await fixture(); const p = await f.proposal();
  assert.ok((await f.commit(f.dispatch("critic_review", "critic", ["strategy"], p.digest), "Rework the assumptions.", { decision: "revise", positionsDigest: p.positionsDigest })).ok);
  const restarted = new RegistrarDO({ storage: f.storage, now: () => activeNow });
  assert.equal((await restarted.getConsensus(f.initialization.taskId))?.critiqueCounts.strategy, 1);
  const revised = await restarted.reviseSession({ generation: 1, revisionId: "owner-explicit-continue" }); assert.ok(revised.ok);
  const critic = { ...f.initialization.critic, runtimeSessionRef: "new-critic-context" };
  assert.ok((await restarted.designateCritic({ generation: 2, critic })).ok);
  assert.equal((await restarted.initializeConsensus({ ...f.initialization, generation: 2, critic, taskId: "fake-reset-task" })).ok, false);
  assert.ok((await restarted.initializeConsensus({ ...f.initialization, generation: 2, critic })).ok);
  assert.equal((await restarted.getConsensus(f.initialization.taskId))?.critiqueCounts.strategy, 1);
  assert.equal((await restarted.reserveConsensusDispatch(f.dispatch("position", "strategy"))).ok, false);
});

test("Stop fences an already reserved reply; forged Critic actor cannot spend or approve", async () => {
  const f = await fixture(); const p = await f.proposal();
  assert.equal((await f.registrar.reserveConsensusDispatch(f.dispatch("critic_review", "strategy", ["finance"], p.digest))).ok, false);
  const d = f.dispatch("critic_review", "critic", ["strategy"], p.digest);
  assert.ok((await f.registrar.reserveConsensusDispatch(d)).ok);
  await f.registrar.stopSession(1);
  assert.equal((await f.registrar.confirmConsensusMessage({ ...d, messageId: d.dispatchId, body: "Agree.", addressedTo: [], decision: "agree", positionsDigest: p.positionsDigest })).ok, false);
  assert.equal((await f.registrar.getConsensus(f.initialization.taskId))?.critiqueCounts.strategy, 0);
});

test("a changed owner task refreshes positions without resetting lifetime Critic counts", async () => {
  const f = await fixture(); const p = await f.proposal();
  assert.ok((await f.commit(f.dispatch("critic_review", "critic", ["finance"], p.digest), "Revise the forecast.", { decision: "revise", positionsDigest: p.positionsDigest })).ok);
  assert.ok((await f.registrar.reviseSession({ generation: 1, revisionId: "owner-updates-task" })).ok);
  assert.ok((await f.registrar.designateCritic({ generation: 2, critic: f.initialization.critic })).ok);
  const result = await f.registrar.initializeConsensus({ ...f.initialization, generation: 2, taskDigest: await consensusDigest("Materially changed owner request") });
  assert.ok(result.ok);
  assert.equal(result.value.critiqueCounts.finance, 1);
  assert.equal(result.value.proposalVersion, 1);
  assert.deepEqual(result.value.positions, {});
  assert.equal(result.value.proposal, undefined);
  assert.deepEqual(result.value.reviews, []);
});

test("durable state corruption is rejected instead of becoming an approval or count reset", async () => {
  const f = await fixture(); await f.proposal();
  const key = `registrar:consensus:${f.initialization.taskId}`;
  const stored = (await f.storage.get<Record<string, unknown>>(key))!;
  await f.storage.put(key, { ...stored, critiqueCounts: { strategy: 0, finance: 6 } });
  await assert.rejects(f.registrar.getConsensus(f.initialization.taskId), /integrity/);
});
