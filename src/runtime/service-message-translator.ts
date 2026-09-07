import { canonicalSessionLanguage } from "../consilium/language.ts";
import { SERVICE_TRANSLATION_SOURCE, serviceTranslationSourceHash, validateServiceTranslationCatalog, type ServiceTranslationCatalog } from "../consilium/service-messages.ts";
import type { CapabilityReceipt, EffectiveSessionSnapshot } from "../settings/types.ts";
import type { CodexAppServerThreadClient } from "./codex-thread-client.ts";
import { preflightCodexForSnapshot } from "./consultation-intake.ts";

export type ServiceMessageTranslationResult = Readonly<{ ok: true; catalog: ServiceTranslationCatalog }> |
  Readonly<{ ok: false; code: "translation_preflight_failed" | "translation_failed" | "translation_output_invalid" | "invalid_language" }>;

export const serviceMessageTranslationSchema = Object.freeze({
  type: "object", additionalProperties: false, required: Object.keys(SERVICE_TRANSLATION_SOURCE),
  properties: Object.fromEntries(Object.keys(SERVICE_TRANSLATION_SOURCE).map(id => [id, { type: "string", minLength: 1, maxLength: 4000 }]))
});

/** Content-free application-string translation, never consultation intake.
 * The composition root calls this only after persisted owner consent. It uses
 * the already selected subscription model/effort and no additional provider. */
export async function translateServiceMessages(input: Readonly<{
  language: string;
  snapshot: EffectiveSessionSnapshot;
  capabilityReceipt: CapabilityReceipt;
  codex: CodexAppServerThreadClient;
  environment: Record<string, unknown>;
  now: Date;
  signal: AbortSignal;
}>): Promise<ServiceMessageTranslationResult> {
  const language = canonicalSessionLanguage(input.language);
  if (language === undefined || language !== input.language) return { ok: false, code: "invalid_language" };
  let runtimeModelId: string | undefined;
  try { runtimeModelId = await preflightCodexForSnapshot(input); } catch { return { ok: false, code: "translation_preflight_failed" }; }
  if (runtimeModelId === undefined) return { ok: false, code: "translation_preflight_failed" };
  let started: Awaited<ReturnType<CodexAppServerThreadClient["startIsolatedThread"]>>;
  try { started = await input.codex.startIsolatedThread({ modelId: runtimeModelId }); }
  catch { return { ok: false, code: "translation_failed" }; }
  if (!started.ok) return { ok: false, code: "translation_failed" };
  try {
    const body = [
      `Translate the following fixed application service messages faithfully into language ${language}.`,
      "This is an application localization job. No owner task, personal information, attachments, chat history or secrets are supplied.",
      "Return ONLY a JSON object with exactly the supplied message keys. Translate the complete meaning, especially consent limits, privacy restrictions, uncertainty, and stop/continuation boundaries. Do not shorten, add claims, advice, guarantees, permissions or external actions.",
      "Preserve every [[UPPERCASE_TOKEN]] exactly, including its occurrence count in its own message. These placeholders become universal exact English controls; do not translate, rename, duplicate or remove them. Preserve canonical consultant names including Head Consultant and Critic. Do not emit HTML, links, Markdown code fences, URLs or extra keys.",
      "Application English source JSON:", JSON.stringify(SERVICE_TRANSLATION_SOURCE)
    ].join("\n\n");
    const response = await input.codex.runTextTurn({ lease: started.value, body,
      outputSchema: serviceMessageTranslationSchema, reasoningEffort: input.snapshot.settings.codex.reasoningEffort,
      timeoutMilliseconds: 90_000, signal: input.signal });
    if (!response.ok || input.signal.aborted) return { ok: false, code: "translation_failed" };
    if (typeof response.body !== "string" || Buffer.byteLength(response.body, "utf8") > 64_000) return { ok: false, code: "translation_output_invalid" };
    let messages: unknown;
    try { messages = JSON.parse(response.body); } catch { return { ok: false, code: "translation_output_invalid" }; }
    const catalog = await validateServiceTranslationCatalog({ language, sourceHash: await serviceTranslationSourceHash(), messages }, language);
    if (catalog === undefined) return { ok: false, code: "translation_output_invalid" };
    return { ok: true, catalog };
  } catch { return { ok: false, code: "translation_failed" }; }
  finally { await input.codex.releaseThread(started.value); }
}
