import { deriveSettingsFormState } from "./controller.ts";
import { validateCatalogTiming } from "../catalog.ts";
import type { SettingsReadModel } from "../owner-settings-do.ts";
import type { CapabilityReceipt, OwnerSettings, ProviderModelCapability, ProviderReasoningEffort, ProviderSettings, SpeedPreset } from "../types.ts";

export type SettingsPageModel = Readonly<{
  read: SettingsReadModel;
  capabilityReceipt: CapabilityReceipt;
  csrfToken: string;
  draft?: OwnerSettings;
  now: Date;
  ownerActionTokens?: Readonly<Record<string, string>>;
}>;

const SPEEDS: ReadonlyArray<Readonly<{ value: SpeedPreset; title: string; description: string }>> = [
  { value: "швидко", title: "Швидко", description: "Менше додаткових перевірок, один обов’язковий цикл критики." },
  { value: "збалансовано", title: "Збалансовано", description: "Рекомендований баланс темпу, перевірки й повноти." },
  { value: "ретельно", title: "Ретельно", description: "Більше доречних перевірок у межах тих самих правил безпеки." }
];
const CLAUDE_MODEL_ORDER = new Map<string, number>([
  ["claude-fable-5", 0],
  ["claude-opus-5", 1],
  ["claude-opus-4-8", 2],
  ["claude-opus-4-7", 3],
  ["claude-opus-4-6", 4],
  ["claude-opus-4-5-20251101", 5],
  ["claude-sonnet-5", 6],
  ["claude-sonnet-4-6", 7],
  ["claude-sonnet-4-5-20250929", 8],
  ["claude-haiku-4-5-20251001", 9],
  ["fable", 10],
  ["opus", 11],
  ["sonnet", 12],
  ["haiku", 13]
]);

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
  typeof model.reasoningMappings[effort] === "string" && model.reasoningMappings[effort]!.length > 0;

const displayName = (model: ProviderModelCapability): string =>
  model.runtimeModelId === "gpt-6-astra" ? "GPT-6 Astra" : model.displayName;
const effortLabel = (provider: "codex" | "claude", effort: string | null): string =>
  effort === null ? "за замовчуванням моделі" : provider === "codex" && effort === "xhigh" ? "Extra High" : effort;

function findDisplayName(models: readonly ProviderModelCapability[], id: string): string {
  const model = models.find((model) => model.productId === id);
  return model === undefined ? "Недоступна модель" : displayName(model);
}

function formatSettings(settings: OwnerSettings, receipt: CapabilityReceipt): string {
  const criticProvider = settings.critic.provider === "codex" ? "codex" : "claude";
  const critic = settings.critic[criticProvider];
  return [
    "Codex-агенти: " + findDisplayName(receipt.codexModels, settings.codex.modelId) + " (" + effortLabel("codex", settings.codex.reasoningEffort) + ")",
    "Критик · " + (criticProvider === "codex" ? "Codex" : "Claude Code") + ": " + (critic === null ? "параметри ще не вибрано" :
      findDisplayName(criticProvider === "codex" ? receipt.codexModels : receipt.claudeModels, critic.modelId) + " (" + effortLabel(criticProvider, critic.reasoningEffort) + ")"),
    settings.speedPreset
  ]
    .map(escapeHtml)
    .join(" · ");
}

