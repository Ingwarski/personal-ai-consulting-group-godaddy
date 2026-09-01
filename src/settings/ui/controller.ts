import { validateOwnerSettings } from "../catalog.ts";
import type { CapabilityReceipt, OwnerSettings } from "../types.ts";

export type SettingsFormState = Readonly<{
  draft: OwnerSettings;
  isDirty: boolean;
  canSave: boolean;
  validationMessage: string;
}>;

const VALIDATION_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  incompatible_reasoning_depth:
    "Ця глибина міркування не підтверджена для обох вибраних моделей. Значення не буде знижено автоматично.",
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
      canSave: false,
      validationMessage:
        VALIDATION_MESSAGES[validation.code] ??
        "Набір налаштувань не підтверджений. Нічого не буде збережено."
    });
  }

  return Object.freeze({
    draft,
    isDirty,
    canSave: isDirty,
    validationMessage: isDirty
      ? "Увесь набір сумісний. Збереження застосує його лише до наступної сесії."
      : "Набір сумісний. Змін для збереження немає."
  });
}
