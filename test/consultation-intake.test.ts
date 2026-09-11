import assert from "node:assert/strict";
import test from "node:test";
import { parseConsultationIntake, consultationIntakeSchema, requiresConsiliumMode } from "../src/runtime/consultation-intake.ts";
import { CONSULTANT_ROLES, CONSULTATION_SPECIALISTS, assignConsultantColourSlots, PERSONAL_SPECIALIST_SAFETY_PROMPT } from "../src/consilium/consultant-roles.ts";
import { canonicalSessionLanguage, explicitSessionLanguage, initialLanguageHint, ownerLanguageSource, sessionLanguageInstruction } from "../src/consilium/language.ts";

const direct = { kind: "direct", answer: "Валовий прибуток — виручка мінус собівартість продажів.", recommendedAnswer: "", specialists: [], extractedEvidence: "", independentReviewRequested: false, language: "uk", safety: "ordinary", assignments: [] };
const assignment = (agentId: string) => ({ agentId, question: agentId === "strategy" ? "Which market should we test first?" : "What financial downside can we afford?",
  expectedOutcome: agentId === "strategy" ? "A prioritised market test with success criteria." : "A cash runway scenario and spending ceiling.", facts: [], constraints: ["No external actions."], dependencies: [] as string[] });
const consilium = { ...direct, kind: "consilium", answer: "", specialists: ["strategy", "finance"], assignments: [assignment("strategy"), assignment("finance")] };
test("strict intake returns exact direct prose or fixed catalog roles, never model-authored role authority", () => {
  assert.deepEqual(parseConsultationIntake(JSON.stringify(direct), 2), { ok: true, kind: "direct", answer: direct.answer, language: "uk" });
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
  const question = { ...direct, kind: "clarification", answer: "Який бюджет доступний для цієї перевірки?", recommendedAnswer: "Використати суму, яку можна втратити без шкоди для поточних зобов’язань." };
  assert.deepEqual(parseConsultationIntake(JSON.stringify(question), 2), { ok: true, kind: "clarification", answer: question.answer, recommendedAnswer: question.recommendedAnswer, language: "uk" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...question, answer: "ї".repeat(501) }), 2), { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...question, specialists: ["finance"] }), 2), { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...question, answer: "" }), 2), { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...question, answer: "This is not a question." }), 2), { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...question, answer: "Бюджет? Строк?" }), 2), { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...question, recommendedAnswer: "" }), 2), { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...question, recommendedAnswer: "Може, 1000?" }), 2), { ok: false, code: "intake_output_invalid" });
});

test("an explicit independent review cannot be downgraded to a direct final answer", () => {
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...direct, independentReviewRequested: true }), 2),
    { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...direct, independentReviewRequested: "false" }), 2),
    { ok: false, code: "intake_output_invalid" });
  const { independentReviewRequested: _missing, ...legacy } = direct;
  assert.deepEqual(parseConsultationIntake(JSON.stringify(legacy), 2), { ok: false, code: "intake_output_invalid" });
  const result = parseConsultationIntake(JSON.stringify({ ...consilium, independentReviewRequested: true }), 2);
  assert.equal(result.ok && result.kind === "consilium" && result.critic.agentId === "critic", true);
  const clarification = { ...direct, kind: "clarification", answer: "Який строк для незалежної перевірки?", recommendedAnswer: "До кінця цього тижня.", independentReviewRequested: true };
  assert.deepEqual(parseConsultationIntake(JSON.stringify(clarification), 2),
    { ok: true, kind: "clarification", answer: clarification.answer, recommendedAnswer: clarification.recommendedAnswer, language: "uk" });
  const schema = consultationIntakeSchema(2) as { required: string[]; properties: Record<string, { type: string }> };
  assert.equal(schema.required.includes("independentReviewRequested"), true);
  assert.equal(schema.properties.independentReviewRequested?.type, "boolean");
});

