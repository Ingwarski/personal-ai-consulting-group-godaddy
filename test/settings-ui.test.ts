import assert from "node:assert/strict";
import test from "node:test";

import { deriveSettingsFormState } from "../src/settings/ui/controller.ts";
import { handleSettingsPage } from "../src/settings/ui/route.ts";
import { renderAccessDeniedDocument, renderSettingsDocument } from "../src/settings/ui/template.ts";
import { OwnerSettingsDO } from "../src/settings/owner-settings-do.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemorySettingsStorage } from "./fixtures/memory-settings-storage.ts";

async function pageModel(receipt = createCapabilityReceipt()) {
  const ownerSettings = new OwnerSettingsDO({
    storage: new MemorySettingsStorage(),
    getCapabilityReceipt: () => receipt,
    now: () => activeNow
  });
  await ownerSettings.initialize();
  const read = await ownerSettings.read();
  if (read === undefined) throw new Error("Settings must initialize for the test.");
  return { read, capabilityReceipt: receipt, csrfToken: "test-csrf-token", now: activeNow };
}

test("orders the verified Claude family by exact model capability, not alias discovery order", async () => {
  const baseline = createCapabilityReceipt().claudeModels[0]!;
  const claudeModel = (productId: string, displayName: string, runtimeModelId: string) => ({
    ...baseline,
    productId,
    displayName,
    runtimeModelId
  });
  const receipt = createCapabilityReceipt({
    claudeModels: [
      claudeModel("claude-sonnet-5", "Claude Sonnet 5", "claude-sonnet-5"),
      claudeModel("claude-haiku-4-5-20251001", "Claude Haiku 4.5", "claude-haiku-4-5-20251001"),
      claudeModel("claude-opus-4-8", "Claude Opus 4.8", "claude-opus-4-8"),
      claudeModel("claude-opus-5", "Claude Opus 5", "claude-opus-5")
    ],
    defaults: {
      ...createCapabilityReceipt().defaults,
      claude: { modelId: "claude-sonnet-5", reasoningEffort: "high" }
    }
  });
  const html = renderSettingsDocument(await pageModel(receipt));
  const optionPosition = (modelId: string): number => html.indexOf(`<option value="${modelId}"`);

  assert.ok(optionPosition("claude-opus-5") < optionPosition("claude-opus-4-8"));
  assert.ok(optionPosition("claude-opus-4-8") < optionPosition("claude-sonnet-5"));
  assert.ok(optionPosition("claude-sonnet-5") < optionPosition("claude-haiku-4-5-20251001"));
});

test("settings page has exactly three labelled groups and only catalog-provided model names", async () => {
  const model = await pageModel();
  const html = renderSettingsDocument(model);

  assert.match(html, /<h2 id="codex-title">Codex-агенти<\/h2>/);
  assert.match(html, /<h2 id="claude-title">Claude Code-критик<\/h2>/);
  assert.match(html, /<h2 id="speed-title">Швидкість консиліуму<\/h2>/);
  assert.equal((html.match(/class="group-number"/g) ?? []).length, 3);
  assert.match(html, />Codex primary<\/option>/);
  assert.match(html, />Claude critic<\/option>/);
  assert.doesNotMatch(html, /GPT-5|Opus 5|Sonnet 5|Fast Mode|PAYG|credits|password|api[_-]?key|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY/i);
  assert.match(html, /<script src="\/assets\/settings\.js" defer><\/script>/);
});

test("save is disabled without a whole valid changed set and becomes available for one", async () => {
  const model = await pageModel();
  const unchanged = deriveSettingsFormState(
    model.read.document.settings,
    model.read.document.settings,
    model.capabilityReceipt,
    activeNow
  );
  assert.equal(unchanged.canSave, false);

  const changed = deriveSettingsFormState(
    {
      ...model.read.document.settings,
      codex: { ...model.read.document.settings.codex, reasoningEffort: "medium" }
    },
    model.read.document.settings,
    model.capabilityReceipt,
    activeNow
  );
  assert.equal(changed.canSave, true);

  const incompatible = deriveSettingsFormState(
    {
      ...model.read.document.settings,
      claude: { ...model.read.document.settings.claude, reasoningEffort: "xhigh" }
    },
    model.read.document.settings,
    model.capabilityReceipt,
    activeNow
  );
  assert.equal(incompatible.canSave, false);
  assert.match(incompatible.validationMessage, /не буде змінено автоматично/);
});

test("access denial renders no settings values, selectors, credentials or sign-in form", () => {
  const html = renderAccessDeniedDocument();

  assert.match(html, /Доступ відхилено/);
  assert.doesNotMatch(html, /<select|<input|oauth|token|owner@example|password/i);
});

test("unverified access receives no protected settings value or selector", async () => {
  const receipt = createCapabilityReceipt();
  const ownerSettings = new OwnerSettingsDO({
    storage: new MemorySettingsStorage(),
    getCapabilityReceipt: () => receipt,
    now: () => activeNow
  });
  await ownerSettings.initialize();
  const response = await handleSettingsPage(new Request("https://settings.example.test/settings"), {
    ownerSettings,
    getCapabilityReceipt: () => receipt,
    issueCsrfToken: async () => "test-csrf-token",
    now: () => activeNow,
    hasVerifiedAccess: () => false
  });
  const html = await response.text();

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.doesNotMatch(html, /Codex primary|Claude critic|<select|<input/i);
});

test("verified access receives the settings document with protective browser headers", async () => {
  const model = await pageModel();
  const ownerSettings = new OwnerSettingsDO({
    storage: new MemorySettingsStorage(),
    getCapabilityReceipt: () => model.capabilityReceipt,
    now: () => activeNow
  });
  await ownerSettings.initialize();
  const response = await handleSettingsPage(new Request("https://settings.example.test/settings"), {
    ownerSettings,
    getCapabilityReceipt: () => model.capabilityReceipt,
    issueCsrfToken: async () => "test-csrf-token",
    now: () => activeNow,
    hasVerifiedAccess: () => true
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(await response.text(), /Налаштування власника/);
});
