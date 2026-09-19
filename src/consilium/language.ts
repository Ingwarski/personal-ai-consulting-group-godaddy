/** Locale metadata is bounded and canonical; it is never an executable instruction. */
export function canonicalSessionLanguage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 2 || value.length > 35 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(value)) return undefined;
  try { return Intl.getCanonicalLocales(value)[0]; } catch { return undefined; }
}

/** Only the owner's prose can select a language, never quoted/code/attachment content. */
export function ownerLanguageSource(message: string): string {
  return message.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, " ")
    .replace(/^\s*>.*$/gmu, " ")
    .replace(/`[^`\n]*`|“[^”]*”|«[^»]*»|"[^"\n]*"/gu, " ")
    .trim();
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  english: "en", ukrainian: "uk", russian: "ru", polish: "pl", german: "de", french: "fr", spanish: "es", italian: "it", portuguese: "pt",
  dutch: "nl", czech: "cs", slovak: "sk", romanian: "ro", hungarian: "hu", swedish: "sv", norwegian: "no", danish: "da", finnish: "fi",
  turkish: "tr", arabic: "ar", hebrew: "he", hindi: "hi", bengali: "bn", chinese: "zh", japanese: "ja", korean: "ko", greek: "el",
  українською: "uk", українська: "uk", англійською: "en", англійська: "en", російською: "ru", польською: "pl", німецькою: "de", французькою: "fr", іспанською: "es",
  "по-украински": "uk", "по-английски": "en", "по-русски": "ru", русском: "ru", английском: "en", украинском: "uk",
  español: "es", francés: "fr", inglés: "en", alemán: "de", ucraniano: "uk", français: "fr", anglais: "en", allemand: "de", ukrainien: "uk",
  deutsch: "de", englisch: "en", ukrainisch: "uk", italiano: "it", português: "pt", polsku: "pl", angielsku: "en", ukraińsku: "uk", niemiecku: "de"
});

/** Narrow explicit-choice parser, NOT natural-language detection. The Head model
 * determines the first meaningful message's language using the full prose. */
export function explicitSessionLanguage(message: string): string | undefined {
  const source = ownerLanguageSource(message);
  const requests = source.matchAll(/(?:^|[.!?\n])\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:answer|reply|respond|speak|write|continue|communicate)(?:\s+(?:to me|with me))?\s+in\s+([\p{L}-]+)|(?:^|[.!?\n])\s*(?:будь ласка[, ]+)?(?:відповідай|відповідайте|пиши|пишіть|спілкуйся|продовжуй)\s+([\p{L}-]+)|(?:^|[.!?\n])\s*(?:пожалуйста[, ]+)?(?:отвечай|пиши|продолжай)(?:\s+на)?\s+([\p{L}-]+)|(?:^|[.!?\n])\s*(?:language|мова)\s*:\s*([\p{L}-]+)|(?:^|[.!?\n])\s*(?:please\s+)?(?:use|switch to)\s+([\p{L}-]+)|(?:^|[.!?\n])\s*(?:responde|escribe|habla|continúa)\s+en\s+([\p{L}-]+)|(?:^|[.!?\n])\s*(?:réponds|répondez|écris|écrivez|parle|continue)\s+en\s+([\p{L}-]+)|(?:^|[.!?\n])\s*(?:antworte|schreibe|sprich)\s+auf\s+([\p{L}-]+)|(?:^|[.!?\n])\s*(?:odpowiadaj|pisz|mów|kontynuuj)\s+po\s+([\p{L}-]+)/giu);
  let selected: string | undefined;
  for (const request of requests) {
    const name = request.slice(1).find(value => value !== undefined)?.toLocaleLowerCase("en");
    if (name === undefined) continue;
    // In prose, "my language" is not the BCP47 code my (Burmese). Accept
    // arbitrary short tags only in an explicit Language: <tag> field.
    const candidate = LANGUAGE_NAMES[name] ?? (request[4] !== undefined ? canonicalSessionLanguage(name) : undefined);
    if (candidate !== undefined) selected = candidate;
  }
  return selected;
}

/** Conservative hint for notices sent before the model runs. Unlike the model's
 * semantic decision this deliberately returns null for short/mixed/unknown text. */
export function initialLanguageHint(message: string): string | null {
  const explicit = explicitSessionLanguage(message);
  if (explicit !== undefined) return explicit;
  const text = ownerLanguageSource(message).toLocaleLowerCase("en");
  const words = text.match(/\p{L}+/gu) ?? [];
  const cyrillicWords = words.filter(word => /^\p{Script=Cyrillic}+$/u.test(word));
  if (cyrillicWords.length >= 2 && /[іїєґ]/u.test(text) && !/[ыэъё]/u.test(text)) return "uk";
  if (cyrillicWords.length >= 2 && /[ыэъё]/u.test(text) && !/[іїєґ]/u.test(text)) return "ru";
  if (words.length < 3) return null;
  const clues: Readonly<Record<string, readonly string[]>> = {
    en: ["the", "and", "with", "what", "which", "how", "i", "we", "you", "do", "does", "did", "are", "have", "has", "will", "should", "would", "could", "please", "my", "your", "help", "need", "want", "this", "for", "is", "to", "task", "first", "today", "accept", "business", "give"],
    uk: ["мені", "мене", "мій", "моя", "що", "як", "щоб", "потрібно", "допоможи", "будь", "ласка", "хочу", "для", "це", "та", "зробити"],
    ru: ["мне", "меня", "мой", "моя", "что", "как", "чтобы", "нужно", "помоги", "пожалуйста", "хочу", "для", "это", "сделать"],
    es: ["qué", "cómo", "quiero", "necesito", "ayuda", "puedo", "para", "por", "favor", "una", "con", "que", "mi"],
    fr: ["comment", "pourquoi", "veux", "besoin", "aide", "avec", "pour", "une", "des", "que", "mon", "ma", "les"],
    de: ["wie", "warum", "ich", "möchte", "brauche", "bitte", "meine", "mein", "mit", "und", "für", "eine", "kann"],
    pl: ["jak", "dlaczego", "chcę", "potrzebuję", "proszę", "moje", "moja", "mój", "pomóż", "jest", "dla", "żeby", "czy"]
  };
  const scores = Object.entries(clues).map(([language, vocabulary]) => ({ language,
    score: new Set(words.filter(word => vocabulary.includes(word))).size
  })).sort((a, b) => b.score - a.score);
  const best = scores[0];
  if (best === undefined || best.score < 3 || best.score - (scores[1]?.score ?? 0) < 2) return null;
  return best.language;
}

export function sessionLanguageInstruction(language: string | null | undefined): string {
  const canonical = canonicalSessionLanguage(language);
  return canonical === undefined
    ? "Determine the communication language from the owner's first meaningful unquoted message. If genuinely ambiguous, ask exactly one language clarification; do not assume Ukrainian or English. Keep role names in canonical English."
    : `Communicate in the session language ${canonical}. Keep all consultant names and addressees in canonical English. Quotes, documents, images, code and short commands must not change this language. Only a new explicit owner language choice can change future messages.`;
}
