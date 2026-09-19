import assert from "node:assert/strict";
import test from "node:test";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { consensusDigest, consensusPositionsDigest, hasConsensus, type ConsensusConfirmation, type ConsensusDispatch } from "../src/consilium/consensus-contract.ts";
import { CONSULTANT_ROLES } from "../src/consilium/consultant-roles.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import type { RegistrarStorage } from "../src/session/storage.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

const sqlKeyOrder = (value: unknown): unknown => Array.isArray(value) ? value.map(sqlKeyOrder)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.length - right.length || left.localeCompare(right))
    .map(([key, field]) => [key, sqlKeyOrder(field)])) : value;
function sqlOrdered(storage: RegistrarStorage): RegistrarStorage {
  return {
    async get<T>(key: string) { return sqlKeyOrder(await storage.get<T>(key)) as T | undefined; },
    put: (key, value) => storage.put(key, value),
    transaction: operation => storage.transaction(transaction => operation(sqlOrdered(transaction)))
  };
}

async function fixture() {
  const storage = new MemoryRegistrarStorage();
  const registrar = new RegistrarDO({ storage: sqlOrdered(storage), now: () => activeNow });
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({ sessionId: "review-source", settingsRevision: 1, settings: receipt.defaults, capabilityReceipt: receipt }, activeNow);
  assert.ok(snapshot.ok);
  assert.ok((await registrar.startSession({ sessionId: "review-session", settingsSnapshot: snapshot.value })).ok);
  const role = (id: string) => ({ ...CONSULTANT_ROLES.find(actor => actor.agentId === id)!,
    provider: (id === "critic" ? "claude_code" : "codex") as "claude_code" | "codex", runtimeSessionRef: `review-thread-${id}` });
  const head = role("head"), critic = role("critic"), specialists = [role("strategy"), role("finance")];
  const initialization = { generation: 1, taskId: "review-logical-task", taskDigest: await consensusDigest("Original task"), language: "en",
    head, critic, specialists, assignments: specialists.map(actor => ({ agentId: actor.agentId, question: `Evaluate ${actor.agentId}`,
      expectedOutcome: `A ${actor.agentId} decision`, facts: [], constraints: [], dependencies: [] })) };
  assert.ok((await registrar.designateCritic({ generation: 1, critic })).ok);
  assert.ok((await registrar.initializeConsensus(initialization)).ok);
  let serial = 0;
  const dispatch = (kind: ConsensusDispatch["kind"], actorAgentId: string, affectedSpecialistIds: string[] = [], proposalDigest?: string): ConsensusDispatch => ({
    generation: 1, taskId: initialization.taskId, dispatchId: `review-dispatch-${++serial}`, kind, actorAgentId, affectedSpecialistIds,
    ...(proposalDigest === undefined ? {} : { proposalDigest }) });
  const commit = async (d: ConsensusDispatch, body: string, extra: Partial<ConsensusConfirmation> = {}) => {
    assert.ok((await registrar.reserveConsensusDispatch(d)).ok);
    return registrar.confirmConsensusMessage({ ...d, body, messageId: d.dispatchId, addressedTo: [], ...extra });
  };
  const proposal = async () => {
    for (const specialist of specialists) assert.ok((await commit(dispatch("position", specialist.agentId), `Initial ${specialist.agentId} advice`)).ok);
    const body = "Run a bounded pilot and inspect the measured result before expanding.";
    const positionsDigest = await consensusPositionsDigest((await registrar.getConsensus(initialization.taskId))!.positions);
    assert.ok((await commit(dispatch("proposal", "head"), body, { positionsDigest })).ok);
    return { body, digest: await consensusDigest(body), positionsDigest };
  };
  return { storage, registrar, initialization, dispatch, commit, proposal };
}

