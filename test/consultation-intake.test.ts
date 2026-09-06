import assert from "node:assert/strict";
import test from "node:test";
import { parseConsultationIntake, consultationIntakeSchema } from "../src/runtime/consultation-intake.ts";

const direct = { kind: "direct", answer: "Валовий прибуток — виручка мінус собівартість продажів.", specialists: [], extractedEvidence: "" };
const consilium = { kind: "consilium", answer: "", specialists: ["strategy", "finance"], extractedEvidence: "" };
test("strict intake returns exact direct prose or fixed catalog roles, never model-authored role authority", () => {
  assert.deepEqual(parseConsultationIntake(JSON.stringify(direct), 2), { ok: true, kind: "direct", answer: direct.answer });
  const result = parseConsultationIntake(JSON.stringify(consilium), 2);
  assert.equal(result.ok, true);
  if (!result.ok || result.kind !== "consilium") return;
  assert.deepEqual(result.specialists.map(role => role.agentId), ["strategy", "finance"]);
  assert.equal(result.critic.agentId, "critic");
  assert.equal(result.head.agentId, "head");
  assert.equal(Object.isFrozen(result.specialists), true);
  assert.equal((consultationIntakeSchema(2) as { additionalProperties: boolean }).additionalProperties, false);
});

test("untrusted or oversized routing output never changes provider, role catalog, count or effort", () => {
  for (const value of [null, [], { ...direct, provider: "claude_code" }, { ...direct, reasoningEffort: "low" },
    { ...direct, answer: "" }, { ...direct, answer: "x".repeat(8_001) }, { ...direct, answer: "x\u0000" },
    { ...direct, answer: "Reviewed by the Critic." }, { ...direct, answer: "Перевірено критиком." },
    { ...direct, specialists: ["finance"] }, { ...consilium, specialists: ["finance"] },
    { ...consilium, specialists: ["finance", "finance"] }, { ...consilium, specialists: ["finance", "hacker"] },
    { ...consilium, specialists: ["strategy", "finance", "risk"] }, { ...consilium, answer: "already reviewed" },
    { ...consilium, extractedEvidence: "I saw a file that was never supplied." }]) {
    assert.deepEqual(parseConsultationIntake(JSON.stringify(value), 2), { ok: false, code: "intake_output_invalid" });
  }
  assert.deepEqual(parseConsultationIntake("```json\n" + JSON.stringify(direct) + "\n```", 2), { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake("x".repeat(24_001), 2), { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify(consilium), 9), { ok: false, code: "intake_output_invalid" });
});

test("image consilium requires factual extraction and text-only input cannot fabricate image evidence", () => {
  assert.deepEqual(parseConsultationIntake(JSON.stringify(consilium), 2, true), { ok: false, code: "intake_output_invalid" });
  const result = parseConsultationIntake(JSON.stringify({ ...consilium, extractedEvidence: "На діаграмі показано три стовпчики; підписи нерозбірливі." }), 2, true);
  assert.equal(result.ok && result.kind === "consilium" && result.extractedEvidence.includes("нерозбірливі"), true);
});

test("clarification is a distinct bounded question outcome, never a completed direct answer", () => {
  const question = { kind: "clarification", answer: "Який бюджет доступний для цієї перевірки?", specialists: [], extractedEvidence: "" };
  assert.deepEqual(parseConsultationIntake(JSON.stringify(question), 2), { ok: true, kind: "clarification", answer: question.answer });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...question, answer: "ї".repeat(501) }), 2), { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...question, specialists: ["finance"] }), 2), { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...question, answer: "" }), 2), { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...question, answer: "This is not a question." }), 2), { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...question, answer: "Бюджет? Строк?" }), 2), { ok: false, code: "intake_output_invalid" });
});
