# U-04: локальна реалізація Google-входу

Дата: 05.09.2026. Виконавець: direct Codex Phase 3 runner.

Код: `d00f8c9ba064ed6f258b7b7975a98d104b2bac8b`, гілка `codex/audit-remediation-20260905`.
План: `docs/development-plan.md`, SHA-256 `f17072dc044dc12ee20039a78f856801df5121aef19922966fece2eebf17d15a`.
Дозвіл: `forge/implementation-prompt-u04-google-20260905.json`.

## Що виправлено

1. **Google-only identity.** Цільовий GoDaddy runtime більше не читає `SETTINGS_OWNER_PASSWORD`. Перевіряються trusted Google signature, issuer, audience/azp, строки, nonce, verified email і точний дозволений owner; перший сторонній вхід не прив'язує власника. Нового Google-проєкту/клієнта, password fallback або власної MFA не створено.
2. **Повернення в тій самій вкладці.** Host-only Secure/HttpOnly cookies використовують `SameSite=Lax`. Захищені локальні форми надсилаються через `fetch(mode: "cors")`: зберігається справжній Origin, а `Referrer-Policy: no-referrer` не розкриває callback URL. Перевірки Origin, Fetch Metadata та CSRF не послаблено. Причину підтверджує [Fetch Standard §3.2](https://fetch.spec.whatwg.org/#append-a-request-origin-header).
3. **Одноразова durable транзакція.** PKCE verifier шифрується AES-GCM; state/browser/nonce зберігаються як хеші. Claim фіксується до Google exchange, без утримання DB lock під час мережі. Повторні, прострочені, конкурентні й скасовані callbacks не видають додаткових сесій. Є bounded transport/JWKS і durable rate limits.
4. **Сесії та відкликання.** Збережено 30 хв idle, 12 год absolute, ліміт 16 сесій, ротацію при повторному вході. Додано захищені вихід із поточного браузера та відкликання всіх сесій. Google-вхід, вихід і скасування не запускають AI setup.
5. **Дві помилки конкурентного виконання.** Старий процес/callback більше не може повернути попередню configuration generation або стерти нові сесії. Невдалий DB commit більше не залишає процес у стані, що забороняє коректну повторну активацію до restart. Окремий review відтворив обидві помилки до виправлення; regression tests перевіряють виправлення.
6. **Fail-closed помилки.** Некоректна identity та пошкоджений auth JSON відхиляються без raw exception, токенів або ідентифікаційних даних у відповіді. Некоректний Google client secret відхиляється до створення provider.
7. **Незалежна готовність.** Немає каталогу — дозволений login веде до `/operations/runtime`; готовий каталог — до `/settings`. Відсутня web auth configuration не блокує незалежно налаштований Matrix transport. Порядок shutdown не змінено.
8. **Settings.** Logout/revoke та CSRF refresh отримали окремі purpose/session-bound tokens. Виправлено повідомлення початкового незміненого набору: заголовок більше не стверджує, що є готові зміни, коли їх немає. Незалежні групи Codex/Claude/швидкості збережено.

## Перевірка та межі доказів

- Node.js **22.23.2**, macOS arm64: **521/521** автоматизована перевірка, 0 failures/skips; build, TypeScript, environment policy і `git diff --check` — passed.
- Реальний Chromium + локальний HTTPS; Google, AI та MySQL замінено контрольованими fixture adapters. App requests не перехоплювалися: Origin/Fetch Metadata/cookies формував сам браузер. Конкретні спостереження та screenshots — у `output/playwright/u04-google-20260905/`.
- Це supporting evidence для `QA-AUTH-001–008`, `QA-INT-013–015`, `QA-INT-022`, `QA-JRN-005–006`, `QA-DEV-007`, `QA-REG-008`, не автоматичний повний pass кожного check/gate.
- Browser simulation не є реальною Google-авторизацією, Published GoDaddy proof, real MySQL concurrency, представницьким user test або повною перевіркою visual fidelity/WCAG/ASVS.
- Frozen baseline не змінювався. Новий promotion receipt прив'язаний до реального Git diff; він не вигадує відсутнє історичне походження файлів. Повний fidelity gate залишається непідтвердженим.

## Перед реальною перевіркою

Потрібні чинні налаштування **наявного** Google client і GoDaddy Published: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SETTINGS_PUBLIC_ORIGIN`, `SETTINGS_OWNER_GOOGLE_EMAIL`, `SETTINGS_OWNER_ENABLED=true`, окремі `SETTINGS_SESSION_HMAC_KEY`, `SETTINGS_CSRF_HMAC_KEY`, `SETTINGS_OAUTH_TRANSACTION_KEY` та чинний Published DB config. Значення не записуються в Git.

Callback: `SETTINGS_PUBLIC_ORIGIN + /auth/google/callback`. Disable слід поєднувати з ротацією session key; re-enable має залишати новий key, щоб старі сесії не відновилися. Не ротувати спільний чинний CSRF/vault key необдумано: він уже захищає AI credential vault.

Наступний крок у межах U-04 — захищена перевірка deployment/configuration на GoDaddy й фактичний same-tab вхід дозволеним Google-акаунтом, потім required негативні/recovery checks. **U-04 не закрито, наступну Unit не розпочато.** Production secrets, Google Console, GoDaddy deployment, HappyPro, legacy data та stateful Preview цим запуском не змінювалися.
