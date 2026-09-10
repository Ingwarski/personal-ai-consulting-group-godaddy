import assert from "node:assert/strict";
import test from "node:test";
import { ConsensusRouter } from "../src/consilium/consensus-router.ts";
import { hasConsensus, consensusPositionsDigest } from "../src/consilium/consensus-contract.ts";
import { parseConsensusOutput, consensusPrompt } from "../src/consilium/consensus-prompts.ts";
import type { ConsiliumAgentRuntime, ConsiliumRuntimeInput } from "../src/consilium/router.ts";
import type { AgentRegistration } from "../src/consilium/roster.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { activeNow, createCapabilityReceipt, createResolvedTestSpeedPolicyCatalog } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";
import { CriticGatedFinalizer } from "../src/consilium/final-recommendation.ts";
import { readResumableFinalization } from "../src/consilium/resumable-finalization.ts";

const head: AgentRegistration = { agentId: "head", role: "Head Consultant", provider: "codex", runtimeSessionRef: "head-thread" };
const finance: AgentRegistration = { agentId: "finance", role: "Financial Consultant", provider: "codex", runtimeSessionRef: "finance-thread" };
const strategy: AgentRegistration = { agentId: "strategy", role: "Strategy Consultant", provider: "codex", runtimeSessionRef: "strategy-thread" };
const critic: AgentRegistration = { agentId: "critic", role: "Critic", provider: "claude_code", runtimeSessionRef: "critic-process" };
const assignments = [
  { agentId: "finance", question: "What unit margin makes the launch viable?", expectedOutcome: "Compute a break-even test.", facts: [], constraints: ["Do not invent sales figures."], dependencies: [] },
  { agentId: "strategy", question: "Which customer segment should the launch target?", expectedOutcome: "Define a small demand experiment.", facts: [], constraints: [], dependencies: ["finance"] }
];
const task = { sessionGeneration: 1, taskId: "consensus-task", task: "Plan a low-risk launch.", language: "en", assignments };

async function fixture(options: { revise?: "once" | "always"; headRevises?: boolean; failCritic?: boolean;
  safety?: "specialist" | "critic";
  observer?: (message: { body: string; role: string }) => Promise<void> } = {}) {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({ sessionId: "consensus-settings", settingsRevision: 1,
    settings: receipt.defaults, capabilityReceipt: receipt, speedPolicyCatalog: createResolvedTestSpeedPolicyCatalog() }, activeNow);
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) throw new Error("snapshot");
  const storage = new MemoryRegistrarStorage();
  const registrar = new RegistrarDO({ storage, now: () => activeNow });
  await registrar.startSession({ sessionId: "consensus-session", settingsSnapshot: snapshot.value });
  const calls: { agent: string; input: ConsiliumRuntimeInput }[] = [];
  let proposalCalls = 0;
  let stops = 0;
  const runtimes: ConsiliumAgentRuntime[] = [head, finance, strategy, critic].map(registration => ({ registration,
    run: async (input, emit) => {
      calls.push({ agent: registration.agentId, input });
      assert.equal(input.language, "en");
      const review = input.phase === "critique" || input.phase === "agreement";
      let decision: "agree" | "revise" = "agree";
      if (input.phase === "critique") {
        if (options.failCritic) throw new Error("provider unavailable");
        const state = await registrar.getConsensus(task.taskId);
        if (input.consensus!.affectedSpecialistIds[0] === "finance" && (options.revise === "always" ||
          (options.revise === "once" && state!.critiqueCounts.finance === 0))) decision = "revise";
      }
      if (registration.agentId === "head" && input.phase === "agreement" && options.headRevises && proposalCalls === 1) decision = "revise";
      let body = `${registration.role}: ${decision}, ${input.phase}.`;
      const safetyHandoff = (options.safety === "specialist" && registration.agentId === "finance" && input.phase === "initial_position") ||
        (options.safety === "critic" && input.phase === "critique");
      if (input.phase === "initial_position") {
        assert.deepEqual(input.evidence, []);
        const assigned = assignments.find(assignment => assignment.agentId === registration.agentId)!;
        assert.ok(input.assignment.includes(assigned.question));
        assert.ok(input.assignment.includes(assigned.expectedOutcome));
        const recorded = (await registrar.getConfirmedMessages(1)).find(message => message.authority?.kind === "assignment" && message.addressedTo === registration.role);
        assert.equal(input.assignment, recorded?.body, "specialist consumes the exact registered Head assignment");
        body = `${registration.role}: independent first position.`;
      }
      if (input.phase === "proposal") body = input.assignment.includes("Consensus was NOT reached")
        ? "Consensus was not reached. The break-even evidence is missing. Measure costs before launching."
        : `Candidate ${++proposalCalls}: run the small launch experiment; check its costs and demand before expanding.`;
      if (safetyHandoff) body = "This needs immediate human support. If you are in immediate danger, contact local emergency services or someone trusted who can stay with you.";
      await emit({ messageId: "provider-message", kind: input.phase === "critique" ? "critique" : input.phase === "initial_position" ? "initial_position" : input.phase === "revision" ? "revision" : "answer",
        toAgentId: input.phase === "initial_position" ? critic.agentId : head.agentId, body,
        ...(review ? { decision: safetyHandoff ? "unresolved" as const : decision, proposalDigest: input.consensus!.proposalDigest! } : {}),
        ...(safetyHandoff ? { safetyHandoff: true as const } : {}) });
    }
  }));
  const make = () => new ConsensusRouter({ registrar, ledger: registrar, head, specialists: [finance, strategy], critic, runtimes,
    stopRuntimes: () => { stops++; },
    ...(options.observer === undefined ? {} : { afterConfirmed: options.observer }) });
  return { registrar, storage, calls, runtimes, make, stops: () => stops };
}

