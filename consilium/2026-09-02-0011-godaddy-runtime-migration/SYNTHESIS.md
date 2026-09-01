# Підсумок головного консультанта

## Рішення або висновок

`blocked`: не виконувати wipe HappyPro і не оголошувати готову міграцію. Запитане перенесення всього на GoDaddy є новою реалізацією topology, а не переносом готового застосунку. GoDaddy Published прибирає підтверджений ризик idle sleep, проте не доводить виконання V1 на Node.js 22, необхідну ізоляцію даних, E2EE recovery, OAuth fencing, Google-only Settings або rollback.

## Підтверджені факти

- GoDaddy описує Published як persistent Node.js 22 process з long-lived connections; у поточному app Publish ще не налаштовано.
- Поточний checkout вимагає Node.js `>=24`, не має Node server `start` script і є Cloudflare Worker/DO-oriented: `OWNER_SETTINGS`, `REGISTRAR` та assets присутні, `CAPABILITY_CATALOG` не підключений, R2 adapter окремий.
- Поточна затверджена V1 architecture використовує Cloudflare Access, Durable Objects, Containers і R2; Matrix/OAuth production runtime ще не реалізовано.
- GoDaddy Files є Git-connected і read-only: legacy source не можна видалити з цього UI; можливі лише контрольована зміна/disconnect Git source або окреме видалення GitHub repository.
- Read-only dashboard показав одну hosted database без видимих таблиць. Це не доводить, що вона є runtime database HappyPro або що історичні дані відсутні.
- GoDaddy secrets є variant-specific і їх видалення не відкликає upstream credentials; deployment history не є database/secret rollback.

## Узгоджені позиції

- Усі три спеціалісти погодилися: `replatform first, delete later`.
- До будь-якого write потрібні resource-level mapping старого runtime до database, metadata-only schema/catalog inventory, encrypted backup та verified restore drill.
- Preview isolation має бути provider-side окремою database/schema+credential або окремим app/database; окремі таблиці у shared database не достатні. За відсутності ізоляції Preview дозволений лише для stateless build/UI checks.
- HappyPro GitHub repository лишається immutable rollback artifact до verified restore та published evidence bundle; його retention/deletion — окреме рішення.

## Суттєві розбіжності

Немає. Різні ролі незалежно дійшли одного рішення. Їхня згода не є доказом сама по собі; вона узгоджується з перевіреним checkout і metadata-only dashboard evidence.

## Головний компроміс

Швидко звільнити старий GoDaddy app означає втратити єдиний відомий rollback до появи запускного V1. Зберегти legacy source/data до POC затримує clean cutover, але робить відновлення можливим.

## План дій

| Дія | Відповідальний | Строк | Показник або доказ | Умова перегляду |
|---|---|---|---|---|
| Формалізувати all-GoDaddy replatform і Node 22 runtime boundaries без production writes | Головний консультант | Наступна SDD фаза | Architecture/development-plan change with explicit no-go gates | Якщо GoDaddy cannot prove required isolation/process/storage guarantees |
| Establish legacy app → database mapping and reconcile the empty dashboard table list | Власник + GoDaddy evidence | Before any destructive window | Redacted resource metadata, schema/catalog and privilege inventory | Mapping unavailable or non-exclusive |
| Create encrypted backup and restore it into isolated recovery target | Власник | Before any deletion | Backup hash, structural reconciliation and restore result | Restore mismatch or no isolated target |
| Decide legacy GitHub retention and confirm the precise destructive manifest | Власник | Immediately before wipe | Explicit source/secret/database allowlist and action-time confirmation | Any scope ambiguity |

## Рівень упевненості

Високий для no-go на передчасне очищення та для несумісності поточного Worker topology з прямим GoDaddy deployment. Середній для потенційної придатності GoDaddy після окремої реалізації: persistent Node.js 22 підтверджений, але потрібні security, restart, database isolation, native dependency та credential-boundary докази відсутні.
