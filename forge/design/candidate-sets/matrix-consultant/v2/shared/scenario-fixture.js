(function () {
  "use strict";

  const legacy = window.PC_SCENARIO_V1;
  if (!legacy) {
    throw new Error("Frozen Candidate B fixture must load before Matrix fixture v2.");
  }

  const deepFreeze = (value) => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
      return value;
    }
    Object.getOwnPropertyNames(value).forEach((key) => deepFreeze(value[key]));
    return Object.freeze(value);
  };

  const content = {
    ...legacy.content,
    matrixAccess: {
      id: "matrix-access-boundary",
      role: "Personal Consultant",
      time: "10:01",
      text:
        "Безпечний доступ перевіряється\n\nПеред запуском консиліуму система підтверджує приватну зашифровану кімнату, дозволений акаунт Власника та перевірений пристрій. Якщо хоча б одна умова не підтверджена, агенти не запускаються."
    },
    consent: {
      id: "processing-consent",
      role: "Головний консультант",
      time: "10:01",
      text:
        "Потрібна згода на обробку\n\nДля цієї задачі повідомлення буде розшифроване серверним ботом і передане Cloudflare, Codex та Claude Code. У кімнаті зберігається повна дослівна історія. Продовжити?"
    },
    inputBoundary: {
      id: "input-boundary",
      role: "Головний консультант",
      time: "10:02",
      text:
        "Запит перевірено\n\nТекст підтримується, секретів або документа, що потребує окремого дозволу, не виявлено."
    },
    directAnswer: {
      id: "direct-answer",
      role: "Головний консультант",
      time: "10:03",
      text:
        "Коротка відповідь\n\nПадіння локалізоване після вебінару. Не збільшуйте рекламний бюджет, доки не звірите порівнюваність шести вебінарів і не визначите, на якому кроці лійки продажів виникла найбільша втрата."
    },
    costsResponse: {
      id: "costs-response-v2",
      role: "Personal Consultant",
      time: "10:07",
      text:
        "Витрати\n\nChatGPT/Codex: чинна підписка; місячний платіж — невідомо.\nClaude Code: чинна підписка; місячний платіж — невідомо.\nІнфраструктура: фактична сума — невідомо, production ще не розгорнуто.\nUsage, ліміт і reset: невідомо — провайдер не повернув доступних даних.\n\nAI usage цієї сесії входить у підписки. Окрема вартість токенів або сесії не вигадується."
    },
    providerPreflight: {
      id: "provider-preflight",
      role: "Головний консультант",
      time: "10:02",
      text:
        "Передзапускова перевірка завершена\n\nCodex і Claude Code працюють через дозволені підписки. API-ключі, PAYG та додаткові credits не використовуються."
    },
    providerFailure: {
      id: "provider-failure",
      role: "Головний консультант",
      time: "10:03",
      text:
        "Консиліум не запущено\n\nНе вдалося підтвердити авторизацію Claude Code-критика. Жодного виклику моделі не зроблено; підтверджені повідомлення не змінено.\n\nНаступна дія: завершіть авторизацію у Claude Code поза Matrix, а потім повторіть запит. Не надсилайте сюди token, код або посилання авторизації. API/PAYG fallback не використовується."
    },
    exportResult: {
      id: "archive-export",
      role: "Personal Consultant",
      time: "10:09",
      text:
        "Експорт готовий\n\nПовну сесію експортовано зі збереженням порядку й дослівного змісту. Архівний запис не змінено."
    },
    deleteConfirmation: {
      id: "delete-confirmation",
      role: "Personal Consultant",
      time: "10:10",
      text:
        "Підтвердьте видалення цілої сесії\n\nОкрему репліку видалити не можна. Після повторного підтвердження всю сесію буде остаточно видалено."
    },
    deleteResult: {
      id: "delete-result",
      role: "Personal Consultant",
      time: "10:11",
      text: "Сесію видалено\n\nПовний архівний запис цієї сесії остаточно видалено."
    }
  };

  const chatViews = {
    access: {
      label: "Безпечний доступ",
      covers: ["SS-01", "SS-04", "SS-25", "SS-26", "SS-27"],
      messageIds: ["matrix-access-boundary"]
    },
    consent: {
      label: "Згода на обробку",
      covers: ["SS-02"],
      messageIds: ["processing-consent"]
    },
    input: {
      label: "Перевірка запиту",
      covers: ["SS-03", "SS-05", "SS-06", "SS-07"],
      messageIds: ["owner-request", "input-boundary"]
    },
    accepted: {
      label: "Запит прийнято",
      covers: ["SS-08"],
      messageIds: ["owner-request", "session-acknowledgement"]
    },
    direct: {
      label: "Пряма відповідь",
      covers: ["SS-09"],
      messageIds: ["owner-request", "session-acknowledgement", "direct-answer"]
    },
    roster: {
      label: "Склад консиліуму",
      covers: ["SS-10"],
      messageIds: ["owner-request", "session-acknowledgement", "provider-preflight", "consilium-roster"]
    },
    live: {
      label: "Живий консиліум",
      covers: ["SS-11"],
      messageIds: [
        "owner-request",
        "session-acknowledgement",
        "provider-preflight",
        "consilium-roster",
        "agent-strategy-first-pass",
        "agent-cx-addressed-reply",
        "progress-wait",
        "agent-finance-addressed-reply",
        "agent-critic-review"
      ]
    },
    progress: {
      label: "Видимий поступ",
      covers: ["SS-12"],
      messageIds: ["owner-request", "session-acknowledgement", "consilium-roster", "agent-strategy-first-pass", "progress-wait"]
    },
    costs: {
      label: "Витрати",
      covers: ["SS-13", "SS-14"],
      messageIds: ["owner-costs-command", "costs-response-v2"]
    },
    stopped: {
      label: "Зупинена сесія",
      covers: ["SS-15"],
      messageIds: ["owner-stop-command", "stop-acknowledgement"]
    },
    newTask: {
      label: "Нова задача",
      covers: ["SS-16"],
      messageIds: ["owner-new-task-command", "new-task-acknowledgement"]
    },
    permission: {
      label: "Потрібен дозвіл",
      covers: ["SS-17", "SS-18"],
      messageIds: ["owner-request", "session-acknowledgement", "consilium-roster", "agent-strategy-first-pass", "progress-wait", "continuation-permission"]
    },
    failure: {
      label: "Неповний результат",
      covers: ["SS-19"],
      messageIds: ["owner-request", "session-acknowledgement", "consilium-roster", "agent-strategy-first-pass", "agent-cx-addressed-reply", "failure-partial"]
    },
    final: {
      label: "Фінальна рекомендація",
      covers: ["SS-20", "SS-21", "SS-22", "SS-23", "SS-24"],
      messageIds: [
        "owner-request",
        "session-acknowledgement",
        "consilium-roster",
        "agent-strategy-first-pass",
        "agent-cx-addressed-reply",
        "agent-finance-addressed-reply",
        "agent-critic-review",
        "final-conclusion",
        "final-actions",
        "final-risk-review",
        "final-technical-part",
        "archive-export",
        "delete-confirmation",
        "delete-result"
      ]
    },
    provider: {
      label: "Авторизація провайдера",
      covers: ["SS-28", "SS-29"],
      messageIds: ["owner-request", "session-acknowledgement", "provider-failure"]
    }
  };

  window.PC_MATRIX_SCENARIO_V2 = deepFreeze({
    schemaVersion: "2.0.0",
    locale: "uk-UA",
    fictional: true,
    identifyingData: false,
    sensitiveData: false,
    surface: "SUR-01",
    status: "proposed",
    title: legacy.title,
    agentBodyContract: legacy.agentBodyContract,
    agentMessages: legacy.agentMessages,
    content,
    chatViews
  });
})();
