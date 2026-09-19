import { ownerLanguageSource } from "./language.ts";

export const MAX_BRIEF_INTAKE_QUESTIONS = 5;

export type BriefIntakeRound = Readonly<{
  question: string;
  recommendedAnswer: string;
  answer?: string;
  usedRecommendation?: true;
}>;

export type BriefIntakeState = Readonly<{
  requested: boolean;
  skipRemaining: boolean;
  rounds: readonly BriefIntakeRound[];
}>;

export type BriefIntakePolicy = Readonly<{
  requested: boolean;
  questionsAsked: number;
  skipRemaining: boolean;
}>;

export function requestsBriefIntake(message: string): boolean {
  const source = ownerLanguageSource(message);
  return /(?:^|[.!?\n])\s*(?:grill\s+me|interview\s+me\s+first|ask\s+me\s+(?:a\s+few\s+)?questions\s+first|спочатку\s+(?:розпитай|опитай)\s+мене|постав\s+мені\s+(?:кілька\s+)?питань\s+спочатку|сначала\s+(?:расспроси|опроси)\s+меня|задай\s+мне\s+(?:несколько\s+)?вопросов\s+сначала)(?:\s*:|\s*$)/iu.test(source);
}

export type BriefIntakeControl = "use_recommendation" | "skip_questions";

export function parseBriefIntakeControl(message: string): BriefIntakeControl | undefined {
  const normalized = message.trim().toLocaleLowerCase("en").replace(/[—–-]+/gu, " ").replace(/\s+/gu, " ");
  if ([
    "use your recommendation", "використай свою рекомендацію", "используй свою рекомендацию",
    "usa tu recomendación", "utilisez votre recommandation", "verwenden sie ihre empfehlung", "użyj swojej rekomendacji"
  ].includes(normalized)) return "use_recommendation";
  if ([
    "skip questions use your recommendations", "пропусти питання використай свої рекомендації",
    "пропусти вопросы используй свои рекомендации", "omite las preguntas usa tus recomendaciones",
    "ignorez les questions utilisez vos recommandations", "fragen überspringen verwenden sie ihre empfehlungen",
    "pomiń pytania użyj swoich rekomendacji"
  ].includes(normalized)) return "skip_questions";
  return undefined;
}

const COPY = Object.freeze({
  en: Object.freeze({ recommendation: "Recommended answer", instruction: "Reply with your answer, “Use your recommendation”, or “Skip questions — use your recommendations”." }),
  uk: Object.freeze({ recommendation: "Рекомендована відповідь", instruction: "Дайте свою відповідь, напишіть «Використай свою рекомендацію» або «Пропусти питання — використай свої рекомендації»." }),
  es: Object.freeze({ recommendation: "Respuesta recomendada", instruction: "Responde, escribe «Usa tu recomendación» u «Omite las preguntas — usa tus recomendaciones»." }),
  fr: Object.freeze({ recommendation: "Réponse recommandée", instruction: "Répondez, écrivez «Utilisez votre recommandation» ou «Ignorez les questions — utilisez vos recommandations»." }),
  de: Object.freeze({ recommendation: "Empfohlene Antwort", instruction: "Antworten Sie, schreiben Sie „Verwenden Sie Ihre Empfehlung“ oder „Fragen überspringen — verwenden Sie Ihre Empfehlungen“." }),
  pl: Object.freeze({ recommendation: "Rekomendowana odpowiedź", instruction: "Odpowiedz, napisz „Użyj swojej rekomendacji” albo „Pomiń pytania — użyj swoich rekomendacji”." }),
  ru: Object.freeze({ recommendation: "Рекомендуемый ответ", instruction: "Ответьте, напишите «Используй свою рекомендацию» или «Пропусти вопросы — используй свои рекомендации»." })
});

export function formatBriefIntakeQuestion(question: string, recommendedAnswer: string, language?: string): string {
  const primary = language?.split("-")[0] as keyof typeof COPY | undefined;
  const copy = primary === undefined ? COPY.en : COPY[primary] ?? COPY.en;
  return `${question.trim()}\n\n${copy.recommendation}: ${recommendedAnswer.trim()}\n\n${copy.instruction}`;
}

export function validBriefIntakeState(value: unknown): value is BriefIntakeState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const rounds = state.rounds;
  if (Object.keys(state).sort().join(",") !== "requested,rounds,skipRemaining" || typeof state.requested !== "boolean" ||
    typeof state.skipRemaining !== "boolean" || !Array.isArray(rounds) || rounds.length > MAX_BRIEF_INTAKE_QUESTIONS) return false;
  return rounds.every((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const round = value as Record<string, unknown>;
    const keys = Object.keys(round).sort().join(",");
    return ["question,recommendedAnswer", "answer,question,recommendedAnswer", "answer,question,recommendedAnswer,usedRecommendation"].includes(keys) &&
      typeof round.question === "string" && round.question.trim().length > 0 && Buffer.byteLength(round.question, "utf8") <= 1_000 &&
      typeof round.recommendedAnswer === "string" && round.recommendedAnswer.trim().length > 0 && Buffer.byteLength(round.recommendedAnswer, "utf8") <= 1_000 &&
      (round.answer === undefined ? index === rounds.length - 1 :
        (typeof round.answer === "string" && round.answer.trim().length > 0 && Buffer.byteLength(round.answer, "utf8") <= 24_000)) &&
      (round.usedRecommendation === undefined || round.usedRecommendation === true);
  });
}