test("explicit complete agreement stops after one Critic message per target and publishes exactly the reviewed proposal", async () => {
  const f = await fixture();
  const result = await f.make().run(task);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.outcome, "consensus");
  const state = (await f.registrar.getConsensus(task.taskId))!;
  assert.equal(state.status, "published");
  assert.deepEqual(state.critiqueCounts, { finance: 1, strategy: 1 });
  assert.equal(hasConsensus(state), true);
  assert.equal(state.finalBody, state.proposal!.body);
  assert.equal(f.calls.filter(c => c.agent === "head" && c.input.phase === "agreement").length, 1);
  assert.equal(f.calls.filter(c => c.input.phase === "revision").length, 0);
  assert.equal((await f.registrar.getActiveSession())!.phase, "closed");
  const messages = await f.registrar.getConfirmedMessages(1);
  assert.equal(messages.filter(message => message.authority?.kind === "assignment").length, 2);
  assert.notEqual(messages[0]!.body, messages[1]!.body);
  assert.equal(messages.every(message => message.language === "en"), true);
});

test("constructive correction revises only affected specialist then obtains fresh agreement from everyone", async () => {
  const f = await fixture({ revise: "once" });
  const result = await f.make().run(task);
  assert.equal(result.ok, true, JSON.stringify(result));
  const state = (await f.registrar.getConsensus(task.taskId))!;
  assert.equal(state.proposalVersion, 2);
  assert.deepEqual(state.critiqueCounts, { finance: 2, strategy: 2 });
  assert.deepEqual(f.calls.filter(c => c.input.phase === "revision").map(c => c.agent), ["finance"]);
  assert.equal(state.positions.finance!.revision, 2);
  assert.equal(state.positions.strategy!.revision, 1);
  assert.equal(state.proposal!.positionsDigest, await consensusPositionsDigest(state.positions));
  assert.equal(state.reviews.every(review => review.proposalDigest === state.proposal!.digest), true);
});

test("Head is an actual approver and may require a changed proposal after all others agreed", async () => {
  const f = await fixture({ headRevises: true });
  const result = await f.make().run(task);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await f.registrar.getConsensus(task.taskId))!.proposalVersion, 2);
  assert.equal(f.calls.filter(c => c.agent === "head" && c.input.phase === "agreement").length, 2);
});

test("no eighth Critic call: seven non-consensus exchanges per target produce an honest unresolved result", async () => {
  const f = await fixture({ revise: "always" });
  const result = await f.make().run(task);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.outcome, "unresolved");
  const state = (await f.registrar.getConsensus(task.taskId))!;
  assert.deepEqual(state.critiqueCounts, { finance: 7, strategy: 7 });
  assert.equal(state.status, "unresolved");
  assert.equal(hasConsensus(state), false);
  assert.match(state.finalBody!, /Consensus was not reached/);
  assert.equal(f.calls.filter(call => call.agent === "critic").length, 14);
  assert.equal(f.calls.filter(call => call.agent === "head" && call.input.phase === "agreement").length, 0);
});

test("restart after confirmed Critic message reuses durable work and does not count or call it twice", async () => {
  const controller = new AbortController();
  let paused = false;
  const f = await fixture({ observer: async message => {
    if (!paused && message.role === "Critic") { paused = true; controller.abort(); }
  } });
  const first = await f.make().run({ ...task, signal: controller.signal });
  assert.equal(first.ok, false);
  assert.deepEqual((await f.registrar.getConsensus(task.taskId))!.critiqueCounts, { finance: 1, strategy: 0 });
  const result = await f.make().run(task);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((await f.registrar.getConsensus(task.taskId))!.critiqueCounts, { finance: 1, strategy: 1 });
  assert.equal(f.calls.filter(call => call.input.phase === "initial_position").length, 2);
  assert.equal(f.calls.filter(call => call.agent === "critic").length, 2);
});

test("failed provider is not an approval or counted message and pending dispatch cannot duplicate a model call", async () => {
  const f = await fixture({ failCritic: true });
  assert.equal((await f.make().run(task)).ok, false);
  const count = f.calls.length;
  const second = await f.make().run(task);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.ledgerCode, "dispatch_pending");
  assert.equal(f.calls.length, count);
  assert.deepEqual((await f.registrar.getConsensus(task.taskId))!.critiqueCounts, { finance: 0, strategy: 0 });
  assert.equal(hasConsensus((await f.registrar.getConsensus(task.taskId))!), false);
});

