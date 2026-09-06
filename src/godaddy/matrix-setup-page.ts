import type { MatrixSetupStatus } from "./matrix-setup-process.ts";

export const MATRIX_SETUP_PAGE = "/operations/matrix";
export const MATRIX_SETUP_ACTION = "/operations/matrix/action";
export const MATRIX_SETUP_ACTIONS = ["prepare", "start_fresh", "resume", "status", "verify_self", "verify_owner", "confirm", "cancel", "finish", "stop"] as const;
export type MatrixSetupAction = typeof MATRIX_SETUP_ACTIONS[number];
export type MatrixSetupView = Readonly<{ state: string; status?: MatrixSetupStatus; error?: string }>;
const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const errorGuidance: Readonly<Record<string, string>> = {
  self_verification_required: "Спочатку завершіть порівняння з наявним довіреним пристроєм бота в Element, потім оновіть стан.",
  peer_not_cross_signed: "Обраний пристрій ще не підписаний його власником. Перевірте його в Element або оберіть інший довірений пристрій.",
  stale_comparison: "Це порівняння вже неактуальне. Оновіть стан і почніть нове порівняння; не підтверджуйте старі числа.",
  no_active_verification: "Активного порівняння немає. Оновіть стан і почніть порівняння з потрібним пристроєм.",
  invalid_verification_target: "Оновіть список пристроїв і оберіть наявний довірений пристрій потрібного облікового запису.",
  verification_already_active: "Спочатку завершіть або скасуйте поточне порівняння, потім почніть інше.",
  verification_peer_changed: "Пристрій іншої сторони змінився. Скасуйте порівняння і перевірте пристрій в Element.",
  transport_unavailable: "Зв’язок із сервером Matrix не підтверджено. Оновіть стан; наявне сховище не потрібно замінювати.",
  operation_timed_out: "Час очікування минув. Оновіть стан перед повторною дією, щоб не дублювати запит.",
  policy_not_ready: "Ще не всі умови Matrix виконано. Перевірте довіру обох облікових записів, ключі підписування та налаштування кімнати.",
  store_or_device_quarantined: "Сховище не відповідає цьому пристрою або не відкривається. Зупиніть налаштування і перевірте збережені параметри; не видаляйте й не замінюйте сховище."
};

