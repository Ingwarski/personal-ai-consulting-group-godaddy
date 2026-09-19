import assert from "node:assert/strict";
import test from "node:test";
import { formatBriefIntakeQuestion, parseBriefIntakeControl, requestsBriefIntake, validBriefIntakeState } from "../src/consilium/brief-intake.ts";

test("brief intake activation reads owner prose but ignores quoted or coded requests", () => {
  assert.equal(requestsBriefIntake("Grill me: help me choose a market."), true);
  assert.equal(requestsBriefIntake("Спочатку розпитай мене: хочу змінити бізнес-модель."), true);
  assert.equal(requestsBriefIntake('A coach said “grill me”. What did that mean?'), false);
  assert.equal(requestsBriefIntake("```\ngrill me\n```\nHelp with pricing."), false);
});

test("brief intake controls are exact and question presentation follows session language", () => {
  assert.equal(parseBriefIntakeControl("Use your recommendation"), "use_recommendation");
  assert.equal(parseBriefIntakeControl("Пропусти питання — використай свої рекомендації"), "skip_questions");
  assert.equal(parseBriefIntakeControl("Please use your recommendation"), undefined);
  const body = formatBriefIntakeQuestion("Який строк є реалістичним?", "До кінця тижня.", "uk");
  assert.match(body, /^Який строк є реалістичним\?\n\nРекомендована відповідь: До кінця тижня\./u);
  assert.match(body, /Пропусти питання/u);
});

test("durable brief intake state accepts at most five complete bounded rounds", () => {
  const round = { question: "What result is sufficient?", recommendedAnswer: "One verified next step.", answer: "Use that.", usedRecommendation: true as const };
  assert.equal(validBriefIntakeState({ requested: true, skipRemaining: false, rounds: Array.from({ length: 5 }, () => round) }), true);
  assert.equal(validBriefIntakeState({ requested: true, skipRemaining: false, rounds: Array.from({ length: 6 }, () => round) }), false);
  assert.equal(validBriefIntakeState({ requested: true, skipRemaining: false, rounds: [
    { question: "First?", recommendedAnswer: "First answer." },
    { question: "Second?", recommendedAnswer: "Second answer." }
  ] }), false, "only the final durable round may still await an answer");
});
