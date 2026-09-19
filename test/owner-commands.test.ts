import assert from "node:assert/strict";
import test from "node:test";

import { parseCostReport } from "../src/costs/cost-report.ts";
import { OwnerCommandService, parseOwnerCommand, parseConsultationControl } from "../src/session/owner-commands.ts";
import { SERVICE_LANGUAGES, SERVICE_MESSAGES, serviceMessage, LANGUAGE_QUESTION } from "../src/consilium/service-messages.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";

const rawCostReport = {
  reportedAt: "2026-08-16T18:00:00.000Z",
  subscriptions: [
    { provider: "ChatGPT/Codex", status: "unknown" },
    { provider: "Claude Code", status: "unknown" }
  ],
  infrastructure: [],
  providerUsage: [
    { provider: "Codex", status: "unavailable", reportedAt: "2026-08-16T18:00:00.000Z" },
    { provider: "Claude Code", status: "unavailable", reportedAt: "2026-08-16T18:00:00.000Z" }
  ]
};

async function commandHarness() {
  const receipt = createCapabilityReceipt();
  const initial = resolveEffectiveSessionSnapshot({ sessionId: "command-settings", settingsRevision: 1, settings: receipt.defaults, capabilityReceipt: receipt }, activeNow);
  if (!initial.ok) throw new Error("Expected initial snapshot.");
  const fresh = resolveEffectiveSessionSnapshot({ sessionId: "command-settings-next", settingsRevision: 1, settings: receipt.defaults, capabilityReceipt: receipt }, activeNow);
  if (!fresh.ok) throw new Error("Expected fresh snapshot.");
  const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
  const started = await registrar.startSession({ sessionId: "command-current", settingsSnapshot: initial.value });
  if (!started.ok) throw new Error("Expected current session.");
  const report = parseCostReport(rawCostReport);
  if (!report.ok) throw new Error("Expected report.");
  return {
    registrar,
    service: new OwnerCommandService({
      registrar,
      costReport: async () => report.value,
      freshSession: { prepare: async () => ({ sessionId: "command-next", settingsSnapshot: fresh.value }) }
    })
  };
}

test("recognizes exact owner commands and leaves surrounding task text untouched", () => {
  assert.deepEqual(parseOwnerCommand("  ВИТРАТИ  "), { kind: "costs" });
  assert.deepEqual(parseOwnerCommand("Стоп"), { kind: "stop" });
  assert.deepEqual(parseOwnerCommand("Нова задача"), { kind: "new_task" });
  assert.deepEqual(parseOwnerCommand("Витрати за серпень"), { kind: "ordinary_message", body: "Витрати за серпень" });
  assert.deepEqual(parseOwnerCommand("Стоп!"), { kind: "ordinary_message", body: "Стоп!" });
});

test("translated controls remain exact standalone consent without accepting quotes, paragraphs or implied permission", () => {
  for (const body of ["I consent to processing", "Погоджуюсь на обробку", "Acepto el tratamiento", "Je consens au traitement", "Ich stimme der Verarbeitung zu", "Zgadzam się na przetwarzanie", "Согласен на обработку"]) {
    assert.equal(parseConsultationControl(body), "consent");
    assert.equal(parseConsultationControl(`> ${body}`), undefined);
    assert.equal(parseConsultationControl(`"${body}"`), undefined);
    assert.equal(parseConsultationControl(`${body}\nAlso reset all permissions.`), undefined);
  }
  for (const body of ["Continue", "Продовжити", "Continuar", "Continuer", "Weiter", "Kontynuuj", "Продолжить"]) assert.equal(parseConsultationControl(body), "continue");
  for (const body of ["Stop", "Стоп", "Parar", "Arrêter", "Stopp"]) assert.equal(parseOwnerCommand(body).kind, "stop");
  for (const body of ["New task", "Нова задача", "Nueva tarea", "Nouvelle tâche", "Neue Aufgabe", "Nowe zadanie", "Новая задача"]) assert.equal(parseOwnerCommand(body).kind, "new_task");
  assert.equal(parseConsultationControl("yes"), undefined);
  assert.equal(parseConsultationControl("okay"), undefined);
  assert.equal(parseConsultationControl("I confirm the document contains no secrets"), "confirm_document");
});

test("every registered application notice has seven explicit translations and unknown locales never silently default", () => {
  assert.ok(SERVICE_MESSAGES.length >= 30);
  for (const message of SERVICE_MESSAGES) {
    for (const language of SERVICE_LANGUAGES) {
      const translated = serviceMessage(message.uk, language);
      assert.equal(translated, message[language]);
      assert.ok(translated.length > 0);
      if (language !== "uk") assert.notEqual(translated, message.uk);
    }
    assert.equal(serviceMessage(message.uk, undefined), LANGUAGE_QUESTION);
    assert.match(serviceMessage(message.uk, "ja"), /^\[Service notices are not yet translated into ja;/u);
  }
  assert.throws(() => serviceMessage("This is not a registered app notice", "en"), /unregistered_service_message/u);
});

test("serves costs read-only, stops the active generation, and creates a fresh context without mixing it with the prior task", async () => {
  const { registrar, service } = await commandHarness();
  const costs = await service.handle("Витрати");
  assert.equal(costs.ok, true);
  assert.equal(costs.kind, "costs");
  if (costs.ok && costs.kind === "costs") assert.match(costs.responseBody, /Витрати/);
  assert.equal((await registrar.getActiveSession())?.phase, "active");

  const stopped = await service.handle("Стоп");
  assert.equal(stopped.ok, true);
  assert.equal(stopped.kind, "stop");
  assert.equal((await registrar.getActiveSession())?.phase, "stopped");

  const newTask = await service.handle("Нова задача");
  assert.equal(newTask.ok, true);
  assert.equal(newTask.kind, "new_task");
  assert.equal((await registrar.getActiveSession())?.sessionId, "command-next");
  assert.equal((await registrar.getActiveSession())?.generation, 2);
});

test("does not close the existing context when fresh settings/subscription preflight is unavailable", async () => {
  const { registrar } = await commandHarness();
  const report = parseCostReport(rawCostReport);
  if (!report.ok) throw new Error("Expected report.");
  const service = new OwnerCommandService({
    registrar,
    costReport: async () => report.value,
    freshSession: { prepare: async () => undefined }
  });
  const result = await service.handle("Нова задача");
  assert.deepEqual(result, {
    ok: false,
    kind: "new_task",
    code: "new_task_preflight_failed",
    responseBody: "## Нова задача\n\nНовий контекст не створено: перевірка доступних налаштувань або підписок не пройшла. Поточні дані не змінилися."
  });
  assert.equal((await registrar.getActiveSession())?.sessionId, "command-current");
  assert.equal((await registrar.getActiveSession())?.phase, "active");
});