/** Reuses the existing owner-action transport; never accepts or displays credentials. */
export function matrixSetupDocument(view: MatrixSetupView, token: string): string {
  const form = (action: MatrixSetupAction, label: string, fields: Record<string, string> = {}): string =>
    `<form action="${MATRIX_SETUP_ACTION}" method="post" data-owner-action><input type="hidden" name="formToken" value="${escape(token)}"><input type="hidden" name="action" value="${action}">${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join("")}<button type="submit">${escape(label)}</button></form>`;
  const yes = (value: boolean): string => value ? "підтверджено" : "ще не підтверджено";
  const status = view.state === "verifying" ? view.status : undefined;
  const flow = status?.verification;
  const stateLabels: Record<string, string> = {
    disabled: "Режим налаштування вимкнено. Консультації не перемикаються автоматично.",
    unprepared: "Файли runtime ще не перевірено на цьому сервері.",
    prepared: "Обидві програми перевірено. Приватні каталоги підготовлено; перевірка HTTP-доступу пройдена.",
    starting: "Програма налаштування запускається. Натисніть «Оновити стан перевірки» за кілька секунд.",
    verifying: "Режим перевірки пристроїв. Консультації не запускаються.",
    complete: "Перевірки Matrix пройдено. Вимкніть MATRIX_SETUP_MODE у Published і опублікуйте знову, щоб запустити консультації.",
    stopped: "Перевірку зупинено. Обліковий запис, пристрої, повідомлення та сховище збережено."
  };
  const devices = status === undefined ? "" : (["self", "owner"] as const).map(target => {
    const title = target === "self" ? "Наявні пристрої облікового запису бота" : "Пристрої вашого облікового запису";
    return `<section><h2>${title}</h2><ul>${status.devices[target].map(device => `<li><p><code>${escape(device.device_id)}</code> — довіра: ${yes(device.verified)}${device.blacklisted ? "; заблокований" : ""}</p><p>Відбиток ключа: <code>${escape(device.ed25519 ?? "ключ відсутній")}</code></p>${device.ed25519 === null || device.deleted || device.blacklisted || !device.cross_signed_by_owner || (target === "self" && device.device_id === status.own_bot_device_id) ? "" : form(target === "self" ? "verify_self" : "verify_owner", "Почати порівняння з цим пристроєм", { deviceId: device.device_id })}</li>`).join("")}</ul></section>`;
  }).join("");
  const comparison = flow == null ? "" : `<section><h2>Порівняння в Element</h2><p>Обліковий запис: ${flow.target === "self" ? "бот" : "Власник"}; пристрій <code>${escape(flow.other_device_id)}</code>.</p><p>Стан: <code>${escape(flow.phase)}</code>.</p>${flow.emojis === null ? "" : `<ol>${flow.emojis.map(emoji => `<li>${escape(emoji.symbol)} ${escape(emoji.description)}</li>`).join("")}</ol>`}${flow.decimals === null ? "" : `<p>Числа: <strong>${flow.decimals.join(" · ")}</strong></p>`}<p>Звірте всі символи або числа з Element на зазначеному пристрої. Не підтверджуйте, якщо вони відрізняються або ви не починали цю перевірку.</p>${flow.comparison_token === null || flow.confirmed ? "" : form("confirm", "Усі символи або числа збігаються", { flowId: flow.flow_id, comparisonToken: flow.comparison_token })}${form("cancel", "Скасувати це порівняння", { flowId: flow.flow_id })}</section>`;
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Підключення Matrix</title><script src="/assets/owner-auth.js" defer></script></head><body><main>
  <h1>Підключення Matrix</h1><p role="alert" tabindex="-1" data-owner-action-status></p><p role="status">${escape(stateLabels[view.state] ?? "Стан не підтверджено.")}</p>
  ${view.error === undefined ? "" : `<p role="alert">Дію не завершено. Секрети й наявні дані не видалялися. Код: <code>${escape(view.error)}</code>. ${escape(errorGuidance[view.error] ?? "Перевірте конфігурацію Published та оновіть стан; не створюйте заміну наявного сховища.")}</p>`}
  <p>Ця сторінка не приймає паролів, токенів або ключів відновлення. Секретні значення вводяться лише в GoDaddy → Published → Секрети.</p>
  ${["unprepared", "stopped", "prepared"].includes(view.state) ? form("prepare", "1. Перевірити програми й приватність каталогів") : ""}
  ${view.state === "prepared" ? `<p>Новий пристрій має бути окремою сесією бота без попередніх ключів шифрування. Порожнє сховище для наявного пристрою не допускається.</p>${form("start_fresh", "2. Підготувати новий окремий пристрій бота")}${form("resume", "Продовжити з наявним сховищем цього пристрою")}` : ""}
  ${["starting", "verifying"].includes(view.state) ? form("status", "Оновити стан перевірки") : ""}
  ${status === undefined ? "" : `<p>Пристрій бота: <code>${escape(status.own_bot_device_id)}</code>. Відбиток: <code>${escape(status.own_bot_ed25519 ?? "очікування ключа")}</code>.</p><p>Довіра до бота: ${yes(status.self_identity_verified)}. Ключі перехресного підписування: ${yes(status.private_cross_signing_ready)}. Довіра до Власника: ${yes(status.owner_identity_verified)}.</p>${comparison}${devices}${form("finish", "Завершити перевірку всіх умов Matrix")}`}
  ${["starting", "verifying"].includes(view.state) ? form("stop", "Зупинити налаштування без видалення даних") : ""}
  <p><a href="/operations/runtime">Повернутися до підписок ШІ</a></p><noscript>Для захищених дій увімкніть JavaScript.</noscript></main></body></html>`;
}
