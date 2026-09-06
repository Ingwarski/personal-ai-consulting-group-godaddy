(() => {
  const form = document.getElementById("settings-form");
  const status = document.getElementById("settings-status");
  const catalogNode = document.getElementById("settings-catalog");
  let csrfToken = document.querySelector('meta[name="settings-csrf-token"]')?.getAttribute("content");
  if (!(form instanceof HTMLFormElement) || !(status instanceof HTMLElement) || !(catalogNode instanceof HTMLScriptElement) || !csrfToken) return;

  let catalog;
  let current;
  let initialDraft;
  try {
    catalog = JSON.parse(catalogNode.textContent || "");
    current = JSON.parse(form.dataset.current || "");
    initialDraft = JSON.parse(form.dataset.draft || form.dataset.current || "");
  } catch {
    return;
  }

  const codexModel = form.elements.namedItem("codexModelId");
  const codexEffort = form.elements.namedItem("codexReasoningEffort");
  const criticProvider = form.elements.namedItem("criticProvider");
  const criticModel = form.elements.namedItem("criticModelId");
  const criticEffort = form.elements.namedItem("criticReasoningEffort");
  const criticFeedback = document.getElementById("critic-feedback");
  const criticFeedbackText = document.getElementById("critic-feedback-text");
  const criticRecovery = document.getElementById("critic-recovery-link");
  const saveButton = form.querySelector('button[type="submit"]');
  const resetButton = document.getElementById("reset-button");
  const cancelButton = document.getElementById("cancel-button");
  if (!(codexModel instanceof HTMLSelectElement) || !(criticProvider instanceof HTMLSelectElement) ||
    !(codexEffort instanceof HTMLSelectElement) || !(criticModel instanceof HTMLSelectElement) || !(criticEffort instanceof HTMLSelectElement) ||
    !(saveButton instanceof HTMLButtonElement)) return;

  let activeCriticKey = criticProvider.value === "codex" ? "codex" : "claude";
  const criticDraft = structuredClone(initialDraft.critic);
  const rememberCriticFields = () => {
    criticDraft[activeCriticKey] = criticModel.value ? {
      modelId: criticModel.value,
      reasoningEffort: criticEffort.value || null
    } : null;
  };
  const currentValues = () => {
    rememberCriticFields();
    return {
      codex: {
        modelId: codexModel.value,
        reasoningEffort: codexEffort.value || null
      },
      critic: {
        provider: criticProvider.value,
        claude: criticDraft.claude,
        codex: criticDraft.codex
      },
      speedPreset: form.querySelector('input[name="speedPreset"]:checked')?.value || ""
    };
  };

  const isSame = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const selectedProvider = (models, modelId) =>
    models?.find((model) => model.id === modelId && model.availability === "available");

  const effortLabel = (provider, effort) => provider === "codex" && effort === "xhigh" ? "Extra High" : effort;
  const syncEffortOptions = (select, model, previous, provider) => {
    const efforts = model?.efforts || [];
    const missing = previous && !efforts.includes(previous) ? new Option(effortLabel(provider, previous) + " — недоступно", previous, true, true) : undefined;
    if (missing) missing.disabled = true;
    select.replaceChildren(
      new Option("За замовчуванням моделі", ""),
      ...(missing ? [missing] : []),
      ...efforts.map((effort) => new Option(effortLabel(provider, effort), effort))
    );
    // Preserve an unsupported saved effort visibly; never silently lower it.
    select.value = previous || "";
  };
  const criticModels = () => activeCriticKey === "codex" ? catalog.codexModels : catalog.claudeModels;
  const syncCriticFields = () => {
    const models = criticModels() || [];
    const selected = criticDraft[activeCriticKey];
    const available = models.filter(model => model.availability === "available");
    const options = [];
    if (!selected) options.push(new Option("Виберіть модель", "", true, true));
    if (selected && !available.some(model => model.id === selected.modelId)) {
      const name = models.find(model => model.id === selected.modelId)?.displayName || "Недоступна модель";
      const option = new Option(name + " — недоступно", selected.modelId, true, true);
      option.disabled = true;
      options.push(option);
    }
    options.push(...available.map(model => new Option(model.displayName, model.id)));
    criticModel.replaceChildren(...options);
    criticModel.value = selected?.modelId || "";
    syncEffortOptions(criticEffort, selectedProvider(models, criticModel.value), selected?.reasoningEffort, activeCriticKey);
    const name = activeCriticKey === "codex" ? "Codex" : "Claude Code";
    const help = document.getElementById("critic-model-help");
    if (help) help.textContent = "Провайдер: " + name + ". Лише моделі з підтвердженого каталогу.";
    const saved = current.critic[activeCriticKey];
    const savedText = document.getElementById("critic-saved");
    if (savedText) savedText.textContent = saved
      ? "Збережено: " + (models.find(model => model.id === saved.modelId)?.displayName || "Недоступна модель") + " · " + (saved.reasoningEffort === null ? "за замовчуванням моделі" : effortLabel(activeCriticKey, saved.reasoningEffort)) + "."
      : "Для цього провайдера параметри ще не збережено.";
  };
  const providerFresh = (provider) => {
    const receipt = catalog.providerReceipts?.[provider === "claude" ? "claude_code" : "codex"];
    const at = Date.now();
    const fresh = value => value.trusted === true && Date.parse(value.issuedAt) <= at && Date.parse(value.expiresAt) > at;
    return fresh(catalog) && (!receipt || (receipt.status === "ready" && fresh(receipt)));
  };

  const setStatus = (kind, text, title) => {
    status.classList.toggle("success", kind === "success");
    status.classList.toggle("error", kind === "error");
    const heading = status.querySelector("strong");
    const detail = status.querySelector("p");
    if (heading) heading.textContent = title || (kind === "error" ? "Комбінація несумісна" : "Зміни готові до збереження");
    if (detail) detail.textContent = text;
  };

  const refreshForm = () => {
    const codex = selectedProvider(catalog.codexModels, codexModel.value);
    const critic = selectedProvider(criticModels(), criticModel.value);
    const values = currentValues();
    const selected = values.critic[activeCriticKey];
    const codexCompatible = providerFresh("codex") && Boolean(codex) && (values.codex.reasoningEffort === null || codex.efforts.includes(values.codex.reasoningEffort));
    const criticCompatible = providerFresh(activeCriticKey) && Boolean(critic) && selected !== null && (selected.reasoningEffort === null || critic.efforts.includes(selected.reasoningEffort));
    const compatible = codexCompatible && criticCompatible;
    const criticName = activeCriticKey === "codex" ? "Codex" : "Claude Code";
    if (criticFeedback) criticFeedback.classList.toggle("error", !criticCompatible);
    if (criticRecovery) criticRecovery.hidden = criticCompatible;
    if (criticFeedbackText) criticFeedbackText.textContent = criticCompatible
      ? "Критик: " + criticName + ". Обрані параметри підтверджені. Уподобання іншого провайдера збережено."
      : !providerFresh(activeCriticKey) || !(criticModels() || []).some(model => model.availability === "available")
        ? "Критик: " + criticName + ". Каталог провайдера недоступний або застарів. Попередні уподобання збережено; перевірте підключення або явно виберіть іншого провайдера."
        : "Критик: " + criticName + ". Виберіть підтверджені модель і міркування. Недоступне значення не буде замінено автоматично.";
    const dirty = !isSame(values, current);
    saveButton.disabled = !dirty || !compatible;
    if (!compatible) {
      setStatus("error", !codexCompatible
        ? "Codex: обрана модель або рівень міркування більше не підтверджені."
        : "Критик: обрана модель або рівень міркування більше не підтверджені. Перевірте поля у блоці Критика.");
    } else if (dirty) {
      setStatus("success", "Незалежні налаштування Codex-агентів і вибраного Критика підтверджені. Збереження застосує їх лише до наступної сесії.");
    } else {
      setStatus("success", "Набір сумісний. Змін для збереження немає.", "Набір сумісний");
    }
    if (cancelButton instanceof HTMLButtonElement) cancelButton.disabled = !dirty;
  };

  const idempotencyKey = () => crypto.randomUUID ? crypto.randomUUID() : `settings-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  const requestHeaders = (key) => ({
    "content-type": "application/json",
    "if-match": form.dataset.etag || "",
    "idempotency-key": key,
    "x-csrf-token": csrfToken
  });

  let pendingMutation;
  const mutationFor = (url, body) => {
    const signature = JSON.stringify({ url, body });
    if (pendingMutation?.signature === signature) return pendingMutation;
    pendingMutation = { signature, key: idempotencyKey() };
    return pendingMutation;
  };

  const readError = async (response) => {
    try {
      const body = await response.json();
      return typeof body?.error === "string" ? body.error : "request_rejected";
    } catch {
      return "request_rejected";
    }
  };

  const refreshServerState = async () => {
    const response = await fetch("/api/settings", { credentials: "same-origin" });
    if (!response.ok) return false;
    const latest = await response.json();
    if (!latest?.document?.settings || typeof latest.document.revision !== "number") return false;
    current = latest.document.settings;
    form.dataset.current = JSON.stringify(current);
    form.dataset.etag = response.headers.get("etag") || "";
    return true;
  };

  const refreshCsrfToken = async () => {
    const actionToken = document.querySelector('meta[name="owner-csrf-refresh-token"]')?.getAttribute("content");
    const response = await fetch("/api/settings/csrf", {
      method: "POST",
      mode: "cors",
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...(actionToken ? { "x-owner-action-token": actionToken } : {}) },
      body: "{}"
    });
    if (!response.ok) return false;
    const body = await response.json();
    if (typeof body?.csrfToken !== "string" || body.csrfToken.length === 0) return false;
    csrfToken = body.csrfToken;
    return true;
  };

  const submit = async (url, body) => {
    const mutation = mutationFor(url, body);
    saveButton.disabled = true;
    try {
      const response = await fetch(url, { method: url.endsWith("/reset") ? "POST" : "PUT", headers: requestHeaders(mutation.key), body: JSON.stringify(body), credentials: "same-origin" });
      if (response.status === 409) {
        pendingMutation = undefined;
        const refreshed = await refreshServerState();
        refreshForm();
        setStatus("error", refreshed
          ? "Налаштування змінилися після відкриття сторінки. Перевірте нову версію та підтвердьте весь набір ще раз."
          : "Налаштування змінилися, але нову версію не вдалося завантажити. Оновіть сторінку.", "Потрібне повторне підтвердження");
        return;
      }
      if (response.status === 403 && await refreshCsrfToken()) {
        refreshForm();
        setStatus("error", "Захисний токен оновлено. Перевірте набір і натисніть зберегти ще раз.", "Потрібне повторне підтвердження");
        return;
      }
      if (response.status === 422) {
        const code = await readError(response);
        pendingMutation = undefined;
        refreshForm();
        setStatus("error", `Сервер відхилив непідтверджену комбінацію (${code}). Виберіть доступні значення.`, "Комбінація несумісна");
        return;
      }
      if (!response.ok) throw new Error("Settings request was rejected.");
      pendingMutation = undefined;
      window.location.reload();
    } catch {
      refreshForm();
      setStatus("error", "Не вдалося підтвердити результат. Повторна спроба використає той самий ключ і не створить дубль.", "Збереження не підтверджено");
    }
  };

  form.addEventListener("change", (event) => {
    if (event.target === codexModel) syncEffortOptions(codexEffort, selectedProvider(catalog.codexModels, codexModel.value), codexEffort.value, "codex");
    if (event.target === criticProvider) {
      rememberCriticFields();
      activeCriticKey = criticProvider.value === "codex" ? "codex" : "claude";
      syncCriticFields();
      // The provider selector is not replaced or refocused: keyboard focus stays.
    }
    if (event.target === criticModel) syncEffortOptions(criticEffort, selectedProvider(criticModels(), criticModel.value), criticEffort.value, activeCriticKey);
    refreshForm();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    refreshForm();
    const values = currentValues();
    if (saveButton.disabled) return;
    void submit("/api/settings", values);
  });
  resetButton?.addEventListener("click", () => {
    if (window.confirm("Повернути стандартні значення для наступної сесії?")) void submit("/api/settings/reset", { confirmed: true });
  });
  cancelButton?.addEventListener("click", () => window.location.reload());
  syncEffortOptions(codexEffort, selectedProvider(catalog.codexModels, codexModel.value), initialDraft.codex?.reasoningEffort, "codex");
  syncCriticFields();
  refreshForm();
})();