function renderEffectiveSettings(model: SettingsPageModel): string {
  if (model.read.effectiveForNextSession === null) {
    return '<span class="error">Збережений набір більше не сумісний із поточним каталогом. Виберіть підтверджену комбінацію або <a href="/operations/runtime">перевірте підключення провайдера</a>.</span>';
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

function orderedModels(provider: "codex" | "claude", models: readonly ProviderModelCapability[]): readonly ProviderModelCapability[] {
  const indexed = models.map((model, index) => ({ model, index }));
  const ordered = provider === "claude"
    ? indexed.sort((left, right) => (CLAUDE_MODEL_ORDER.get(left.model.runtimeModelId) ?? Number.MAX_SAFE_INTEGER) -
        (CLAUDE_MODEL_ORDER.get(right.model.runtimeModelId) ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
    : indexed;
  return ordered.map(({ model }) => model);
}

function renderModelOptions(provider: "codex" | "claude", models: readonly ProviderModelCapability[], selectedId: string | null): string {
  const visible = orderedModels(provider, models).filter((model) => model.availability === "available");
  const unavailable = selectedId !== null && !visible.some((model) => model.productId === selectedId);
  return [
    ...(selectedId === null ? ['<option value="" selected>Виберіть модель</option>'] : []),
    ...(unavailable ? [`<option value="${escapeHtml(selectedId)}" selected disabled>${escapeHtml(findDisplayName(models, selectedId))} — недоступно</option>`] : []),
    ...visible.map((model) => {
      const selected = model.productId === selectedId ? " selected" : "";
      return `<option value="${escapeHtml(model.productId)}"${selected}>${escapeHtml(displayName(model))}</option>`;
    })
  ].join("");
}

function renderEffortOptions(provider: "codex" | "claude", model: ProviderModelCapability | undefined, selected: ProviderReasoningEffort | null): string {
  const efforts = model === undefined
    ? []
    : model.supportedReasoningEfforts.filter((effort) => isEffortSupported(model, effort));
  const defaultOption = '<option value=""' + (selected === null ? " selected" : "") + '>За замовчуванням моделі</option>';
  return [
    defaultOption,
    ...(selected !== null && !efforts.includes(selected) ? [`<option value="${escapeHtml(selected)}" selected disabled>${escapeHtml(effortLabel(provider, selected))} — недоступно</option>`] : []),
    ...efforts.map((effort) =>
      '<option value="' + escapeHtml(effort) + '"' + (selected === effort ? " selected" : "") + '>' + escapeHtml(effortLabel(provider, effort)) + "</option>"
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
  const criticProvider = draft.critic.provider === "codex" ? "codex" : "claude";
  const criticSettings = draft.critic[criticProvider];
  const criticModels = criticProvider === "codex" ? model.capabilityReceipt.codexModels : model.capabilityReceipt.claudeModels;
  const critic = criticModels.find((item) => item.productId === criticSettings?.modelId);
  const criticReceipt = model.capabilityReceipt.providerReceipts?.[draft.critic.provider];
  const criticCatalogReady = validateCatalogTiming(model.capabilityReceipt, model.now) === null &&
    (criticReceipt === undefined || (criticReceipt.status === "ready" && validateCatalogTiming(criticReceipt, model.now) === null));
  const criticCompatible = criticCatalogReady && criticSettings !== null && critic?.availability === "available" &&
    (criticSettings.reasoningEffort === null || isEffortSupported(critic, criticSettings.reasoningEffort));
  const criticName = criticProvider === "codex" ? "Codex" : "Claude Code";
  const savedCritic = current.critic[criticProvider];
  const criticSavedText = (settings: ProviderSettings | null): string => settings === null ? "Для цього провайдера параметри ще не збережено." :
    "Збережено: " + findDisplayName(criticModels, settings.modelId) + " · " + effortLabel(criticProvider, settings.reasoningEffort) + ".";
  const saveDisabled = formState.canSave ? "" : " disabled";
  const changed = formState.isDirty ? '<span class="changed-label">Змінено</span>' : "";
  const clientCatalog = jsonForScript({
    issuedAt: model.capabilityReceipt.issuedAt,
    expiresAt: model.capabilityReceipt.expiresAt,
    trusted: model.capabilityReceipt.trusted,
    providerReceipts: model.capabilityReceipt.providerReceipts,
    codexModels: orderedModels("codex", model.capabilityReceipt.codexModels).map((item) => ({
      id: item.productId,
      displayName: displayName(item),
      availability: item.availability,
      efforts: item.supportedReasoningEfforts.filter((effort) => isEffortSupported(item, effort))
    })),
    claudeModels: orderedModels("claude", model.capabilityReceipt.claudeModels).map((item) => ({
      id: item.productId,
      displayName: displayName(item),
      availability: item.availability,
      efforts: item.supportedReasoningEfforts.filter((effort) => isEffortSupported(item, effort))
    }))
  });

  return `<!doctype html>
<html lang="uk">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="settings-csrf-token" content="${escapeHtml(model.csrfToken)}" />
    ${model.ownerActionTokens === undefined ? "" : `<meta name="owner-csrf-refresh-token" content="${escapeHtml(model.ownerActionTokens["/api/settings/csrf"] ?? "")}" /><script src="/assets/owner-auth.js" defer></script>`}
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
          <p>Доступ перевірено. Дані підписок і Google-облікові дані тут не відображаються.</p>
        </div>
        <div>
          <span class="access-state">Доступ надано</span>
          ${model.ownerActionTokens === undefined ? "" : `<form action="/auth/sign-out" method="post" data-owner-action><input type="hidden" name="formToken" value="${escapeHtml(model.ownerActionTokens["/auth/sign-out"] ?? "")}" /><button class="button quiet" type="submit">Вийти</button></form>
          <form action="/auth/sessions/revoke" method="post" data-owner-action><input type="hidden" name="formToken" value="${escapeHtml(model.ownerActionTokens["/auth/sessions/revoke"] ?? "")}" /><button class="button quiet" type="submit">Вийти на всіх пристроях</button></form>
          <p>Це завершує лише доступ до застосунку, не вихід із Google. Підписки Codex і Claude Code залишаться підключеними.</p>
          <p id="owner-action-status" data-owner-action-status role="status" aria-live="polite" tabindex="-1"></p><noscript>Для безпечного входу й виходу потрібен JavaScript.</noscript>`}
        </div>
      </section>

      <section class="values-section" aria-labelledby="values-title">
        <h2 id="values-title">Які значення діють</h2>
        <dl class="values-list">
          <div><dt>Current для наступної сесії</dt><dd>${renderEffectiveSettings(model)}</dd></div>
          <div><dt>Default</dt><dd>${formatSettings(model.read.defaults, model.capabilityReceipt)}${model.read.defaultsIncompatibility ? '<p class="mapping-note">Стандартний набір зараз недоступний. Можна вручну зберегти сумісний маршрут або <a href="/operations/runtime">перевірити підключення провайдера</a>.</p>' : ""}</dd></div>
          <div class="active-value"><dt>Активна сесія</dt><dd>${renderActiveSession(model)}</dd></div>
        </dl>
        <p class="snapshot-note">Активна сесія використовує незмінний snapshot. Збереження або reset не змінять її.</p>
      </section>

      <form id="settings-form" method="post" novalidate data-etag="${escapeHtml(model.read.etag)}" data-current="${escapeHtml(JSON.stringify(current))}" data-draft="${escapeHtml(JSON.stringify(draft))}">
        <section class="settings-group" aria-labelledby="codex-title">
          <div class="group-heading"><div><p class="group-number">1</p><h2 id="codex-title">Codex-агенти</h2></div>${changed}</div>
          <p class="provider-description">Модель і міркування Codex-агентів не змінюють параметри Критика, навіть коли він також працює через Codex.</p>
          <div class="field-grid">
            <label for="codex-model"><span>Модель Codex</span><select id="codex-model" name="codexModelId">${renderModelOptions("codex", model.capabilityReceipt.codexModels, draft.codex.modelId)}</select><small>Лише моделі, які повернув поточний Codex runtime.</small></label>
            <label for="codex-effort"><span>Міркування Codex</span><select id="codex-effort" name="codexReasoningEffort">${renderEffortOptions("codex", codex, draft.codex.reasoningEffort)}</select><small>«За замовчуванням моделі» не передає окремий рівень у Codex.</small></label>
          </div>
        </section>

        <section class="settings-group" aria-labelledby="critic-title">
          <div class="group-heading"><div><p class="group-number">2</p><h2 id="critic-title">Критик</h2></div>${changed}</div>
          <p class="provider-description">Критик працює незалежно від Codex-агентів. Оберіть провайдера та його власні модель і міркування; уподобання іншого провайдера збережуться.</p>
          <div class="field-grid">
            <label for="critic-provider"><span>Провайдер Критика</span><select id="critic-provider" name="criticProvider" aria-describedby="critic-preservation"><option value="claude_code"${draft.critic.provider === "claude_code" ? " selected" : ""}>Claude Code</option><option value="codex"${draft.critic.provider === "codex" ? " selected" : ""}>Codex</option></select></label>
          </div>
          <fieldset class="field-grid critic-fields"><legend class="sr-only">Параметри Критика</legend>
            <label for="critic-model"><span>Модель Критика</span><select id="critic-model" name="criticModelId" aria-describedby="critic-model-help critic-feedback">${renderModelOptions(criticProvider, criticModels, criticSettings?.modelId ?? null)}</select><small id="critic-model-help">Провайдер: ${criticName}. Лише моделі з підтвердженого каталогу.</small></label>
            <label for="critic-effort"><span>Міркування Критика</span><select id="critic-effort" name="criticReasoningEffort" aria-describedby="critic-effort-help critic-feedback">${renderEffortOptions(criticProvider, critic, criticSettings?.reasoningEffort ?? null)}</select><small id="critic-effort-help">«За замовчуванням моделі» не передає окремий рівень. Шкала належить обраному провайдеру.</small></label>
          </fieldset>
          <p id="critic-saved" class="mapping-note">${escapeHtml(criticSavedText(savedCritic))}</p>
          <p id="critic-preservation" class="mapping-note">Перемикання не зберігає зміни автоматично й не змінює Codex-агентів або активну сесію.</p>
          <p id="critic-feedback" class="critic-feedback${criticCompatible ? "" : " error"}" role="status" aria-live="polite"><span id="critic-feedback-text">${criticCompatible ? "Обрані параметри Критика підтверджені." : "Оберіть підтверджені модель і міркування Критика. Попередні уподобання не видалено."}</span> <a id="critic-recovery-link" href="/operations/runtime"${criticCompatible ? " hidden" : ""}>Перевірити підключення провайдера</a></p>
        </section>

        <section class="settings-group" aria-labelledby="speed-title">
          <div class="group-heading"><div><p class="group-number">3</p><h2 id="speed-title">Швидкість консиліуму</h2></div>${changed}</div>
          <fieldset class="speed-options"><legend class="sr-only">Виберіть швидкість оркестрації</legend>${SPEEDS.map((speed) => `<label><input type="radio" name="speedPreset" value="${speed.value}"${speed.value === draft.speedPreset ? " checked" : ""} /><span><strong>${speed.title}</strong><small>${speed.description}</small></span></label>`).join("")}</fieldset>
          <p class="mapping-note">Це лише оркестрація агентів. Обов’язкові межі безпеки не змінюються.</p>
        </section>

        <section id="settings-status" class="validation-status ${formState.isCompatible ? "success" : "error"}" role="status" aria-live="polite">
          <strong>${!formState.isCompatible ? "Комбінація несумісна" : formState.canSave ? "Зміни готові до збереження" : "Набір сумісний"}</strong>
          <p>${escapeHtml(formState.validationMessage)}</p>
        </section>

        <div class="settings-actions">
          <button type="submit" class="button primary"${saveDisabled}>Зберегти весь набір</button>
          <button type="button" id="reset-button" class="button secondary"${model.read.defaultsIncompatibility ? " disabled" : ""}>Повернути default</button>
          <button type="button" id="cancel-button" class="button quiet"${formState.isDirty ? "" : " disabled"}>Скасувати зміни</button>
        </div>
      </form>
    </main>
  </body>
</html>`;
}
