# Кирилиця та порівняння ключів стану

Дозвіл `yes if it will be normal for cyrillic` зафіксовано у `forge/matrix-state-collation-authorization-20260907.json`. Дозволено лише зміну порівняння `state_namespace` і `state_key` в `personal_consultant_state` з `utf8mb4_unicode_ci` на `utf8mb4_bin`, зі збереженням utf8mb4 та записів.

Першоджерела MySQL, перевірені 2026-09-07:

- https://dev.mysql.com/doc/refman/8.4/en/charset-binary-collations.html — `_bin` є правилом порівняння Unicode-символів, а не перетворенням VARCHAR на двійковий BLOB.
- https://dev.mysql.com/doc/refman/8.4/en/charset-unicode-utf8mb4.html — utf8mb4 підтримує Unicode.
- https://dev.mysql.com/doc/refman/8.4/en/lock-tables.html — ALTER може знімати LOCK TABLES; тому перевірка не вдає транзакційного відкату DDL або гарантованого блокування між двома знімками.

Захищений окремий маршрут `/operations/matrix/state-collation`: GET читає лише визначення колонок, POST вимагає чинного Власника, same-origin та окремого CSRF. Після перевірки точних типів/довжин/utf8mb4/null/default/extra/comment виконується лише канонічний двоколонковий ALTER. Інші визначення блокуються. Preview не доходить до БД.

До й після ALTER MySQL читає тестові Unicode-літерали, перевіряє точний UTF-8 HEX та різницю `Київ`/`київ`; пробні записи не створюються. Хеші попередніх ключів звіряються з наступним набором (додавання ключів іншими поточними операціями допустиме). Первинні ключі/JSON/секрети не повертаються діагностиці; обмежений набір хешів залишається лише в процесі. Перевірка підтверджує збереження ключів, не видається за повний snapshot/backup вмісту. Сам ALTER не змінює JSON чи кодування колонок. Очікування metadata lock обмежено 10 секундами; налаштування з'єднання відновлюється, а за невдалого відновлення з'єднання знищується, не повертається в пул.

Локальна перевірка 2026-09-07T12:51:39Z: SDD before implementation — passed, 13 документів. Build, typecheck, environment policy — passed. Node 22.23.2 — 798 тестів passed, 0 failed. Усі 29 входів нативного release незмінні; нова збірка Rust не потрібна. Live ALTER і готовність Matrix ще не підтверджено.
