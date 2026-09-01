import assert from "node:assert/strict";
import test from "node:test";

import { CodexHeadSynthesizer } from "../src/runtime/codex-head-synthesizer.ts";
import { CodexAppServerThreadClient } from "../src/runtime/codex-thread-client.ts";
import { JsonRpcClient } from "../src/runtime/json-rpc-client.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";

const jsonFinal = JSON.stringify({
  decision: "Одна перевірена рекомендація.",
  actions: [{ action: "Почати дію", owner: "Власник", timeframe: "Сьогодні", evidence: "Є перший результат." }],
  riskOrAssumption: "Попит ще треба перевірити.",
  reviewCondition: "Переглянути після першого факту.",
  technicalPart: "Передати це в технічний чат."
});

async function preparedRegistrar() {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({ sessionId: "head-settings", settingsRevision: 1, settings: receipt.defaults, capabilityReceipt: receipt }, activeNow);
  if (!snapshot.ok) throw new Error("Expected snapshot.");
  const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
  await registrar.startSession({ sessionId: "head-session", settingsSnapshot: snapshot.value });
  await registrar.appendConfirmedMessage({ generation: 1, eventId: "head-finance-0001", role: "Фінансовий консультант", body: "Перша позиція." });
  await registrar.appendConfirmedMessage({ generation: 1, eventId: "head-strategy-0001", role: "Стратег", body: "Друга позиція." });
  await registrar.appendConfirmedMessage({ generation: 1, eventId: "head-critic-0001", role: "Критик", body: "Критика." });
  await registrar.recordCriticReview({ generation: 1, eventId: "head-critic-0001", role: "Критик" });
  return registrar;
}

function headClient(body: string) {
  const sent: Record<string, unknown>[] = [];
  let listener: ((line: string) => void) | undefined;
  const channel = {
    send: async (line: string): Promise<void> => {
      const message = JSON.parse(line) as Record<string, unknown>;
      sent.push(message);
      const reply = (value: unknown): void => listener?.(JSON.stringify(value));
      if (message.method === "initialize") reply({ id: message.id, result: {} });
      if (message.method === "turn/start") {
        reply({ id: message.id, result: { turn: { id: "head-turn-0001", status: "inProgress", items: [] } } });
        queueMicrotask(() => reply({ method: "item/completed", params: {
          threadId: "thread-head-01", turnId: "head-turn-0001", item: { type: "agentMessage", id: "head-item", text: body }
        } }));
        queueMicrotask(() => reply({ method: "turn/completed", params: {
          threadId: "thread-head-01", turn: { id: "head-turn-0001", status: "completed", items: [] }
        } }));
      }
    },
    onLine(next: (line: string) => void): () => void { listener = next; return () => { listener = undefined; }; }
  };
  return { sent, client: new CodexAppServerThreadClient({ rpc: new JsonRpcClient({ channel }), clientInfo: { name: "personal-consultant", title: "Personal Consultant", version: "0.1.0" } }) };
}

test("the head turns confirmed specialist and critic messages into one schema-validated final recommendation", async () => {
  const registrar = await preparedRegistrar();
  const harness = headClient(jsonFinal);
  const head = new CodexHeadSynthesizer({
    registrar,
    head: { agentId: "head", role: "Головний консультант", provider: "codex", runtimeSessionRef: "thread-head-01" },
    critic: { agentId: "critic", role: "Критик", provider: "claude_code", runtimeSessionRef: "claude-critic-process-01" },
    lease: { threadId: "thread-head-01", modelId: "codex-runtime-primary" },
    threadClient: harness.client,
    reasoningEffort: "high"
  });
  const result = await head.synthesize({ sessionGeneration: 1, task: "Дай фінальний висновок." });
  assert.deepEqual(result, { ok: true, messageId: "pc-head-turn-0001", recommendation: JSON.parse(jsonFinal) });
  const turn = harness.sent.find((message) => message.method === "turn/start");
  assert.ok(turn !== undefined);
  assert.equal((turn.params as { outputSchema?: unknown }).outputSchema !== undefined, true);
});

test("does not synthesize before a confirmed Claude critique and rejects malformed model output", async () => {
  const registrar = await preparedRegistrar();
  const noCritic = new CodexHeadSynthesizer({
    registrar: new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow }),
    head: { agentId: "head", role: "Головний консультант", provider: "codex", runtimeSessionRef: "thread-head-01" },
    critic: { agentId: "critic", role: "Критик", provider: "claude_code", runtimeSessionRef: "claude-critic-process-01" },
    lease: { threadId: "thread-head-01", modelId: "codex-runtime-primary" }, threadClient: headClient(jsonFinal).client, reasoningEffort: "high"
  });
  assert.deepEqual(await noCritic.synthesize({ sessionGeneration: 1, task: "x" }), { ok: false, code: "critic_not_confirmed" });

  const malformed = new CodexHeadSynthesizer({
    registrar,
    head: { agentId: "head", role: "Головний консультант", provider: "codex", runtimeSessionRef: "thread-head-01" },
    critic: { agentId: "critic", role: "Критик", provider: "claude_code", runtimeSessionRef: "claude-critic-process-01" },
    lease: { threadId: "thread-head-01", modelId: "codex-runtime-primary" }, threadClient: headClient("not-json").client, reasoningEffort: "high"
  });
  assert.deepEqual(await malformed.synthesize({ sessionGeneration: 1, task: "x" }), { ok: false, code: "invalid_head_response" });
});
