import { deriveSettingsFormState } from "./controller.ts";
import type { SettingsReadModel } from "../owner-settings-do.ts";
import type { CapabilityReceipt, OwnerSettings, ProviderModelCapability, ProviderReasoningEffort, SpeedPreset } from "../types.ts";

export type SettingsPageModel = Readonly<{
  read: SettingsReadModel;
  capabilityReceipt: CapabilityReceipt;
  csrfToken: string;
  draft?: OwnerSettings;
  now: Date;
}>;

const SPEEDS: ReadonlyArray<Readonly<{ value: SpeedPreset; title: string; description: string }>> = [
  { value: "швидко", title: "Швидко", description: "Менше додаткових перевірок, один обов’язковий цикл критики." },
  { value: "збалансовано", title: "Збалансовано", description: "Рекомендований баланс темпу, перевірки й повноти." },
  { value: "ретельно", title: "Ретельно", description: "Більше доречних перевірок у межах тих самих правил безпеки." }
];

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const isEffortSupported = (model: ProviderModelCapability, effort: ProviderReasoningEffort): boolean =>
  model.availability === "available" &&
  model.supportedReasoningEfforts.includes(effort) &&
  typeof model.reasoningMappings[effort] === "string";

function findDisplayName(models: readonly ProviderModelCapability[], id: string): string {
  return models.find((model) => model.productId === id)?.displayName ?? "Недоступна модель";
}

function formatSettings(settings: OwnerSettings, receipt: CapabilityReceipt): string {
  return [
    "Codex: " + findDisplayName(receipt.codexModels, settings.codex.modelId) + " (" + (settings.codex.reasoningEffort ?? "за замовчуванням моделі") + ")",
    "Claude Code: " + findDisplayName(receipt.claudeModels, settings.claude.modelId) + " (" + (settings.claude.reasoningEffort ?? "за замовчуванням моделі") + ")",
    settings.speedPreset
  ]
    .map(escapeHtml)
    .join(" · ");
}

function renderEffectiveSettings(model: SettingsPageModel): string {
  if (model.read.effectiveForNextSession === null) {
    return '<span class="error">Збережений набір більше не сумісний із поточним каталогом. Виберіть підтверджену комбінацію або поверніть default.</span>';
  }
  return formatSettings(model.read.effectiveForNextSession, model.capabilityReceipt);
}

function renderActiveSession(model: SettingsPageModel): string {
  if (model.read.activeSessionStatus === "unavailable") {
    return "Статус активної сесії тимчасово недоступний";
  }
  if (model.read.activeSessionStatus === "none" || model.read.activeSessionSnapshot === null) {
    return "Активної сесії немає";
  }
  const snapshot = model.read.activeSessionSnapshot;
  return `${formatSettings(snapshot.effectiveSettings, model.capabilityReceipt)} · revision ${snapshot.settingsRevision} · catalog ${escapeHtml(snapshot.catalogVersion)}`;
}

const jsonForScript = (value: unknown): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");

function renderModelOptions(models: readonly ProviderModelCapability[], selectedId: string): string {
  return models
    .filter((model) => model.availability === "available")
    .map((model) => {
      const selected = model.productId === selectedId ? " selected" : "";
      return `<option value="${escapeHtml(model.productId)}"${selected}>${escapeHtml(model.displayName)}</option>`;
    })
    .join("");
}

function renderEffortOptions(model: ProviderModelCapability | undefined, selected: ProviderReasoningEffort | null): string {
  const efforts = model === undefined
    ? []
    : model.supportedReasoningEfforts.filter((effort) => isEffortSupported(model, effort));
  const defaultOption = '<option value=""' + (selected === null ? " selected" : "") + '>За замовчуванням моделі</option>';
  return [
    defaultOption,
    ...efforts.map((effort) =>
      '<option value="' + escapeHtml(effort) + '"' + (selected === effort ? " selected" : "") + '>' + escapeHtml(effort) + "</option>"
    )
  ].join("");
}

