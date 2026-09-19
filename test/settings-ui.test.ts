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
      critic: { provider: "claude_code", claude: { modelId: "claude-sonnet-5", reasoningEffort: "high" }, codex: null }
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
  assert.match(html, /<h2 id="critic-title">Критик<\/h2>/);
  assert.match(html, /<label for="critic-provider"><span>Провайдер Критика<\/span>/);
  assert.match(html, /<option value="claude_code" selected>Claude Code<\/option><option value="codex">Codex<\/option>/);
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
      critic: { ...model.read.document.settings.critic, claude: { ...model.read.document.settings.critic.claude!, reasoningEffort: "xhigh" } }
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

test("Google owner controls carry separate purpose tokens without altering the three settings groups", async () => {
  const model = await pageModel();
  const html = renderSettingsDocument({ ...model, ownerActionTokens: {
    "/auth/sign-out": "logout-test-token",
    "/auth/sessions/revoke": "revoke-test-token",
    "/api/settings/csrf": "refresh-test-token"
  } });
  assert.match(html, /name="owner-csrf-refresh-token" content="refresh-test-token"/);
  assert.match(html, /src="\/assets\/owner-auth\.js" defer/);
  assert.match(html, /action="\/auth\/sign-out" method="post" data-owner-action><input type="hidden" name="formToken" value="logout-test-token"/);
  assert.match(html, /action="\/auth\/sessions\/revoke" method="post" data-owner-action><input type="hidden" name="formToken" value="revoke-test-token"/);
  assert.equal((html.match(/class="settings-group"/gu) ?? []).length, 3);
  assert.doesNotMatch(html, /name="password"|Ключ входу/);
  assert.match(html, /не вихід із Google/);
  assert.match(html, /data-owner-action-status role="status" aria-live="polite" tabindex="-1"/);
});

test("verified Astra and Extra High are labelled in each independent Codex role without inventing options", async () => {
  const base = createCapabilityReceipt();
  const receipt = createCapabilityReceipt({
    codexModels: [{ ...base.codexModels[0]!, runtimeModelId: "gpt-6-astra", displayName: "GPT-6-Astra" }],
    defaults: { ...base.defaults, critic: { ...base.defaults.critic, provider: "codex", codex: { modelId: "codex-current-primary", reasoningEffort: "xhigh" } } }
  });
  const html = renderSettingsDocument(await pageModel(receipt));
  assert.match(html, /<select id="codex-model"[^>]*><option value="codex-current-primary" selected>GPT-6 Astra<\/option>/);
  assert.match(html, /<select id="critic-model"[^>]*><option value="codex-current-primary" selected>GPT-6 Astra<\/option>/);
  assert.match(html, /<option value="xhigh" selected>Extra High<\/option>/);
  assert.match(html, /Codex-агенти: GPT-6 Astra \(high\).*Критик · Codex: GPT-6 Astra \(Extra High\)/);
  assert.doesNotMatch(html, /GPT-6-Astra|<option[^>]*>Claude critic/);
  assert.doesNotMatch(renderSettingsDocument(await pageModel()), /GPT-6 Astra/);
});

test("missing Claude does not hide the provider selector or block a manually selected valid Codex Critic", async () => {
  const model = await pageModel();
  const receipt = createCapabilityReceipt({ claudeModels: [] });
  const draft = { ...model.read.document.settings, critic: {
    ...model.read.document.settings.critic, provider: "codex" as const,
    codex: { modelId: "codex-current-primary", reasoningEffort: "xhigh" }
  } };
  const html = renderSettingsDocument({ ...model, capabilityReceipt: receipt, draft,
    read: { ...model.read, defaultsIncompatibility: "unknown_claude_model" }
  });
  assert.match(html, /id="critic-provider"[^>]*><option value="claude_code">Claude Code<\/option><option value="codex" selected>Codex/);
  assert.match(html, /<button type="submit" class="button primary">Зберегти весь набір/);
  assert.match(html, /id="reset-button" class="button secondary" disabled/);
  assert.match(html, /href="\/operations\/runtime">перевірити підключення провайдера/);
  assert.match(html, /id="critic-recovery-link" href="\/operations\/runtime" hidden/);
  assert.equal(deriveSettingsFormState(draft, model.read.document.settings, receipt, activeNow).canSave, true);
});

test("unavailable saved Critic model and effort remain explicit instead of selecting defaults", async () => {
  const model = await pageModel();
  const receipt = createCapabilityReceipt({ claudeModels: [] });
  const html = renderSettingsDocument({ ...model, capabilityReceipt: receipt });
  assert.match(html, /<option value="claude-current-critic" selected disabled>Недоступна модель — недоступно/);
  assert.match(html, /<option value="high" selected disabled>high — недоступно/);
  assert.match(html, /id="critic-feedback" class="critic-feedback error" role="status" aria-live="polite"/);
  assert.match(html, /id="critic-recovery-link" href="\/operations\/runtime">/);
  assert.match(html, /id="settings-status" class="validation-status error"/);
  assert.match(html, /<button type="submit" class="button primary" disabled/);
  assert.doesNotMatch(html, /id="critic-provider"[^>]* disabled/);
});

test("a never-configured Critic branch requires an explicit model choice", async () => {
  const model = await pageModel();
  const html = renderSettingsDocument({ ...model,
    draft: { ...model.read.document.settings, critic: { ...model.read.document.settings.critic, provider: "codex", codex: null } }
  });
  assert.match(html, /id="critic-model"[^>]*><option value="" selected>Виберіть модель/);
  assert.match(html, /<button type="submit" class="button primary" disabled/);
  assert.match(html, /Для цього провайдера параметри ще не збережено/);
});

test("server-rendered stale provider warnings agree with the form validity before JavaScript runs", async () => {
  const model = await pageModel();
  const receipt = createCapabilityReceipt({ providerReceipts: {
    codex: { schemaVersion: "1", status: "ready", catalogVersion: "codex-ready", issuedAt: model.capabilityReceipt.issuedAt, expiresAt: model.capabilityReceipt.expiresAt, trusted: true },
    claude_code: { schemaVersion: "1", status: "unavailable", catalogVersion: "claude-unavailable", issuedAt: model.capabilityReceipt.issuedAt, expiresAt: model.capabilityReceipt.expiresAt, trusted: true }
  } });
  const html = renderSettingsDocument({ ...model, capabilityReceipt: receipt });
  assert.match(html, /id="critic-feedback" class="critic-feedback error"/);
  assert.match(html, /id="critic-recovery-link" href="\/operations\/runtime">/);
  assert.match(html, /id="settings-status" class="validation-status error"/);
});