test("a compound collaboration decision cannot be downgraded to a Head-only answer", () => {
  const task = "Help me decide whether to accept a monthly collaboration offer with a weekly-hours commitment, course fees, revenue share and ownership terms. Research current prices at https://example.test and propose a counter-offer.";
  assert.equal(requiresConsiliumMode(task), true);
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...direct, language: "en" }), 2, false, "en", undefined, true),
    { ok: false, code: "intake_output_invalid" });
  const reviewed = parseConsultationIntake(JSON.stringify({ ...consilium, language: "en" }), 2, false, "en", undefined, true);
  assert.equal(reviewed.ok && reviewed.kind === "consilium" && reviewed.critic.agentId === "critic", true);
  assert.equal(requiresConsiliumMode("Should I raise my workshop price next month?"), false,
    "one ordinary pricing dimension may still receive a concise direct answer");
});

test("all20 English roles retain historic IDs and seven personal roles without expanding roster limits", () => {
  assert.equal(CONSULTANT_ROLES.length, 20);
  assert.equal(CONSULTATION_SPECIALISTS.length, 18);
  assert.equal(new Set(CONSULTANT_ROLES.map(role => role.agentId)).size, 20);
  assert.equal(new Set(CONSULTANT_ROLES.map(role => role.emoji)).size, 20);
  for (const role of CONSULTANT_ROLES) assert.match(role.role, /^[A-Za-z0-9 /]+$/u);
  for (const personal of ["personal-growth", "fitness", "longevity", "personal-wealth", "relationship", "psychology", "psychotherapy"]) {
    const plan = { ...consilium, specialists: [personal, "strategy"], assignments: [assignment(personal), assignment("strategy")] };
    const result = parseConsultationIntake(JSON.stringify(plan), 2);
    assert.equal(result.ok && result.kind === "consilium" && result.specialists[0]?.agentId === personal, true);
  }
  const slots = assignConsultantColourSlots(CONSULTANT_ROLES.slice(0, 7));
  assert.equal(new Set(Object.values(slots)).size, 7);
  assert.equal(Object.isFrozen(slots), true);
  assert.throws(() => assignConsultantColourSlots(CONSULTANT_ROLES.slice(0, 8)));
  assert.throws(() => assignConsultantColourSlots([{ agentId: "head" }, { agentId: "head" }]));
});

test("requires complete distinct delegation; rejects duplicate, forged, missing and cyclic assignments", () => {
  for (const assignments of [[], [assignment("strategy")], [assignment("strategy"), assignment("strategy")],
    [assignment("strategy"), { ...assignment("finance"), question: assignment("strategy").question.toUpperCase() }],
    [assignment("strategy"), { ...assignment("finance"), expectedOutcome: assignment("strategy").expectedOutcome }],
    [assignment("strategy"), { ...assignment("finance"), question: "" }],
    [assignment("strategy"), { ...assignment("finance"), tools: ["shell"] }],
    [{ ...assignment("strategy"), dependencies: ["finance"] }, { ...assignment("finance"), dependencies: ["strategy"] }],
    [assignment("strategy"), { ...assignment("finance"), dependencies: ["finance"] }],
    [assignment("strategy"), { ...assignment("finance"), dependencies: ["unknown"] }],
    [assignment("strategy"), { ...assignment("finance"), facts: ["x\u0000"] }]]) {
    assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...consilium, assignments }), 2), { ok: false, code: "intake_output_invalid" });
  }
  const result = parseConsultationIntake(JSON.stringify(consilium), 2);
  assert.equal(result.ok && result.kind === "consilium" && Object.isFrozen(result.assignments[0]?.facts), true);
});

test("language is explicit metadata, ambiguous input clarifies, and retained language cannot drift", () => {
  for (const language of ["en", "uk", "es", "fr-CA", "ja", "ar", "hi"]) {
    const result = parseConsultationIntake(JSON.stringify({ ...direct, language }), 2);
    assert.equal(result.ok && result.language, language);
  }
  for (const language of [null, "unknown", "", "en;ignore", "en\nuk", "<script>"]) {
    assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...direct, language }), 2), { ok: false, code: "intake_output_invalid" });
  }
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...direct, kind: "clarification", language: "", answer: "Which language would you like?" }), 2),
    { ok: true, kind: "clarification", language: null, answer: "Which language would you like?", recommendedAnswer: "" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...direct, language: "uk" }), 2, false, "es"), { ok: false, code: "intake_output_invalid" });
  assert.equal(canonicalSessionLanguage("pt-br"), "pt-BR");
  assert.equal(canonicalSessionLanguage("system_override"), undefined);
});