export function renderAccessDeniedDocument(): string {
  return `<!doctype html>
<html lang="uk">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Доступ відхилено — Налаштування власника</title>
    <link rel="stylesheet" href="/assets/settings.css" />
  </head>
  <body class="settings-shell">
    <main class="settings-page settings-access-page" id="main-content" tabindex="-1">
      <section class="access-boundary error" role="alert" aria-labelledby="access-denied-title">
        <span class="access-symbol" aria-hidden="true">!</span>
        <div>
          <p class="settings-eyebrow">Доступ власника</p>
          <h1 id="access-denied-title">Доступ відхилено</h1>
          <p>Цей обліковий запис не має доступу до налаштувань. Значення налаштувань не показано.</p>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export function renderSettingsDocument(model: SettingsPageModel): string {
  const current = model.read.document.settings;
  const draft = model.draft ?? current;
  const formState = deriveSettingsFormState(draft, current, model.capabilityReceipt, model.now);
  const codex = model.capabilityReceipt.codexModels.find((item) => item.productId === draft.codex.modelId);
  const claude = model.capabilityReceipt.claudeModels.find((item) => item.productId === draft.claude.modelId);
  const saveDisabled = formState.canSave ? "" : " disabled";
  const changed = formState.isDirty ? '<span class="changed-label">Змінено</span>' : "";
  const clientCatalog = jsonForScript({
    codexModels: model.capabilityReceipt.codexModels.map((item) => ({
      id: item.productId,
      availability: item.availability,
      efforts: item.supportedReasoningEfforts
    })),
    claudeModels: model.capabilityReceipt.claudeModels.map((item) => ({
      id: item.productId,
      availability: item.availability,
      efforts: item.supportedReasoningEfforts
    }))
  });

  return `<!doctype html>
<html lang="uk">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="settings-csrf-token" content="${escapeHtml(model.csrfToken)}" />
    <title>Налаштування власника</title>
    <link rel="stylesheet" href="/assets/settings.css" />
    <script id="settings-catalog" type="application/json">${clientCatalog}</script>
    <script src="/assets/settings.js" defer></script>
  </head>
  <body class="settings-shell">
    <a class="skip-link" href="#main-content">Перейти до налаштувань</a>
    <main class="settings-page" id="main-content" tabindex="-1">
      <header class="settings-header">
        <div>
          <p class="settings-eyebrow">Персональний консультант</p>
          <h1>Налаштування власника</h1>
          <p class="settings-intro">Ці параметри застосовуються лише до нових сесій. Щоденна робота залишається в Element.</p>
        </div>
        <a class="element-return" href="https://app.element.io/" rel="noreferrer">Відкрити Element</a>
      </header>

      <section class="identity-section" aria-labelledby="access-title">
        <div>
          <p class="section-kicker">Доступ власника</p>
          <h2 id="access-title">Власник підтверджений</h2>
          <p>Доступ перевірено. Ключ входу, дані підписок та OAuth-облікові дані тут не відображаються.</p>
        </div>
        <div>
          <span class="access-state">Доступ надано</span>
          <form action="/auth/sign-out" method="post"><button class="button quiet" type="submit">Вийти</button></form>
        </div>
      </section>

      <section class="values-section" aria-labelledby="values-title">
        <h2 id="values-title">Які значення діють</h2>
        <dl class="values-list">
          <div><dt>Current для наступної сесії</dt><dd>${renderEffectiveSettings(model)}</dd></div>
          <div><dt>Default</dt><dd>${formatSettings(model.read.defaults, model.capabilityReceipt)}</dd></div>
          <div class="active-value"><dt>Активна сесія</dt><dd>${renderActiveSession(model)}</dd></div>
        </dl>
        <p class="snapshot-note">Активна сесія використовує незмінний snapshot. Збереження або reset не змінять її.</p>
      </section>

      <form id="settings-form" method="post" novalidate data-etag="${escapeHtml(model.read.etag)}" data-current="${escapeHtml(JSON.stringify(current))}">
        <section class="settings-group" aria-labelledby="codex-title">
          <div class="group-heading"><div><p class="group-number">1</p><h2 id="codex-title">Codex-агенти</h2></div>${changed}</div>
          <p class="provider-description">Модель і міркування Codex налаштовуються лише для Codex. Вони не змінюють Claude Code.</p>
          <div class="field-grid">
            <label for="codex-model"><span>Модель Codex</span><select id="codex-model" name="codexModelId">${renderModelOptions(model.capabilityReceipt.codexModels, draft.codex.modelId)}</select><small>Лише моделі, які повернув поточний Codex runtime.</small></label>
            <label for="codex-effort"><span>Міркування Codex</span><select id="codex-effort" name="codexReasoningEffort">${renderEffortOptions(codex, draft.codex.reasoningEffort)}</select><small>«За замовчуванням моделі» не передає окремий рівень у Codex.</small></label>
          </div>
        </section>

        <section class="settings-group" aria-labelledby="claude-title">
          <div class="group-heading"><div><p class="group-number">2</p><h2 id="claude-title">Claude Code-критик</h2></div>${changed}</div>
          <p class="provider-description">Claude Code працює як незалежний критик. Його модель і рівень міркування не мають спільної шкали з Codex.</p>
          <div class="field-grid">
            <label for="claude-model"><span>Модель Claude Code</span><select id="claude-model" name="claudeModelId">${renderModelOptions(model.capabilityReceipt.claudeModels, draft.claude.modelId)}</select><small>Показані лише моделі, успішно перевірені в поточній Claude Code підписці.</small></label>
            <label for="claude-effort"><span>Міркування Claude Code</span><select id="claude-effort" name="claudeReasoningEffort">${renderEffortOptions(claude, draft.claude.reasoningEffort)}</select><small>Рівні залежать від обраної Claude-моделі; однакові назви не означають однакову інтенсивність із Codex.</small></label>
          </div>
        </section>

        <section class="settings-group" aria-labelledby="speed-title">
          <div class="group-heading"><div><p class="group-number">3</p><h2 id="speed-title">Швидкість консиліуму</h2></div>${changed}</div>
          <fieldset class="speed-options"><legend class="sr-only">Виберіть швидкість оркестрації</legend>${SPEEDS.map((speed) => `<label><input type="radio" name="speedPreset" value="${speed.value}"${speed.value === draft.speedPreset ? " checked" : ""} /><span><strong>${speed.title}</strong><small>${speed.description}</small></span></label>`).join("")}</fieldset>
          <p class="mapping-note">Це лише оркестрація агентів. Обов’язкові межі безпеки не змінюються.</p>
        </section>

        <section id="settings-status" class="validation-status ${formState.canSave || !formState.isDirty ? "success" : "error"}" role="status" aria-live="polite">
          <strong>${formState.canSave ? "Зміни готові до збереження" : formState.isDirty ? "Комбінація несумісна" : "Набір сумісний"}</strong>
          <p>${escapeHtml(formState.validationMessage)}</p>
        </section>

        <div class="settings-actions">
          <button type="submit" class="button primary"${saveDisabled}>Зберегти весь набір</button>
          <button type="button" id="reset-button" class="button secondary">Повернути default</button>
          <button type="button" id="cancel-button" class="button quiet"${formState.isDirty ? "" : " disabled"}>Скасувати зміни</button>
        </div>
      </form>
    </main>
  </body>
</html>`;
}