test("review: SQL object-key reordering preserves reservation identity, confirmation replay and final fingerprint", async () => {
  const f = await fixture();
  const p = await f.proposal();
  for (const id of ["strategy", "finance"]) {
    assert.ok((await f.commit(f.dispatch("specialist_review", id, [id], p.digest), "I agree with this candidate.", { decision: "agree", positionsDigest: p.positionsDigest })).ok);
  }
  const d = f.dispatch("critic_review", "critic", ["strategy", "finance"], p.digest);
  assert.ok((await f.registrar.reserveConsensusDispatch(d)).ok);
  const message: ConsensusConfirmation = { ...d, messageId: d.dispatchId, body: "Agree with both positions and the candidate.",
    addressedTo: ["strategy", "finance"], decision: "agree", positionsDigest: p.positionsDigest };
  assert.ok((await f.registrar.confirmConsensusMessage(message)).ok);
  assert.equal((await f.registrar.confirmConsensusMessage(sqlKeyOrder(message) as ConsensusConfirmation)).replayed, true);
  const replay = await f.registrar.reserveConsensusDispatch(sqlKeyOrder(d) as ConsensusDispatch);
  assert.ok(replay.ok);
  assert.equal(replay.value.confirmed?.body, message.body);
  assert.ok((await f.commit(f.dispatch("head_review", "head", [], p.digest), "I agree.", { decision: "agree", positionsDigest: p.positionsDigest })).ok);
  assert.equal(hasConsensus((await f.registrar.getConsensus(f.initialization.taskId))!), true);
  const final = await f.commit(f.dispatch("final", "head", [], p.digest), p.body, { positionsDigest: p.positionsDigest });
  assert.ok(final.ok);
  assert.equal((await f.registrar.getLocalDeliveryRecordForTest(1, final.value.sequence))?.message.body, p.body);
  assert.deepEqual(await f.registrar.reviseSession({ generation: 1, revisionId: "reopen-published-attempt" }), { ok: false, code: "session_not_active" });
  assert.equal((await f.registrar.getActiveSession())?.generation, 1);
});

test("review: Critic cannot address an uncounted specialist or bypass ledger through legacy append", async () => {
  const f = await fixture();
  const p = await f.proposal();
  const d = f.dispatch("critic_review", "critic", ["strategy"], p.digest);
  assert.ok((await f.registrar.reserveConsensusDispatch(d)).ok);
  const result = await f.registrar.confirmConsensusMessage({ ...d, messageId: d.dispatchId, body: "Finance, revise these assumptions.",
    addressedTo: ["finance"], decision: "revise", positionsDigest: p.positionsDigest });
  assert.equal(result.ok, false);
  assert.deepEqual((await f.registrar.getConsensus(f.initialization.taskId))?.critiqueCounts, { finance: 0, strategy: 0 });
  assert.equal((await f.registrar.appendConfirmedMessage({ generation: 1, eventId: "legacy-final-bypass", role: "Head Consultant", body: "Unreviewed final." })).ok, false);
});

test("review: a same-text proposal over new positions does not revive old approval reservations", async () => {
  const f = await fixture();
  const p = await f.proposal();
  const old = f.dispatch("critic_review", "critic", ["strategy"], p.digest);
  assert.ok((await f.registrar.reserveConsensusDispatch(old)).ok);
  assert.ok((await f.commit(f.dispatch("position", "finance"), "Costs have changed; constrain the pilot further.")).ok);
  const positionsDigest = await consensusPositionsDigest((await f.registrar.getConsensus(f.initialization.taskId))!.positions);
  assert.ok((await f.commit(f.dispatch("proposal", "head"), p.body, { positionsDigest })).ok);
  assert.equal((await f.registrar.confirmConsensusMessage({ ...old, messageId: old.dispatchId, body: "I agree with the earlier costs.",
    addressedTo: ["strategy"], decision: "agree", positionsDigest: p.positionsDigest })).ok, false);
  assert.equal(hasConsensus((await f.registrar.getConsensus(f.initialization.taskId))!), false);
});

test("review: durable review/count corruption fails closed instead of becoming consensus", async () => {
  const f = await fixture();
  await f.proposal();
  const key = `registrar:consensus:${f.initialization.taskId}`;
  const stored = (await f.storage.get<Record<string, unknown>>(key))!;
  await f.storage.put(key, { ...stored, reviews: [{ actorAgentId: "critic", decision: "agree" }], critiqueCounts: { strategy: 0, finance: 0 } });
  await assert.rejects(f.registrar.getConsensus(f.initialization.taskId), /Invalid durable consensus/u);
});
