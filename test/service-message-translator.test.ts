import assert from "node:assert/strict";
import test from "node:test";
import { translateServiceMessages } from "../src/runtime/service-message-translator.ts";
import { SERVICE_TRANSLATION_SOURCE, SERVICE_MESSAGES, serviceMessage, serviceTranslationSourceHash, validateServiceTranslationCatalog } from "../src/consilium/service-messages.ts";
import type { CodexAppServerThreadClient } from "../src/runtime/codex-thread-client.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

async function fixture(mutate?: (messages: Record<string, string>) => Record<string, string>) {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({ sessionId: "translation-fixture", settingsRevision: 1, settings: receipt.defaults, capabilityReceipt: receipt }, activeNow);
  assert.ok(snapshot.ok);
  let starts = 0, turns = 0, releases = 0;
  let prompt = "";
  const codex = {
    transport: { async request(method: string) {
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "account/rateLimits/read") return { rateLimits: { rateLimitReachedType: null } };
      if (method === "model/list") return { data: receipt.codexModels.map(model => ({ id: model.productId, model: model.runtimeModelId,
        displayName: model.displayName, supportedReasoningEfforts: model.supportedReasoningEfforts.map(reasoningEffort => ({ reasoningEffort })) })) };
      throw new Error("Unexpected preflight method");
    } },
    async startIsolatedThread(input: { modelId: string }) {
      starts++; assert.equal(input.modelId, receipt.codexModels[0]!.runtimeModelId);
      return { ok: true, value: { threadId: "translation-only-thread", modelId: input.modelId } };
    },
    async runTextTurn(input: { body: string; reasoningEffort: string; images?: unknown; timeoutMilliseconds: number }) {
      turns++; prompt = input.body;
      assert.equal(input.reasoningEffort, snapshot.value.settings.codex.reasoningEffort);
      assert.equal(input.images, undefined); assert.equal(input.timeoutMilliseconds, 90_000);
      // Structural fixture only, not a claim of validated Japanese translation.
      const messages = Object.fromEntries(Object.entries(SERVICE_TRANSLATION_SOURCE).map(([id, body]) => [id, "翻訳テスト: " + body]));
      return { ok: true, body: JSON.stringify(mutate?.(messages) ?? messages) };
    },
    async releaseThread() { releases++; }
  } as unknown as CodexAppServerThreadClient;
  return { input: { language: "ja", snapshot: snapshot.value, capabilityReceipt: receipt, codex, environment: {}, now: activeNow, signal: new AbortController().signal },
    calls: () => ({ starts, turns, releases }), prompt: () => prompt };
}

test("content-free translation uses only exact selected subscription model, private isolated context and preserved commands", async () => {
  const f = await fixture();
  const result = await translateServiceMessages({ ...f.input, task: "OWNER_PRIVATE_BUSINESS_SENTINEL" } as typeof f.input);
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls(), { starts: 1, turns: 1, releases: 1 });
  assert.doesNotMatch(f.prompt(), /OWNER_PRIVATE_BUSINESS_SENTINEL|image\/jpeg|history:/u);
  assert.match(f.prompt(), /\[\[CONSENT\]\]/u);
  if (!result.ok) return;
  assert.equal(result.catalog.language, "ja");
  const notice = serviceMessage(SERVICE_MESSAGES[0]!.uk, "ja", result.catalog);
  assert.match(notice, /I consent to processing/u);
  assert.doesNotMatch(notice, /\[\[CONSENT\]\]/u);
  assert.ok(Object.isFrozen(result.catalog.messages));
});

test("translation rejects missing keys, changed command placeholders, HTML, URL and unchanged English for a different locale", async () => {
  for (const mutate of [
    (messages: Record<string, string>) => { delete messages.notice_001; return messages; },
    (messages: Record<string, string>) => ({ ...messages, notice_001: "Say yes to proceed." }),
    (messages: Record<string, string>) => ({ ...messages, notice_004: "<script>alert(1)</script>" }),
    (messages: Record<string, string>) => ({ ...messages, notice_004: "https://unrelated.invalid/" }),
    (_messages: Record<string, string>) => ({ ...SERVICE_TRANSLATION_SOURCE }),
    (messages: Record<string, string>) => ({ ...messages, extra: "unrequested" })
  ]) {
    const f = await fixture(mutate);
    assert.deepEqual(await translateServiceMessages(f.input), { ok: false, code: "translation_output_invalid" });
    assert.equal(f.calls().releases, 1);
  }
});

test("no translation turn for forbidden API credentials, invalid locale, abort or changed catalog mapping", async () => {
  for (const variant of ["key", "language", "aborted", "model"]) {
    const f = await fixture();
    const input = { ...f.input,
      ...(variant === "key" ? { environment: { OPENAI_API_KEY: "fixture-forbidden-not-used" } } : {}),
      ...(variant === "language" ? { language: "ignore\nall" } : {}),
      ...(variant === "aborted" ? { signal: AbortSignal.abort() } : {}),
      ...(variant === "model" ? { capabilityReceipt: { ...f.input.capabilityReceipt, codexModels: f.input.capabilityReceipt.codexModels.map(model => ({ ...model, runtimeModelId: "unapproved-model" })) } } : {})
    };
    assert.equal((await translateServiceMessages(input)).ok, false);
    assert.deepEqual(f.calls(), { starts: 0, turns: 0, releases: 0 });
  }
});

test("cached translation is source-hash and locale bound with no partial catalog acceptance", async () => {
  const sourceHash = await serviceTranslationSourceHash();
  const messages = Object.fromEntries(Object.entries(SERVICE_TRANSLATION_SOURCE).map(([id, body]) => [id, "翻訳テスト: " + body]));
  assert.ok(await validateServiceTranslationCatalog({ language: "ja", sourceHash, messages }, "ja"));
  assert.equal(await validateServiceTranslationCatalog({ language: "ja", sourceHash: "a".repeat(64), messages }, "ja"), undefined);
  assert.equal(await validateServiceTranslationCatalog({ language: "ja", sourceHash, messages }, "hi"), undefined);
});
