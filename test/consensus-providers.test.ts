import assert from "node:assert/strict";
import test from "node:test";
import { CodexConsiliumAgentRuntime, CodexCriticRuntime, CodexHeadThreadRuntime } from "../src/runtime/codex-consilium-agent.ts";
import { ClaudeCodeCriticRuntime, type ClaudeCodeSubscriptionProcess } from "../src/runtime/claude-code-critic.ts";
import type { CodexAppServerThreadClient } from "../src/runtime/codex-thread-client.ts";
import type { ConsiliumAgentRuntime, ConsiliumRuntimeInput, RuntimeEmission } from "../src/consilium/router.ts";
import { createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

const digest = "a".repeat(64);
const review: ConsiliumRuntimeInput = {
  phase: "agreement", sessionGeneration: 1, task: "Evalúa una expansión pequeña.", assignment: "Review the candidate.", language: "es",
  evidence: [{ fromRole: "Financial Consultant", body: "Posición financiera." }, { fromRole: "Head Consultant", body: "Propuesta común." }],
  consensus: { dispatchId: "review-0001", affectedSpecialistIds: ["finance"], proposalDigest: digest }
};

function codexStub(body: string) {
  const calls: Parameters<CodexAppServerThreadClient["runTextTurn"]>[0][] = [];
  const client = { runTextTurn: async (input: Parameters<CodexAppServerThreadClient["runTextTurn"]>[0]) => {
    calls.push(input); return { ok: true, body, turnId: "provider-turn-0001" };
  } } as unknown as CodexAppServerThreadClient;
  return { client, calls };
}

test("Codex specialist, designated Critic and Head use strict structured votes with session language and independent efforts", async () => {
  for (const role of ["specialist", "critic", "head"] as const) {
    const f = codexStub(JSON.stringify({ body: "Estoy de acuerdo con la propuesta completa.", decision: "agree", proposalDigest: digest, safety: "ordinary" }));
    const lease = { threadId: `${role}-thread`, modelId: role === "critic" ? "gpt-6-astra" : "head-model" };
    const registration = { agentId: role === "specialist" ? "finance" : role, role: role === "specialist" ? "Financial Consultant" : role === "critic" ? "Critic" : "Head Consultant",
      provider: "codex" as const, runtimeSessionRef: lease.threadId };
    const runtime: ConsiliumAgentRuntime = role === "specialist" ? new CodexConsiliumAgentRuntime({ registration, lease,
      threadClient: f.client, headAgentId: "head", criticAgentId: "critic", reasoningEffort: "high" }) :
      role === "critic" ? new CodexCriticRuntime({ registration, lease, threadClient: f.client, headAgentId: "head", reasoningEffort: "xhigh" }) :
      new CodexHeadThreadRuntime({ registration, lease, threadClient: f.client, reasoningEffort: "high" });
    const emitted: RuntimeEmission[] = [];
    await runtime.run({ ...review, phase: role === "critic" ? "critique" : "agreement" }, async message => { emitted.push(message); });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.decision, "agree");
    assert.equal(emitted[0]!.proposalDigest, digest);
    assert.equal(emitted[0]!.body, "Estoy de acuerdo con la propuesta completa.");
    assert.equal(f.calls[0]!.reasoningEffort, role === "critic" ? "xhigh" : "high");
    assert.match(f.calls[0]!.body, /session language: es/);
    assert.ok(f.calls[0]!.outputSchema);
    assert.equal(f.calls[0]!.lease.threadId, `${role}-thread`);
  }
});

test("Head creates the candidate as a separately completed body, not an assumed approval", async () => {
  const f = codexStub(JSON.stringify({ body: "Propuesta pendiente de revisión.", safety: "ordinary" }));
  const runtime = new CodexHeadThreadRuntime({ registration: { agentId: "head", role: "Head Consultant", provider: "codex", runtimeSessionRef: "head-thread" },
    lease: { threadId: "head-thread", modelId: "head-model" }, threadClient: f.client, reasoningEffort: "high" });
  const emitted: RuntimeEmission[] = [];
  await runtime.run({ ...review, phase: "proposal", consensus: { dispatchId: "proposal-1", affectedSpecialistIds: ["finance"] } }, async message => { emitted.push(message); });
  assert.equal(emitted[0]!.body, "Propuesta pendiente de revisión.");
  assert.equal(emitted[0]!.decision, undefined);
  assert.equal(emitted[0]!.proposalDigest, undefined);
});

test("a stale or unstructured Codex vote emits no message and cannot become consensus", async () => {
  for (const body of ["I agree", JSON.stringify({ body: "Agree.", decision: "agree", proposalDigest: "b".repeat(64), safety: "ordinary" })]) {
    const f = codexStub(body);
    const runtime = new CodexCriticRuntime({ registration: { agentId: "critic", role: "Critic", provider: "codex", runtimeSessionRef: "critic-thread" },
      lease: { threadId: "critic-thread", modelId: "gpt-6-astra" }, threadClient: f.client, headAgentId: "head", reasoningEffort: "xhigh" });
    const emitted: RuntimeEmission[] = [];
    await assert.rejects(runtime.run({ ...review, phase: "critique" }, async message => { emitted.push(message); }), /invalid_runtime_emission/);
    assert.equal(emitted.length, 0);
  }
});

test("Claude uses the same exact review contract without changing its subscription/model/effort gate", async () => {
  const receipt = createCapabilityReceipt();
  let calls = 0;
  const process: ClaudeCodeSubscriptionProcess = {
    inspectSubscription: async () => ({ processRef: "claude-process", authMode: "claude_code_oauth", readiness: "ready",
      privateSingleOwner: true, bareMode: false, fastModeEnabled: false, extraUsageEnabled: false, models: receipt.claudeModels }),
    runCritique: async input => {
      calls++;
      assert.equal(input.modelId, "claude-current-critic");
      assert.equal(input.reasoningEffort, "high");
      assert.match(input.prompt, /session language: es/);
      assert.match(input.prompt, new RegExp(digest));
      return { turnRef: "claude-turn", body: JSON.stringify({ body: "Debe precisarse el coste del experimento.", decision: "revise", proposalDigest: digest, safety: "ordinary" }) };
    }
  };
  const runtime = new ClaudeCodeCriticRuntime({ registration: { agentId: "critic", role: "Critic", provider: "claude_code", runtimeSessionRef: "claude-process" },
    process, headAgentId: "head", modelId: "claude-current-critic", reasoningEffort: "high" });
  const emitted: RuntimeEmission[] = [];
  await runtime.run({ ...review, phase: "critique" }, async message => { emitted.push(message); });
  assert.equal(calls, 1);
  assert.equal(emitted[0]!.decision, "revise");
  assert.equal(emitted[0]!.proposalDigest, digest);
  assert.equal(emitted[0]!.body, "Debe precisarse el coste del experimento.");
});
