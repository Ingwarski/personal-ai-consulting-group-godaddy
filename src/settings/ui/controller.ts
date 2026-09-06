import { validateOwnerSettings } from "../catalog.ts";
import type { CapabilityReceipt, OwnerSettings } from "../types.ts";

export type SettingsFormState = Readonly<{
  draft: OwnerSettings;
  isDirty: boolean;
  isCompatible: boolean;
  canSave: boolean;
  validationMessage: string;
}>;

const VALIDATION_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  codex_reasoning_effort_unavailable:
    "Обраний рівень міркування Codex не підтверджений для цієї моделі. Значення не буде змінено автоматично.",
  claude_reasoning_effort_unavailable:
    "Обраний рівень міркування Claude Code не підтверджений для цієї моделі. Значення не буде змінено автоматично.",
  claude_model_unavailable: "Обрана модель Claude Code недоступна. Уподобання збережено; виберіть підтверджену модель або перевірте підключення провайдера.",
  unknown_claude_model: "Модель Claude Code не підтверджена поточним каталогом. Виберіть доступну модель; налаштування Codex-агентів не зміняться.",
  codex_model_unavailable: "Обрана модель Codex недоступна. Збережені значення не змінено; перевірте модель для Codex-агентів і вибраного Критика.",
  unknown_codex_model: "Обрана модель Codex не підтверджена каталогом. Перевірте поля Codex-агентів і вибраного Критика.",
  codex_catalog_unavailable: "Каталог Codex недоступний. Перевірте підключення провайдера; налаштування не збережено.",
  claude_catalog_unavailable: "Каталог Claude Code недоступний. Уподобання збережено; перевірте підключення або виберіть Codex для Критика.",
  critic_settings_required: "Виберіть модель і міркування Критика для обраного провайдера. Уподобання іншого провайдера збережено.",
  catalog_stale: "Каталог моделей потребує оновлення. Нічого не збережено.",
  catalog_untrusted: "Джерело доступних моделей не підтверджене. Нічого не збережено."
});

export function deriveSettingsFormState(
  draft: OwnerSettings,
  current: OwnerSettings,
  receipt: CapabilityReceipt,
  now: Date
): SettingsFormState {
  const isDirty = JSON.stringify(draft) !== JSON.stringify(current);
  const validation = validateOwnerSettings(draft, receipt, now);

  if (!validation.ok) {
    return Object.freeze({
      draft,
      isDirty,
      isCompatible: false,
      canSave: false,
      validationMessage:
        VALIDATION_MESSAGES[validation.code] ??
        "Набір налаштувань не підтверджений. Нічого не буде збережено."
    });
  }

  return Object.freeze({
    draft,
    isDirty,
    isCompatible: true,
    canSave: isDirty,
    validationMessage: isDirty
      ? "Увесь набір сумісний. Збереження застосує його лише до наступної сесії."
      : "Набір сумісний. Змін для збереження немає."
  });
}