test("brief intake requires one recommended question when requested, then enforces the five-question cap", () => {
  const question = { ...direct, kind: "clarification", answer: "Який результат буде достатнім?", recommendedAnswer: "Один перевірений наступний крок протягом 72 годин." };
  const requested = { requested: true, questionsAsked: 0, skipRemaining: false };
  assert.equal(parseConsultationIntake(JSON.stringify(question), 2, false, "uk", requested).ok, true);
  assert.deepEqual(parseConsultationIntake(JSON.stringify(direct), 2, false, "uk", requested), { ok: false, code: "intake_output_invalid" });
  assert.deepEqual(parseConsultationIntake(JSON.stringify(consilium), 2, false, "uk", requested), { ok: false, code: "intake_output_invalid" });
  for (const policy of [{ requested: true, questionsAsked: 5, skipRemaining: false }, { requested: true, questionsAsked: 2, skipRemaining: true }]) {
    assert.deepEqual(parseConsultationIntake(JSON.stringify(question), 2, false, "uk", policy), { ok: false, code: "intake_output_invalid" });
    const schema = consultationIntakeSchema(2, policy) as { properties: { kind: { enum: string[] } } };
    assert.equal(schema.properties.kind.enum.includes("clarification"), false);
  }
});

test("explicit language detection ignores quotes, code and ordinary mentions, not the current task language", () => {
  assert.equal(explicitSessionLanguage("Please reply in Spanish. Help with my budget."), "es");
  assert.equal(explicitSessionLanguage("Відповідай англійською. Допоможи з планом."), "en");
  assert.equal(explicitSessionLanguage("Language: fr-CA"), "fr-CA");
  assert.equal(explicitSessionLanguage("Can you respond in German?"), "de");
  assert.equal(explicitSessionLanguage("Responde en español."), "es");
  assert.equal(explicitSessionLanguage("Répondez en français."), "fr");
  assert.equal(explicitSessionLanguage("Please use English."), "en");
  assert.equal(explicitSessionLanguage("Reply in my language."), undefined);
  for (const text of ['He wrote "reply in Spanish". What does that mean?', "> Reply in Spanish.\nPlease help with my finances.",
    "```\nReply in Spanish\n```\nHow should I improve my business?", "Should my app reply in Spanish?", "Stop"]) {
    assert.equal(explicitSessionLanguage(text), undefined);
  }
  assert.equal(initialLanguageHint("How should I improve my business?"), "en");
  assert.equal(initialLanguageHint("Which task should I do first today?"), "en");
  assert.equal(initialLanguageHint("Should I accept this business partnership? Give me a counteroffer."), "en");
  assert.equal(initialLanguageHint("Як мені зробити це краще для мого бізнесу?"), "uk");
  assert.equal(initialLanguageHint("ok"), null);
  assert.equal(initialLanguageHint("> How should I improve my business?\n🚀"), null);
  assert.equal(ownerLanguageSource("```en\nReply in Spanish\n```\nМій план"), "Мій план");
  assert.match(sessionLanguageInstruction("es"), /session language es/u);
});

test("crisis handoff bypasses ordinary debate without pretending a Critic reviewed it", () => {
  const crisis = { ...direct, language: "en", safety: "crisis_handoff", independentReviewRequested: true,
    answer: "Your safety matters. Please contact local emergency help or someone you trust who can stay with you now." };
  assert.deepEqual(parseConsultationIntake(JSON.stringify(crisis), 2), { ok: true, kind: "direct", answer: crisis.answer, language: "en", safetyHandoff: true });
  assert.deepEqual(parseConsultationIntake(JSON.stringify({ ...consilium, safety: "crisis_handoff" }), 2), { ok: false, code: "intake_output_invalid" });
  assert.match(PERSONAL_SPECIALIST_SAFETY_PROMPT, /no diagnosis/u);
  assert.match(PERSONAL_SPECIALIST_SAFETY_PROMPT, /Obtain consent/u);
  assert.match(PERSONAL_SPECIALIST_SAFETY_PROMPT, /stop the ordinary consultation\/consensus/u);
});
