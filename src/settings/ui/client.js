(() => {
  const form = document.getElementById("settings-form");
  const status = document.getElementById("settings-status");
  const catalogNode = document.getElementById("settings-catalog");
  let csrfToken = document.querySelector('meta[name="settings-csrf-token"]')?.getAttribute("content");
  if (!(form instanceof HTMLFormElement) || !(status instanceof HTMLElement) || !(catalogNode instanceof HTMLScriptElement) || !csrfToken) return;

  let catalog;
  let current;
  try {
    catalog = JSON.parse(catalogNode.textContent || "");
    current = JSON.parse(form.dataset.current || "");
  } catch {
    return;
  }

  const codexModel = form.elements.namedItem("codexModelId");
  const claudeModel = form.elements.namedItem("claudeModelId");
  const saveButton = form.querySelector('button[type="submit"]');
  const resetButton = document.getElementById("reset-button");
  const cancelButton = document.getElementById("cancel-button");
  if (!(codexModel instanceof HTMLSelectElement) || !(claudeModel instanceof HTMLSelectElement) || !(saveButton instanceof HTMLButtonElement)) return;

  const currentValues = () => ({
    codexModelId: codexModel.value,
    claudeModelId: claudeModel.value,
    reasoningDepth: form.querySelector('input[name="reasoningDepth"]:checked')?.value || "",
    speedPreset: form.querySelector('input[name="speedPreset"]:checked')?.value || ""
  });

  const isSame = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const availableDepths = () => {
    const codex = catalog.codexModels?.find((model) => model.id === codexModel.value && model.availability === "available");
    const claude = catalog.claudeModels?.find((model) => model.id === claudeModel.value && model.availability === "available");
    if (!codex || !claude) return [];
    return codex.depths.filter((depth) => claude.depths.includes(depth));
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
    const supportedDepths = availableDepths();
    const values = currentValues();
    const depthControls = [...form.querySelectorAll('input[name="reasoningDepth"]')];
    for (const control of depthControls) control.disabled = !supportedDepths.includes(control.value);
    const compatible = supportedDepths.includes(values.reasoningDepth);
    const dirty = !isSame(values, current);
    saveButton.disabled = !dirty || !compatible;
    if (!compatible) {
      setStatus("error", "Ця глибина міркування не підтверджена для обох обраних моделей. Значення не буде знижено автоматично.");
    } else if (dirty) {
      setStatus("success", "Увесь набір сумісний. Збереження застосує його лише до наступної сесії.");
    } else {
      setStatus("success", "Набір сумісний. Змін для збереження немає.");
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
    const response = await fetch("/api/settings/csrf", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" }
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

  form.addEventListener("change", refreshForm);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = currentValues();
    if (saveButton.disabled) return;
    void submit("/api/settings", values);
  });
  resetButton?.addEventListener("click", () => {
    if (window.confirm("Повернути стандартні значення для наступної сесії?")) void submit("/api/settings/reset", { confirmed: true });
  });
  cancelButton?.addEventListener("click", () => window.location.reload());
  refreshForm();
})();
