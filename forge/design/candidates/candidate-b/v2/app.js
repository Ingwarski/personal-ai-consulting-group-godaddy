(function () {
  "use strict";

  const scenario = window.PC_MATRIX_SCENARIO_V2;
  const root = document.getElementById("prototype-root");
  const stateSelect = document.getElementById("state-select");
  const resetDialog = document.getElementById("reset-dialog");

  if (!scenario) {
    root.innerHTML = '<p class="fatal-state" role="alert">Не вдалося завантажити frozen fixture.</p>';
    return;
  }

  const CHAT_STATES = Object.entries(scenario.chatViews).map(([value, item]) => ({
    value,
    label: item.label,
    covers: item.covers
  }));

  const SETTINGS_STATES = [
    { value: "entry", label: "Вхід до налаштувань", covers: ["SS-30"] },
    { value: "access", label: "Google-доступ перевіряється", covers: ["SS-31"] },
    { value: "loaded", label: "Налаштування завантажені", covers: ["SS-32", "SS-35", "SS-44", "SS-46"] },
    { value: "denied", label: "Доступ відхилено", covers: ["SS-33"] },
    { value: "loading", label: "Завантаження значень", covers: ["SS-34"] },
    { value: "dirty", label: "Є валідні зміни", covers: ["SS-36"] },
    { value: "incompatible", label: "Несумісна комбінація", covers: ["SS-37"] },
    { value: "drift", label: "Провайдер недоступний", covers: ["SS-38"] },
    { value: "saving", label: "Збереження", covers: ["SS-39"] },
    { value: "saved", label: "Успішно збережено", covers: ["SS-40"] },
    { value: "failed", label: "Збереження не вдалося", covers: ["SS-41"] },
    { value: "reset", label: "Підтвердження reset", covers: ["SS-42"] },
    { value: "reset-done", label: "Default відновлено", covers: ["SS-43"] },
    { value: "offline", label: "Немає мережі", covers: ["SS-45"] }
  ];

  const OWNER_IDS = new Set([
    "owner-request",
    "owner-costs-command",
    "owner-stop-command",
    "owner-new-task-command"
  ]);

  const SYSTEM_ROLES = Object.freeze({
    "session-acknowledgement": "Головний консультант",
    "consilium-roster": "Головний консультант",
    "progress-wait": "Головний консультант",
    "continuation-permission": "Головний консультант",
    "failure-partial": "Головний консультант",
    "stop-acknowledgement": "Personal Consultant",
    "new-task-acknowledgement": "Personal Consultant",
    "final-conclusion": "Головний консультант",
    "final-actions": "Головний консультант",
    "final-risk-review": "Головний консультант",
    "final-technical-part": "Головний консультант"
  });

  const INITIAL_CURRENT_SETTINGS = Object.freeze({
    codex: "GPT-5.3-Codex",
    claude: "Claude Opus 4.6",
    reasoning: "high",
    speed: "збалансовано"
  });

  const DEFAULT_SETTINGS = Object.freeze({
    codex: "GPT-5.3-Codex",
    claude: "Claude Sonnet 4.6",
    reasoning: "high",
    speed: "збалансовано"
  });

  const ACTIVE_SETTINGS = Object.freeze({
    codex: "GPT-5.3-Codex",
    claude: "Claude Opus 4.6",
    reasoning: "high",
    speed: "ретельно"
  });

  let currentSettings = { ...INITIAL_CURRENT_SETTINGS };
  let draft = { ...currentSettings };
  let draftSource = "route";

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderInline(value) {
    return escapeHtml(value)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function renderMarkdown(source) {
    return String(source)
      .split(/\n\n+/)
      .map((block) => {
        const lines = block.split("\n");
        const bullets = lines.map((line) => line.match(/^(?:[-*]|•)\s+(.*)$/));
        if (bullets.every(Boolean)) {
          return `<ul>${bullets.map((match) => `<li>${renderInline(match[1])}</li>`).join("")}</ul>`;
        }

        const numbered = lines.map((line) => line.match(/^(\d+)\.\s+(.*)$/));
        if (numbered.every(Boolean)) {
          return `<ol>${numbered.map((match) => `<li value="${match[1]}">${renderInline(match[2])}</li>`).join("")}</ol>`;
        }

        if (lines.every((line) => /^>\s?/.test(line))) {
          return `<blockquote>${lines.map((line) => renderInline(line.replace(/^>\s?/, ""))).join("<br>")}</blockquote>`;
        }

        return `<p>${lines.map(renderInline).join("<br>")}</p>`;
      })
      .join("");
  }

  function currentRoute() {
    const params = new URLSearchParams(window.location.search);
    const surface = params.get("surface") === "settings" ? "settings" : "chat";
    const allowed = surface === "chat" ? CHAT_STATES : SETTINGS_STATES;
    const fallback = surface === "chat" ? "live" : "loaded";
    const state = allowed.some((item) => item.value === params.get("state"))
      ? params.get("state")
      : fallback;
    return { surface, state };
  }

  function setRoute(surface, state, replace) {
    const url = new URL(window.location.href);
    url.searchParams.set("surface", surface);
    url.searchParams.set("state", state);
    window.history[replace ? "replaceState" : "pushState"]({}, "", url);
    render();
  }

  function updateReviewControls(surface, state) {
    document.querySelectorAll("[data-surface]").forEach((button) => {
      const active = button.dataset.surface === surface;
      button.setAttribute("aria-pressed", String(active));
    });

    const states = surface === "chat" ? CHAT_STATES : SETTINGS_STATES;
    stateSelect.replaceChildren(
      ...states.map((item) => {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = item.label;
        option.selected = item.value === state;
        return option;
      })
    );
  }

  function contentEntries() {
    const entries = new Map();
    scenario.agentMessages.forEach((message) => {
      entries.set(message.id, { ...message, kind: "agent" });
    });
    Object.values(scenario.content).forEach((item) => {
      entries.set(item.id, { ...item, kind: "content" });
    });
    return entries;
  }

  function createMessage(item) {
    const listItem = document.createElement("li");
    const isOwner = OWNER_IDS.has(item.id);
    listItem.className = `timeline-event ${isOwner ? "owner-event" : "consultant-event"}`;

    const avatar = document.createElement("span");
    avatar.className = `event-avatar ${isOwner ? "owner-avatar" : "consultant-avatar"}`;
    avatar.textContent = isOwner ? "В" : "PC";
    avatar.setAttribute("aria-hidden", "true");

    const article = document.createElement("article");
    article.className = "event-content";

    const header = document.createElement("header");
    header.className = "event-header";

    const role = document.createElement("strong");
    role.textContent = isOwner
      ? "Ви"
      : item.kind === "agent"
        ? item.role
        : item.role || SYSTEM_ROLES[item.id] || "Personal Consultant";

    const time = document.createElement("time");
    time.textContent = item.time || "";

    header.append(role, time);
    article.append(header);

    if (item.kind === "agent" && item.addressedTo) {
      const reply = document.createElement("div");
      reply.className = "matrix-reply";
      reply.textContent = `Відповідь: ${item.addressedTo}`;
      article.append(reply);
    }

    const body = document.createElement("div");
    body.className = "message-body";
    body.innerHTML = renderMarkdown(item.kind === "agent" ? item.body : item.text);
    article.append(body);
    listItem.append(avatar, article);
    return listItem;
  }

  function renderChat(state) {
    root.replaceChildren(document.getElementById("chat-template").content.cloneNode(true));
    const view = scenario.chatViews[state];
    const entries = contentEntries();
    const stream = document.getElementById("message-stream");
    const fragment = document.createDocumentFragment();

    view.messageIds.forEach((id) => {
      const item = entries.get(id);
      if (item) fragment.append(createMessage(item));
    });
    stream.append(fragment);

    document.title = `${view.label} — Candidate B v2`;

    const firstCritical = stream.querySelector(
      ".timeline-event:last-child, .timeline-event:first-child"
    );
    if (firstCritical) firstCritical.scrollIntoView({ block: "nearest" });
  }

  function valuesRows() {
    const format = (settings) =>
      `${settings.codex} · ${settings.claude} · ${settings.reasoning} · ${settings.speed}`;
    return `
      <section class="values-section" aria-labelledby="values-title">
        <h2 id="values-title">Які значення діють</h2>
        <dl class="values-list">
          <div><dt>Current для наступної сесії</dt><dd>${format(currentSettings)}</dd></div>
          <div><dt>Default</dt><dd>${format(DEFAULT_SETTINGS)}</dd></div>
          <div class="active-value"><dt>Активна сесія</dt><dd>${format(ACTIVE_SETTINGS)}</dd></div>
        </dl>
        <p class="snapshot-note">
          Активна сесія використовує незмінний snapshot. Збереження або reset не змінять її.
        </p>
      </section>`;
  }

  function settingsStatus(state) {
    const states = {
      loaded: { tone: "neutral", title: "Набір сумісний", text: "Змін немає. Обидва runtimes підтвердили вибрані значення." },
      dirty: { tone: "success", title: "Зміни готові до збереження", text: "Увесь набір сумісний для Codex і Claude Code." },
      incompatible: { tone: "error", title: "Комбінація несумісна", text: "Claude Sonnet 4.6 не підтверджує xhigh. Збереження і нова сесія заблоковані; значення не буде знижено автоматично." },
      drift: { tone: "error", title: "Сумісність не підтверджена", text: "Claude Code зараз недоступний. Current і snapshot активної сесії не змінено." },
      saving: { tone: "progress", title: "Зберігаємо весь набір", text: "Повторне збереження недоступне до завершення атомарної операції." },
      saved: { tone: "success", title: "Увесь набір збережено", text: "Нові значення стануть effective на старті наступної сесії. Активна сесія не змінилася." },
      failed: { tone: "error", title: "Нічого не збережено", text: "Жодна з трьох груп не змінилася. Попередня версія залишається current." },
      "reset-done": { tone: "success", title: "Default відновлено", text: "Усі три групи атомарно повернуто до default для наступних сесій." },
      offline: { tone: "warning", title: "Немає мережі", text: "Показані значення можуть бути несвіжими. Save і reset недоступні до повторної перевірки." },
      reset: { tone: "warning", title: "Потрібне підтвердження", text: "Current не зміниться, доки ви явно не підтвердите reset усіх трьох груп." }
    };
    return states[state] || states.loaded;
  }

  function settingsForm(state) {
    if (draftSource !== "user") {
      if (state === "incompatible") {
        draft = { ...currentSettings, claude: "Claude Sonnet 4.6", reasoning: "xhigh" };
      } else if (state === "dirty") {
        draft = { ...currentSettings, reasoning: "xhigh" };
      } else if (state === "reset-done") {
        draft = { ...DEFAULT_SETTINGS };
      } else {
        draft = { ...currentSettings };
      }
    }

    const status = settingsStatus(state);
    const disabled = ["drift", "saving", "offline"].includes(state);
    const saveDisabled = disabled || !["dirty", "incompatible"].includes(state) || state === "incompatible";
    const selected = (value, current) => (value === current ? " selected" : "");
    const checked = (value, current) => (value === current ? " checked" : "");
    const disabledAttribute = disabled ? " disabled" : "";
    const changed = ["dirty", "incompatible"].includes(state) ? '<span class="changed-label">Змінено</span>' : "";

    return `
      <section class="identity-section" aria-labelledby="access-title">
        <div>
          <p class="section-kicker">Google-доступ</p>
          <h2 id="access-title">Власник підтверджений</h2>
          <p>owner@example.com <span class="demo-label">демонстраційна адреса</span></p>
        </div>
        <span class="access-state">Доступ надано</span>
      </section>

      ${valuesRows()}

      <form id="settings-form" novalidate>
        <section class="settings-group" aria-labelledby="models-title">
          <div class="group-heading">
            <div><p class="group-number">1</p><h2 id="models-title">Моделі</h2></div>
            ${changed}
          </div>
          <div class="field-grid">
            <label>
              <span>Codex-агенти</span>
              <select id="codex-model"${disabledAttribute}>
                <option${selected("GPT-5.3-Codex", draft.codex)}>GPT-5.3-Codex</option>
                <option${selected("GPT-5.2-Codex", draft.codex)}>GPT-5.2-Codex</option>
              </select>
              <small>Лише моделі з дозволеного каталогу підписки.</small>
            </label>
            <label>
              <span>Claude Code-критик</span>
              <select id="claude-model" aria-describedby="claude-error"${disabledAttribute}>
                <option${selected("Claude Opus 4.6", draft.claude)}>Claude Opus 4.6</option>
                <option${selected("Claude Sonnet 4.6", draft.claude)}>Claude Sonnet 4.6</option>
              </select>
              <small id="claude-error" class="field-message ${state === "incompatible" ? "field-error" : ""}">
                ${state === "incompatible" ? "Ця модель не підтримує вибране xhigh без зниження." : "Окремий критик залишається обов’язковим у кожному пресеті."}
              </small>
            </label>
          </div>
        </section>

        <section class="settings-group" aria-labelledby="reasoning-title">
          <div class="group-heading">
            <div><p class="group-number">2</p><h2 id="reasoning-title">Глибина міркування</h2></div>
            ${changed}
          </div>
          <fieldset class="choice-row"${disabled ? " disabled" : ""}>
            <legend class="sr-only">Виберіть глибину міркування</legend>
            ${["low", "medium", "high", "xhigh"].map((value) => `
              <label><input type="radio" name="reasoning" value="${value}"${checked(value, draft.reasoning)} /><span>${value}</span></label>
            `).join("")}
          </fieldset>
          <p class="mapping-note">Одне значення перевіряється для обох runtimes. Тихого зниження немає.</p>
        </section>

        <section class="settings-group" aria-labelledby="speed-title">
          <div class="group-heading">
            <div><p class="group-number">3</p><h2 id="speed-title">Швидкість</h2></div>
            ${changed}
          </div>
          <fieldset class="speed-options"${disabled ? " disabled" : ""}>
            <legend class="sr-only">Виберіть швидкість оркестрації</legend>
            <label>
              <input type="radio" name="speed" value="швидко"${checked("швидко", draft.speed)} />
              <span><strong>Швидко</strong><small>Менше додаткових спеціалістів, один обов’язковий цикл критики.</small></span>
            </label>
            <label>
              <input type="radio" name="speed" value="збалансовано"${checked("збалансовано", draft.speed)} />
              <span><strong>Збалансовано</strong><small>Рекомендований баланс темпу, перевірки й повноти.</small></span>
            </label>
            <label>
              <input type="radio" name="speed" value="ретельно"${checked("ретельно", draft.speed)} />
              <span><strong>Ретельно</strong><small>Більше доречних перевірок у межах тієї самої безпеки.</small></span>
            </label>
          </fieldset>
          <p class="mapping-note">Це лише оркестрація агентів — не Fast Mode, priority tier, PAYG або credits.</p>
        </section>

        <section class="validation-status ${status.tone}" role="status" aria-live="polite">
          <strong>${status.title}</strong>
          <p>${status.text}</p>
        </section>

        <div class="settings-actions">
          <button type="submit" class="button primary"${saveDisabled ? " disabled" : ""}>
            ${state === "saving" ? "Зберігаємо…" : "Зберегти весь набір"}
          </button>
          <button type="button" id="reset-button" class="button secondary"${disabledAttribute}>Повернути default</button>
          <button type="button" id="cancel-button" class="button quiet"${disabledAttribute}>Скасувати зміни</button>
        </div>
      </form>`;
  }

  function accessState(state) {
    const map = {
      entry: {
        title: "Захищені налаштування",
        text: "Відкриваємо Google-вхід через Cloudflare Access. Продукт не показує власної форми входу.",
        tone: "neutral",
        action: '<button class="button primary" type="button" data-next="access">Перейти до захищеного входу</button>'
      },
      access: {
        title: "Google-доступ перевіряється",
        text: "Cloudflare Access перевіряє дозволений Google-акаунт. Значення налаштувань ще не завантажуються.",
        tone: "progress",
        action: '<button class="button secondary" type="button" data-next="loaded">Показати успішний результат</button>'
      },
      denied: {
        title: "Доступ відхилено",
        text: "Цей Google-акаунт не має доступу. Жодних значень налаштувань не показано. Іншого способу входу у V1 немає.",
        tone: "error",
        action: '<button class="button secondary" type="button" data-next="entry">Повторити дозволений Google-вхід</button>'
      },
      loading: {
        title: "Завантажуємо узгоджену версію",
        text: "Current, default, active snapshot і capabilities перевіряються як один набір.",
        tone: "progress",
        action: '<button class="button secondary" type="button" data-next="loaded">Показати завантажений стан</button>'
      }
    };
    const item = map[state];
    return `
      <section class="access-boundary ${item.tone}" role="status">
        <span class="access-symbol" aria-hidden="true">${state === "denied" ? "!" : "✓"}</span>
        <div><h2>${item.title}</h2><p>${item.text}</p>${item.action}</div>
      </section>`;
  }

  function bindSettings(state) {
    document.querySelectorAll("[data-next]").forEach((button) => {
      button.addEventListener("click", () => setRoute("settings", button.dataset.next));
    });

    const form = document.getElementById("settings-form");
    if (!form) return;

    const syncDraft = () => {
      draft = {
        codex: document.getElementById("codex-model").value,
        claude: document.getElementById("claude-model").value,
        reasoning: form.elements.reasoning.value,
        speed: form.elements.speed.value
      };
      draftSource = "user";
      const nextState = draft.claude === "Claude Sonnet 4.6" && draft.reasoning === "xhigh"
        ? "incompatible"
        : "dirty";
      setRoute("settings", nextState, true);
    };

    form.addEventListener("change", syncDraft);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (state !== "dirty") return;
      setRoute("settings", "saving", true);
      window.setTimeout(() => {
        currentSettings = { ...draft };
        draftSource = "route";
        setRoute("settings", "saved", true);
      }, 650);
    });

    document.getElementById("cancel-button")?.addEventListener("click", () => {
      draft = { ...currentSettings };
      draftSource = "route";
      setRoute("settings", "loaded");
    });

    document.getElementById("reset-button")?.addEventListener("click", () => {
      resetDialog.showModal();
    });

    if (state === "reset") {
      window.setTimeout(() => resetDialog.showModal(), 0);
    }
  }

  function renderSettings(state) {
    root.replaceChildren(document.getElementById("settings-template").content.cloneNode(true));
    const content = document.getElementById("settings-content");
    if (["entry", "access", "denied", "loading"].includes(state)) {
      content.innerHTML = accessState(state);
      bindSettings(state);
    } else {
      content.innerHTML = settingsForm(state);
      bindSettings(state);
    }
    document.title = `${SETTINGS_STATES.find((item) => item.value === state).label} — Candidate B v2`;
  }

  function render() {
    const route = currentRoute();
    updateReviewControls(route.surface, route.state);
    if (route.surface === "chat") renderChat(route.state);
    else renderSettings(route.state);
  }

  document.querySelectorAll("[data-surface]").forEach((button) => {
    button.addEventListener("click", () => {
      const surface = button.dataset.surface;
      draftSource = "route";
      setRoute(surface, surface === "chat" ? "live" : "loaded");
    });
  });

  stateSelect.addEventListener("change", () => {
    draftSource = "route";
    setRoute(currentRoute().surface, stateSelect.value);
  });

  resetDialog.addEventListener("close", () => {
    if (resetDialog.returnValue === "confirm") {
      currentSettings = { ...DEFAULT_SETTINGS };
      draft = { ...DEFAULT_SETTINGS };
      draftSource = "route";
      setRoute("settings", "reset-done", true);
    }
  });

  window.addEventListener("popstate", render);
  render();
})();