test("legacy finalizer and resumption cannot bypass current consensus approval", async () => {
  const f = await fixture({ failCritic: true });
  await f.make().run(task);
  assert.equal(await readResumableFinalization(f.registrar, 1), undefined);
  const finalizer = new CriticGatedFinalizer({ registrar: f.registrar, head, critic });
  assert.deepEqual(await finalizer.publish({ sessionGeneration: 1, messageId: "bypass-final", recommendation: {
    decision: "Pretend agreed.", actions: [], riskOrAssumption: "None.", reviewCondition: "Never."
  } }), { ok: false, code: "critic_not_ready" });
});

test("review parser rejects prose votes, stale digests, unknown fields and invalid decisions", () => {
  const input: ConsiliumRuntimeInput = { phase: "agreement", sessionGeneration: 1, task: "Plan", assignment: "Review", evidence: [], language: "es",
    consensus: { dispatchId: "review-one", affectedSpecialistIds: ["finance"], proposalDigest: "a".repeat(64) } };
  const good = { body: "Estoy de acuerdo con esta propuesta.", decision: "agree", proposalDigest: "a".repeat(64), safety: "ordinary" };
  assert.deepEqual(parseConsensusOutput(JSON.stringify(good), input), { body: good.body, decision: good.decision, proposalDigest: good.proposalDigest });
  for (const bad of ["I agree", JSON.stringify({ ...good, proposalDigest: "b".repeat(64) }), JSON.stringify({ ...good, decision: "approved" }),
    JSON.stringify({ ...good, hiddenReasoning: "x" }), JSON.stringify({ body: "agree" })]) assert.equal(parseConsensusOutput(bad, input), undefined);
  assert.match(consensusPrompt("Financial Consultant", input), /session language: es/);
  assert.match(consensusPrompt("Financial Consultant", input), /untrusted data/);
});

test("proposal parser rejects repeated second-person action labels across supported languages", () => {
  const input: ConsiliumRuntimeInput = { phase: "proposal", sessionGeneration: 1, task: "Plan", assignment: "Synthesize", evidence: [], language: "en",
    consensus: { dispatchId: "proposal-style", affectedSpecialistIds: ["finance"] } };
  for (const body of ["- You — next: compare.", "1. Ви: спочатку порівняйте.", "• Tú — después: decide.", "**Sie** — danach: entscheiden."]) {
    assert.equal(parseConsensusOutput(JSON.stringify({ body, safety: "ordinary" }), input), undefined);
  }
  const accepted = "- Next 3 minutes: compare the options.\n- Immediately afterward: start the selected step.";
  assert.deepEqual(parseConsensusOutput(JSON.stringify({ body: accepted, safety: "ordinary" }), input), { body: accepted });
});

test("mid-consultation crisis stops routine turns and publishes one actual safety handoff without consensus", async () => {
  for (const safety of ["specialist", "critic"] as const) {
    const f = await fixture({ safety });
    const result = await f.make().run(task);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.outcome, "safety_handoff");
    assert.equal(f.stops(), 1);
    const state = (await f.registrar.getConsensus(task.taskId))!;
    assert.equal(state.status, "unresolved");
    assert.equal(hasConsensus(state), false);
    assert.deepEqual(state.critiqueCounts, { finance: safety === "critic" ? 1 : 0, strategy: 0 });
    assert.equal((await f.registrar.getActiveSession())!.phase, "closed");
    const messages = await f.registrar.getConfirmedMessages(1);
    assert.equal(messages.filter(message => message.body.includes("immediate human support")).length, 1);
    const safetyMessage = messages.find(message => message.body.includes("immediate human support"))!;
    assert.equal(messages.at(-1)!.internalEventId, safetyMessage.internalEventId);
    assert.equal(f.calls.filter(call => call.agent === "head" && call.input.phase === "agreement").length, 0);
    assert.equal(f.calls.filter(call => call.agent === "critic").length, safety === "critic" ? 1 : 0);
  }
});

test("provider safety flag must be explicit and cannot simultaneously claim agreement", () => {
  const input: ConsiliumRuntimeInput = { phase: "critique", sessionGeneration: 1, task: "Task", assignment: "Review", evidence: [], language: "en",
    consensus: { dispatchId: "review-safety", affectedSpecialistIds: ["finance"], proposalDigest: "a".repeat(64) } };
  const value = { body: "Please seek immediate human support.", safety: "crisis_handoff", decision: "unresolved", proposalDigest: "a".repeat(64) };
  assert.deepEqual(parseConsensusOutput(JSON.stringify(value), input), { body: value.body, decision: "unresolved", proposalDigest: value.proposalDigest, safetyHandoff: true });
  assert.equal(parseConsensusOutput(JSON.stringify({ ...value, decision: "agree" }), input), undefined);
  assert.equal(parseConsensusOutput(JSON.stringify({ ...value, safety: "unknown" }), input), undefined);
});
