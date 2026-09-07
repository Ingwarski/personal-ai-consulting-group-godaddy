# Design Brief

## PI-CONSENSUS-20260908 — Персональні ролі, делегування й автономний Matrix

Джерела: однойменні поточні PRD, project-context, canonical-terms, guardrails, user-journey, screen-map і wireframes. Це scoped-корекція DB-D21 за прямим запитом Власника з семи пунктів 08.09.2026, не нове whole-design approval. Не змінює SUR-02, frozen файли або історичні receipts.

### DB-D21 — Рольові заголовки й конструктивний консенсус у Matrix

- Обсяг: SUR-01, MG-04/MG-06/MG-07/MG-08/MG-11/MG-12, варіанти SS-08/SS-10/SS-11/SS-12/SS-13/SS-18/SS-19/SS-20/SS-27. Англійські назви автора й адресата точно за canonical-terms; текст повідомлень — мовою сесії. Службова репліка не маскується під висновок спеціаліста.
- Один Matrix-акаунт бота зберігається. Кольором оформлюється роль усередині body, не нативне ім'я Matrix-відправника. Matrix дозволяє форматований span із data-mx-color/data-mx-bg-color; підтримка й theme behaviour конкретного Element-клієнта потребують перевірки. Джерело: [Matrix message types](https://spec.matrix.org/latest/client-server-api/#mroommessage-msgtypes), переглянуто 08.09.2026. Це можливість формату, не доказ rendering у поточному браузері.
- Для максимум семи учасників однієї сесії використати різні сталі в межах сесії slot-colours: #075985, #7e22ce, #166534, #9a3412, #9f1239, #3730a3, #3f6212, з явним білим тлом #ffffff тільки заголовка. Призначення slots зберігається із roster. У світлій і темній темі перевірити контраст не нижче 4.5:1 і читабельність; якщо клієнт скидає тло/колір або критерій не виконується, прибрати кольори, залишити релевантний emoji та текст. Не розфарбовувати дослівне тіло агента.
- Сталі рольові emoji з canonical-terms присутні також у plain-text body. Колір не є єдиним носієм значення; довгі назви й кирилиця не обрізаються, HH:MM збережено. Не створювати окремі Matrix-акаунти для кольорових sender names.
- Head Consultant публікує спільний вступ один раз; персональні доручення мають різні конкретні результати. Critic-повідомлення й відповіді видимі дослівно й адресовано. Рішення про згоду виводиться лише з підтверджених актуальних погоджень, не з декоративного checkmark або кількості раундів.
- Фінальний консенсус і невирішений результат після ліміту мають явно різні формулювання мовою сесії. Stop, очікування дозволу, тимчасове автоматичне відновлення й справжня втрата довіри зберігають чесні distinct states. Жодна штатна інструкція відновлення не вимагає відкрити Settings для запуску polling.

### Перевірка DB-D21

H1: актуальний стан і очікування; H2: зрозумілі ролі/мова; H3: Stop і явна мовна зміна; H4: сталі назви/emoji; H5: захист від повторів і помилкового консенсусу; H6: видимі адресати/доручення; H7: автоматичне приймання без зайвого входу; H8: один вступ без дублювання; H9: конкретна причина й наступний крок за збою; H10: контекстна допомога для меж особистих ролей. Всі десять потребують implementation review, не позначені пройденими.

Representative task: Власник надсилає багатопрофільну задачу англійською, потім окрему українською, бачить різні доручення, constructive review і правдивий результат із закритими Settings. Відповідальний за спостереження — implementation runner разом із Власником; строк — після реалізації до release acceptance. Поточний стан підготовлено / не виконано; user observation не замінюється unit-тестом або model self-review. Viewports 390/430/768/1280/1440px, світла/темна Element, plain-text fallback; нативні клієнтські відмінності допускаються лише без втрати семантики й читабельності.

Baseline PC-MATRIX-CANDIDATE-B-V2-20260816-R1 і target збережено. Повний render hash повторно обчислено 08.09.2026: 57d103c5ed17bcc9a9d95a58718f83c33b8257229fc825b756367321eaa33199; збігається. DB-D21 змінює тільки названу presentation/поведінкову дельту, не заморожені bytes і не історичну межу доказів. Для цього scope немає prototype-code reuse або нової promotion authority.


- Продукт: `Personal Consultant`
- Версія brief: V1, незмінний approved baseline зі scoped Google/provider overrides
- Статус: approved
- Дата: 06.09.2026
- owner_invocation_id: `design-brief-critic-router-20260906`

## Source References

Поточне узгодження 06.09.2026 стосується лише PI-CRITIC-20260906; його межі визначено в розділі «Маршрутизатор Критика — узгодження 06.09.2026», поточні спожиті фрагменти та hashes — у manifest. Збережені нижче таблиці джерел і датовані спостереження попередніх переглядів є історією, а не новим full-source, runtime або test evidence.

Порядок джерел відповідає `docs/guardrails.md`. Цей brief не змінює продуктову поведінку, перелік станів або структуру wireframes; він визначає presentation- і interaction-контракт для рівно двох підтверджених поверхонь: `SUR-01` і `SUR-02`.

| Джерело | SHA-256 / статус | Спожиті фрагменти |
|---|---|---|
| Успадкований `README.md` | Історичний hash `540a76cb67521d9f3652ec15604f9dc7657f865af639baf13df506f07288c81b`; не перечитано | Початкове позиціонування, не нове джерело поточного узгодження |
| Успадкований `docs/product-idea.md` | Історичний hash `ecc16d6b81c0019f462947b52c013b96636577bd3a14503638102004c7058c8a`; не перечитано | Незмінений контекст попереднього brief; чинні Google/provider-рішення — у валідованих джерелах нижче |
| `docs/prd.md` | `a45aa866bd0591ba778b8ddf1528f9789fd954eef86dd2d8109c8db3f0ed23cc` | JOB/UC; FR/NFR/AC та окремі NFR-016.a–h; Google/session/provider-контракти |
| `docs/project-context.md` | `458da1092f8ac6b10fca6aadc33fab6b9b56aef650fff23e814fe84cb15735a4` | Чинні платформи, дві поверхні, Google/локальна/AI ізоляція, незалежні provider-групи |
| `docs/canonical-terms.md` | `dd4a7ef9ee403f941b649247b14eafff044af717d54fb8731b0d2d26665848d3` | Google-вхід Власника, дозволена ідентичність, локальна сесія, незалежні параметри |
| `docs/guardrails.md` | `6b88dcd634b03203f9f8dde93bd4e4abdba3fe57205b5f3bb776106b39bd999b` | Source/scope/permission межі, Google без own-MFA/password fallback; каталог не блокує вхід |
| `docs/user-journey.md` | `ef058d468fde194ff38efe5d209edbdc3f061d90e4f9602671071c1cc28b2c39` | П'ять JOB, шість UC; UJ 1–10/S1–S5, відмови/виходи/recovery |
| `docs/screen-map.md` | `fe25f595f954cb7b04e369aec65066ec31d7a66a3359953c968343713d41039d` | SUR-01/02, MG/SG, SS-01–46; Google/session/provider-переходи |
| `docs/wireframes.md` | `e065b36af6ba851cb79a2028227b4599129da9c3656dc4be1a913d08cba62ed5` | Незмінені Matrix-структури; Google/local-session і незалежні provider-блоки; Error And Recovery Contract |

## Design Source Material Inventory

### Поточні матеріали

Для DBM-01–DBM-11 і DBM-15–DBM-19: `required_for_generation: true`, `access_status: resolved`, дозволено лише локальне читання; це залежність design-handoff, не дозвіл його запускати. Незмінені upstream-фрагменти повторно використано за перевіреними hashes; нове читання обмежене прив'язкою залежностей та історичними hash-полями. Файли та hashes наведено точно; source-документи й frozen bundle не змінювалися.

| material_id | kind | Шлях | Призначення / source basis | Hash |
|---|---|---|---|---|
| `DBM-01` | canonical_document | `docs/prd.md` | Вимоги/структура відповідного owner за Source References | `a45aa866bd0591ba778b8ddf1528f9789fd954eef86dd2d8109c8db3f0ed23cc` |
| `DBM-02` | canonical_document | `docs/project-context.md` | Вимоги/структура відповідного owner за Source References | `458da1092f8ac6b10fca6aadc33fab6b9b56aef650fff23e814fe84cb15735a4` |
| `DBM-03` | canonical_document | `docs/canonical-terms.md` | Вимоги/структура відповідного owner за Source References | `dd4a7ef9ee403f941b649247b14eafff044af717d54fb8731b0d2d26665848d3` |
| `DBM-04` | canonical_document | `docs/guardrails.md` | Вимоги/структура відповідного owner за Source References | `6b88dcd634b03203f9f8dde93bd4e4abdba3fe57205b5f3bb776106b39bd999b` |
| `DBM-05` | canonical_document | `docs/user-journey.md` | Вимоги/структура відповідного owner за Source References | `ef058d468fde194ff38efe5d209edbdc3f061d90e4f9602671071c1cc28b2c39` |
| `DBM-06` | canonical_document | `docs/screen-map.md` | Вимоги/структура відповідного owner за Source References | `fe25f595f954cb7b04e369aec65066ec31d7a66a3359953c968343713d41039d` |
| `DBM-07` | canonical_document | `docs/wireframes.md` | Вимоги/структура відповідного owner за Source References | `e065b36af6ba851cb79a2028227b4599129da9c3656dc4be1a913d08cba62ed5` |
| `DBM-08` | frozen_html | `forge/design/candidates/candidate-b/v2/index.html` | Незмінний target | `07e3675265e8cadef1e65c132f32e3cbbf4d6537cbfd316ea16a6bacd56f1bd6` |
| `DBM-09` | frozen_script | `forge/design/candidates/candidate-b/v2/app.js` | Demo/provenance, не auth чи model authority | `5446f6a4a987b6d71cd6ddb4fa0a46c409d4c69c0a7083c31f043101ef9bcd95` |
| `DBM-10` | frozen_style | `forge/design/candidates/candidate-b/v2/styles.css` | Незмінна палітра/appearance | `e79543dfcc1cd297e4904caa2944a790d581499025353fffb913f30b4fed7cb8` |
| `DBM-11` | approval_receipt | `forge/design/evidence/candidate-b/v2/approval-receipt.json` | Original approval/normalization | `1b39065b05a2c9b987ab8bf88c118f92e144190769c4ebb9e8a039f21540c300` |
| `DBM-15` | frozen_script | `forge/design/candidate-sets/whatsapp-consultant/v1/shared/scenario-fixture.js` | Пряма залежність `index.html`; лише незмінність fixture, не нова продуктова вимога | `96732f738a41bf1f838736de77a748ef65704d68010553bbf43638f83ddd1af6` |
| `DBM-16` | frozen_script | `forge/design/candidate-sets/matrix-consultant/v2/shared/scenario-fixture.js` | Пряма залежність `index.html`; лише незмінність fixture, не model authority | `0f3959792187148a2e1ae842c738644da7ed60ddc01776948f86914b8fb207e6` |
| `DBM-17` | historical_evidence | `forge/design/evidence/candidate-b/v1/visual-qa.json` | Лише `sourceIntegrity.sharedFixtureSha256` як історичне підтвердження DBM-15; перевірки не повторювалися | `b47e3b312f8f28cd68eadc338f039459813410a9f788025da9d7cff536237f2e` |
| `DBM-18` | historical_evidence | `forge/design/evidence/candidate-b/v2/visual-qa.json` | Лише `matrix_fixture_hash`, `source_tree_hash`, час та межі історичного approval/QA; перевірки не повторювалися | `5935076764338dd01816d3a4b2bbbb7ee770b108eb5f0c561823946487391f76` |
| `DBM-19` | approval_receipt | `forge/design/evidence/candidate-b/v2/approval-render-binding-20260905.json` | Поточна операційна прив'язка залежностей після owner-review; збережені original receipt та обмеження історичного доказу, не нове visual approval | `30d4d7665209f591821ed00bdb551789fb560a4056c50c3aa0ee7a64eade7598` |

- `DBM-12`: official_guidance, https://developers.google.com/identity/branding-guidelines, required_for_generation true, access_status resolved; дозволений режим — публічне read-only відкриття 05.09.2026. Спожито Render HTML Button Element / Download Pre-Approved Brand Icons / Create a custom Sign in with Google Button; сторінка оновлена 07.07.2026. Підстава — P-11/DB-D18, не розширення app-стилю; asset не завантажено.
- `DBM-13`: prior_owned_document, попередній `docs/design-brief.md`, required_for_generation false, access_status resolved; локально спожиті baseline/inventory/provenance, решта правил збережені; hash перед цією міграцією `dd4f41754bf02ca40ef72142a64d8b446876801a5185383b280dfee3dfc4183e`. Історичний hash перед Google/provider-узгодженням: `719a32b4ea4fef9f9eaa0ee08864f00fa57f9637be530e67c404d58d1c2e5608`.
- `DBM-14`: frozen_tree_member, `forge/design/candidates/candidate-b/v2/validate.mjs`, required_for_generation false, access_status not_required для семантики; лише включений до read-only tree hash, не прочитаний як нова вимога й не виконаний; hash `baeafb315ee1891885e00ef81561620b35b29ca27d55646b07012c9820920440`.

### Успадкована історія

Нижченаведені HappyPro, Element/Matrix, accessibility, preview, old-candidate/capture/evidence згадки — успадковані source references original approval, `required_for_generation: false` у цьому узгодженні, `access_status: not_required`; виняток — точно названі hash-поля локальних DBM-17/DBM-18. Нових читань або перевірок зовнішніх матеріалів не виконували; DBM-12 повторно використано з попереднього узгодження. Історичні згадки не підмінюють поточні DBM-джерела.

| Source / version | Спожиті факти | Design inference | Exclusions |
|---|---|---|---|
| Approved Candidate B v2; baseline `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`; original receipt `forge/design/evidence/candidate-b/v2/approval-receipt.json` | Незмінні Matrix-подача, one-page utility, палітра й original approval | `DB-D18`/`DB-D19` замінюють лише відповідні auth/provider наслідки; DB-D17 — історія | Frozen Cloudflare/demo identity, спільний effort і модельні fixtures не доводять поточного auth/model availability; bytes незмінні |
| HappyPro Academy CSS, snapshot перевірки 16.08.2026 | `#071a33`, `#dceeff`, `#2e6fdc`, `#c0265b`, `#f79e1b` для `SUR-02` | Семантична палітра approved Candidate B v2 лишається без зміни design direction | Репозиторій, deployment, credentials і дані HappyPro не є залежністю та не торкаються |
| Element support + Matrix Client-Server API v1.19, approval-pass 15–16.08.2026 | Native message/composer/reply/attachment affordances; `body`/`formatted_body`; client rendering variance | `SUR-01` успадковує Element/Matrix; продукт володіє лише content choreography і state meaning | Custom Element chrome, browser chat, власні bubble/composer/theme |
| WCAG 2.2 + Apple/Android accessibility guidance, approval-pass 15–16.08.2026 | Text alternatives, focus, semantics, scaling, screen-reader and target-size considerations | WCAG 2.2 AA є floor для product-authored `SUR-02`; platform behavior потребує окремого evidence | Неперевірена заява про conformance нативного Element chrome |

Платформні джерела, спожиті під час original approval pass 15–16.08.2026:

- [HappyPro Academy CSS](https://happypro.academy/styles.css?v=20260814-september-cohort-v23) — історично спожите джерело палітри `#071a33`, `#dceeff`, `#2e6fdc`, `#c0265b` і `#f79e1b` для approved `SUR-02`, перевірене 16.08.2026; це не дозвіл торкатися репозиторію, deployment, credentials або даних HappyPro.
- [Element Support: The Middle Panel](https://docs.element.io/latest/element-support/quick-start-guide/the-middle-panel/) — офіційна довідка про нативні message, composer, formatting, reply, attachment і thread affordances Element.
- [Matrix Client-Server API v1.19](https://spec.matrix.org/v1.19/client-server-api/) — офіційний контракт `body`/`formatted_body`, rich replies і client-specific fallback/rendering.
- [Element Download](https://element.io/download) — офіційне джерело підтримуваних desktop і mobile клієнтів.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) — базова accessibility-ціль для змісту й майбутніх design-evidence артефактів.
- [Apple Human Interface Guidelines: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility/) і [Android Developers: Make apps more accessible](https://developer.android.com/guide/topics/ui/accessibility/apps) — системне масштабування тексту, screen-reader use, контраст і нативні елементи керування мають перевірятися на відповідних клієнтах.

`consilium/live/styles.css` було оглянуто в історичному pass, не цього разу. Його кастомні браузерні стилі не є джерелом V1; запис зберігає попередню scope-межу.

## Design Brief

`Personal Consultant` має відчуватися як приватна, спокійна й доказова ділова розмова в нативній E2EE Element/Matrix-кімнаті та як стримана безпечна utility-поверхня, коли Власник відкриває `Налаштування власника`. Спільний принцип — deliberate restraint: виразність витрачається на рішення, критичну межу, owner access/session status, сумісність, фактичний статус і наступну дію, а не на декоративний бренд-шар.

`SUR-01` успадковує Element і володіє лише content choreography. `SUR-02` — одна utility-сторінка з явною Google-дією, поверненням у тій самій вкладці, окремим локальним доступом і незалежними provider-параметрами за wireframes. Парольної форми, власної MFA застосунку, fallback, іншого IdP або display email немає. Вхід/відмова/локальний вихід/повторний вхід не змінюють AI OAuth; локальний вихід не означає Google logout. Каталог та AI-підписки не блокують сам Google-вхід.

- порядку повідомлень і змістових зон, уже визначених `docs/wireframes.md`;
- читабельного нативного форматування Element/Matrix і нативних Matrix replies;
- послідовного role/time identity;
- текстових патернів дозволу, межі даних, поступу, збою й Фінальної рекомендації;
- авторської дисципліни для довгих повідомлень до моменту їх підтвердженої реєстрації.

Після реєстрації повне тіло Підтвердженої репліки агента недоторканне. Design-система не скорочує, не «очищує», не згортає й не переказує його.

## Decision Log

| ID | Рішення | Статус і підстава |
|---|---|---|
| `DB-D01` | Успадкувати нативну UI-систему Element на Mac, iPhone, Samsung Flip7/Android і Windows PC | Confirmed: `SUR-01`, `NFR-013`, Design Authority Rules |
| `DB-D02` | Не створювати власні кольори, шрифти, бульбашки, elevation, composer, delivery indicators, quick replies, buttons або navigation | Confirmed: screen-map і wireframes; платформа володіє chrome |
| `DB-D03` | Використати deliberate restraint як спільний принцип: виразність належить змістовим сигналам, а не декоративному оформленню | Reversible source-grounded synthesis із практичного результату, конфіденційності, доказовості й низького технічного шуму |
| `DB-D04` | Role/time identity має вигляд `Конкретна предметна роль · HH:MM` перед повним тілом репліки | Confirmed: `FR-015`–`FR-019`, `MG-07`, Atomic agent-reply pattern |
| `DB-D05` | Критичне значення ніколи не передається лише кольором, emoji або рухом | Confirmed accessibility floor; нативні клієнти можуть змінювати appearance |
| `DB-D06` | Candidate B «Дослівний консиліум» є обраним і затвердженим цілісним напрямом у revision `v2` | Confirmed: Власник явно погодив інтегрований Candidate B v2 для переходу до розробки 16.08.2026; baseline фіксується нижче |
| `DB-D07` | Не успадковувати `consilium/live/styles.css` | Confirmed scope cut: це browser evidence, а не продуктова поверхня V1 |
| `DB-D08` | WCAG 2.2 AA є floor для product-authored content і prototype evidence; conformance нативного Element chrome не приписується продукту | Confirmed boundary: content контролює продукт, chrome — Element/ОС |
| `DB-D09` | Попередні WhatsApp-кандидати `A/B/C v1` та їх evidence незмінні, але superseded і не є поточним visual target | Confirmed: Design Authority Rules; актуальний target — Matrix-native Candidate B |
| `DB-D10` | `SS-28` є невидимою передумовою кожного model call і запуску залежного агента: за успіху жодного product-authored loading/login status не додається | Confirmed: screen-map і wireframes; preflight не створює нової surface або проміжного performance theater |
| `DB-D11` | `SS-29` показує в тій самій кімнаті лише безпечну категорію збою, відомий reset і позачатову наступну дію; credential, URL або code fields та API/PAYG fallback відсутні | Confirmed: PRD §3.5, canonical terms, screen-map `SS-29` |
| `DB-D12` | `Витрати` показують налаштовані місячні платежі за AI-підписки, фактичну інфраструктуру й доступний provider usage/limit/reset; usage сесії входить у підписку | Confirmed: `MG-09`, `SS-14`, canonical `Облік витрат`; per-session token charge не вигадується |
| `DB-D13` | `SUR-02` є єдиним browser-винятком: secure system-like one-page utility, а не чат, dashboard чи admin console | Confirmed: screen-map, wireframes, guardrails |
| `DB-D14` | Settings мають рівно три групи та одну atomic action hierarchy; active-session snapshot не мутує | Confirmed: `SG-02`–`SG-05`, `SS-35`–`SS-44` |
| `DB-D15` | Cloudflare Access володіє Google sign-in presentation; product-owned design починається після grant і обмежується safe status result за deny | Historical superseded: рішення від 16.08.2026 збережене для provenance, але спосіб access скасовано рішенням Власника від 04.09.2026 |
| `DB-D16` | `SUR-02` бере семантичну палітру з HappyPro Academy: navy, blue, pale blue, berry та amber focus | Confirmed: явне доручення Власника; значення з актуального CSS `happypro.academy` від 16.08.2026. `SUR-01` лишається нативною Element-поверхнею |
| `DB-D17` | `SUR-02` використовує product-owned локальний owner-password challenge і захищену owner session на штатному GoDaddy hostname; `SG-01`, `SS-30`–`SS-33` і access-частина `SS-45` замінюють Google/Cloudflare copy/state semantics без зміни approved layout | Historical superseded — замінено DB-D18 05.09.2026; початковий scoped override від 04.09.2026: `docs/product-idea.md`, `docs/guardrails.md`, `docs/user-journey.md`, `docs/screen-map.md`, `docs/wireframes.md`; не є новим whole-design direction і не змінює Candidate B v2 provenance |
| `DB-D18` | Google-only вхід у тій самій вкладці; окрема локальна сесія, cancel/retry/denial, видимий локальний вихід, expiry/revocation; без власної MFA застосунку й резервного пароля; Google-brand оформлення лише кнопки P-11 | Підтверджене `PI-AUTH-20260905`, `UC-003`, `FR-038(a–d)`, `FR-039(a–c)`, `NFR-016.a`–`NFR-016.h`, UJ S1/S5, SM SS-30–33/SS-45 і wireframes; scoped override замість DB-D17, не нове whole-design approval |
| `DB-D19` | Незалежні модель/міркування в групах Codex-агенти й Claude Code-критик; окрема Швидкість консиліуму; точні підтверджені версії й порядок Claude; каталог не блокує Google-вхід | Підтверджені `UC-004`, `FR-040`–`FR-046`, UJ S2–S5, SM SG-02–05/SS-34–46 та wireframes; уточнює DB-D14 і замінює shared-effort demo, не палітру/Matrix/original approval |

| `DB-D20` | У групі Критик явний Claude Code/Codex selector, окремі model/effort і доступне відновлення без неактивного Claude; Codex-агенти незмінні | Прямий `PI-CRITIC-20260906`, `UC-001/UC-004`, `FR-010/040–046`, Journey S2–S5, screen-map/wireframes; scoped refinement DB-D19, не новий дизайн або deployment |

## Audience And Context

Єдиний користувач V1 — Власник. Він працює з практичними бізнесовими, фінансовими, управлінськими, продуктовими, маркетинговими й продажними задачами та переходить між Mac, iPhone, Samsung Flip7/Android і Windows PC. Повсякденний досвід залишається в Element; responsive browser потрібен лише для рідкісної зміни налаштувань і не вимагає розуміння внутрішньої оркестрації.

Інформаційна щільність нерівномірна за природою продукту: системні статуси й Фінальна рекомендація мають бути короткими, а Підтверджена репліка агента може бути довгою і завжди залишається повною. Design-контракт не розв'язує цю напругу приховуванням; він робить довгий потік сканованим через стабільну роль, порядок, абзаци, списки та сильний початок повідомлення.

## Product Experience Goal

Власник у будь-якому підтримуваному клієнті має швидко відповісти на три питання:

1. Що зараз відбувається і чи потрібна від мене дія?
2. Хто саме говорить і наскільки твердження підтверджене?
3. Яке рішення або наступна перевірка випливає з роботи?

Критерій досвіду: навіть якщо нативне форматування, колір або ширина бульбашки відрізняються між клієнтами, хронологія, роль, статус, критична межа й наступна дія залишаються однозначними в самому тексті.

Для `SUR-02` Власник має так само швидко зрозуміти: хто має доступ; що є current, default і effective; чи повний набір сумісний; чи atomic save/reset фактично завершено; чому зміни не торкаються Активної сесії.

## Concern Scan

| Concern | Design response | Межа |
|---|---|---|
| Accessibility | Plain-text meaning, нативні system fonts, семантичні абзаци й списки, явні labels, screen-reader і text-scale verification | Продукт не перевизначає доступність Element chrome |
| Platform conventions | Один нативний чат, штатний composer, бульбашки й delivery/offline indicators | Жодного custom chrome або паралельної навігації |
| Brand voice | Природна українська, професійно, спокійно, конкретно, без канцеляризмів і мотиваційного шуму | Адаптація до мови Власника зберігає канонічні команди й терміни |
| High-risk language | Межа, наслідок, підтверджене, невідоме й потрібний дозвіл називаються прямо | Не підміняти юриста, податкового консультанта, лікаря чи іншого профільного фахівця |
| Motion | Product-authored motion відсутній; зміна стану завжди зрозуміла з тексту | Нативна анімація клієнта не є design guarantee |
| Internationalization | Не використовувати ручне вирівнювання, ASCII-таблиці або зміст, що залежить від довжини українського рядка | V1 відповідає природною українською й адаптується до мови Власника |
| Dark mode / contrast | Успадкувати поточні теми Element; prototype evidence перевіряти в light/dark і increased-contrast contexts, де доступно | Не hard-code кольори Element |
| Offline / delivery | Покладатися лише на нативні delivery/offline indicators; не заявляти отримання за presentation-ознакою | Точна delivery-механіка належить архітектурі й клієнту |
| Content density | Короткі product-authored blocks; повні agent replies; один змістовий рівень на абзац; до трьох фінальних дій | Немає summary/accordion/read-more, доданого продуктом |
| Input modalities | Текст, зображення й PDF через штатний composer; команди вводяться текстом | Voice, video та custom controls поза V1 |
| Same-chat delivery | Нова репліка з'являється в тій самій приватній розмові | Окремої продуктової поверхні немає |
| Settings security utility | Одна сторінка, явний owner access/session status, три групи, validation і atomic actions | Не чат, dashboard, sidebar, cards-in-cards чи admin console |
| Settings access | Явна Google-дія → провайдер у тій самій вкладці → безпечний результат і окрема локальна сесія | Скасування, повтор, локальний вихід/expiry/revocation зрозумілі; немає парольної форми, own-MFA/fallback, display email чи AI credentials |
| Settings reversibility | Current/default/effective розрізнені текстом; save/reset атомарні; active snapshot незмінний | Без partial success, silent downgrade, arbitrary model text або live mutation |
| Subscription access | Успішний `SS-28` невидимий; `SS-29` — короткий same-room status із безпечною категорією причини та позачатовою наступною дією | У Matrix немає OAuth token, `auth.json`, setup-token, reauth URL/code, credential field, login screen або API/PAYG fallback |
| Cost transparency | `Витрати` відділяють налаштовані щомісячні AI-підписки, фактичну інфраструктуру та доступний status квоти/reset | Usage сесії позначається як включене в підписку; недоступне — `невідомо`; не вигадувати per-session charge |
| AI control and reversibility | Явні дозволи, `Стоп`, `Нова задача`, `Витрати`, чесний failure-state, незмінна репліка й нове повідомлення для виправлення | Автоматична зовнішня дія без окремого дозволу заборонена |

## Design Spine

### Brand And Style

Спільний стиль — `ділова ясність без нового інтерфейсу`. Signature restraint: кожне product-authored повідомлення має один домінантний змістовий сигнал на початку; усе інше підтримує його. Для агентської репліки цим сигналом є role/time identity та перша змістова теза, яку агент сформулював до надсилання.

Boldness витрачається на:

- конкретну межу або потрібне рішення Власника;
- конкретну предметну роль;
- головний висновок, фактичний статус або збій;
- назву секції у Фінальній рекомендації.

Boldness свідомо не витрачається на декоративні заголовки, великий набір emoji, брендові слогани, псевдокартки або постійне виділення кожного абзацу.

#### Selected Prototype Direction

`B — Дослівний консиліум` є обраним content/UX-напрямом. Його signature element — стабільний ритм `конкретна роль · HH:MM`, нативна Matrix reply relationship для адресованості та повне незмінне тіло кожної фактично надісланої репліки в канонічному порядку. Виразність витрачається на provenance, межі між репліками, критичні стани й фінальний синтез; нативний Element chrome лишається стриманим і незмінним.

Інтегрована revision `Candidate B v2` покриває обидві поверхні: Matrix-native chat evidence для `SUR-01` та secure utility evidence для `SUR-02`, включно з `MG-01`–`MG-13`, `SG-01`–`SG-05` і `SS-01`–`SS-46`. Власник затвердив її цілісно для переходу до розробки. Старі candidate prototypes не покривають `SUR-02` і не є Approved Visual Baseline; попередні WhatsApp `A/B/C v1` лишаються immutable superseded historical evidence.

### Colors

Кольори `SUR-01` повністю визначає активний клієнт Element через `surface.chat`, `surface.message`, `color.content`, `color.secondary` і `color.status`. `SUR-02` використовує семантичну палітру HappyPro Academy: navy `#071a33`, blue `#2e6fdc`, pale blue `#dceeff`, berry `#c0265b` і amber focus `#f79e1b`. Кожне status-значення дублюється текстом, а не лише кольором.

### Typography

Шрифт, базовий розмір, line-height і масштабування `SUR-01` визначає Element через `type.body`. `SUR-02` використовує системний UI stack через `type.ui`, `type.label` і `type.meta`; довгі model names, errors і mapping text переносяться без скорочення. Ієрархія чату використовує `type.heading`, `type.role-time`, `type.secondary` і `type.code`:

- один короткий `type.heading` на початку product-authored block, якщо без нього важко знайти рішення або межу;
- `type.role-time` перед кожною Підтвердженою реплікою агента;
- `type.secondary` лише для справді підтримувального контексту, не для критичної умови;
- `type.code` тільки для точних команд, ідентифікаторів, короткого inline code або цілісної Технічної частини.

Верхній регістр, decorative Unicode, кілька стилів одночасно й emoji-типографіка не утворюють hierarchy.

### Layout And Spacing

`priority.p0` завжди передує `priority.p1`, а `priority.p2` і `priority.p3` не можуть відсунути критичну межу або рішення нижче. Усередині повідомлення використовуються `space.section` і `space.list`; між самодостатніми частинами Фінальної рекомендації — `space.series`.

Ручні відступи пробілами, центрування, горизонтальні колонки, ASCII-діаграми й decorative separators не використовуються. Довжина рядка, ширина бульбашки, зовнішні відступи та scroll належать Element.

`SUR-02` зберігає односторінкову utility-ієрархію wireframes: Google-дія або локальний статус/вихід → значення → незалежні блоки Codex-агентів і Критика → швидкість → перевірка → атомарні дії. Модель, її міркування й помилка лишаються поруч; `space.settings-section` зберігає ритм без nested cards/sidebar/dashboard.

### Elevation And Depth

`SUR-01` використовує лише `elevation.message`, успадкований від Element. `SUR-02` використовує `elevation.utility`: стриману межу сторінки без decorative shadows, floating controls або card-in-card hierarchy.

### Shapes

`SUR-01` успадковує `shape.message`. `SUR-02` використовує `shape.control` і `shape.utility` системно й без декоративних pills, badges або вкладених cards.

### Component Appearance

Нижче `P-01`–`P-10` — content patterns усередині нативної розмови; `P-11`–`P-15` — appearance patterns вузької settings-поверхні.

| ID | Pattern | Appearance principle |
|---|---|---|
| `P-01` | Native message block | `surface.message` + `type.body`; один signal-first початок, далі `space.section` і `space.list` за потреби |
| `P-02` | Role-time identity line | `type.role-time` без avatar, технічного ID, номера повідомлення або секунд; безпосередньо перед тілом тієї самої репліки |
| `P-03` | Permission / data-boundary message | `priority.p0` + `type.heading`; межа, причина, наслідок без дозволу та прохання про явне рішення читаються як один block |
| `P-04` | Progress / failure message | `priority.p1` для фактичного поступу або `priority.p0` для збою; статус названо текстом, не лише emoji чи кольором |
| `P-05` | Long verbatim agent reply | `P-02` + повне `type.body`; семантичні абзаци й списки зберігаються, product-added collapse відсутній |
| `P-06` | Final recommendation series | Окремі `P-01` у порядку рішення → до трьох дій → ризик/припущення/умова перегляду; `space.series` між ними |
| `P-07` | Technical part | Окремий `P-01` із label `Технічна частина`; `type.code` лише там, де він покращує точність |
| `P-08` | Native attachment and composer | Повністю нативні preview й composer; product-owned overlay, field, selector або button відсутні |
| `P-09` | Same-chat delivery | Нова репліка з'являється в `SUR-01`; окремий продуктовий інтерфейс не створюється |
| `P-10` | Session / archive control result | `P-01` з фактичним результатом, наслідком для Сесії або Архіву сесій і наступною допустимою дією |
| `P-11` | Google-дія й локальний доступ | Зона використовує `surface.section` / `type.meta`; Google-кнопка — локальний branded виняток нижче. Після входу — безпечний локальний статус, вихід/припинення своїх сесій, без email або credentials |
| `P-12` | Settings group | Рівно Codex-агенти, Критик і Швидкість консиліуму; у Критика selector провайдера перед незалежними model/effort вибраної гілки разом із label/status. Один заголовок на групу, чинна палітра, без nested cards |
| `P-13` | Current/default/effective distinction | Три текстово підписані трактування з різною вагою, але без color-only meaning |
| `P-14` | Compatibility / operation status | `type.label` + явний status text; inline error біля джерела і один page-level atomic result |
| `P-15` | Atomic action area | Одна головна Save-дія, окрема Reset-дія з підтвердженням і помітне `focus.ring`; success/failure належить усьому набору |

#### Google-кнопка в P-11

[Офіційні правила Google](https://developers.google.com/identity/branding-guidelines) дозволяють HTML/custom-кнопку з актуальним стандартним кольоровим `G` та локалізованою дією `Увійти через Google`. Asset береться лише з офіційного Google-набору, не малюється заново. Розмір/пропорції, текст, колір, Google Sans Medium та відступи виконують поточні правила саме кнопки; asset/font provenance фіксується перед дозволеним включенням у майбутній frozen bundle. Ця документна перевірка не означає завантаженого asset. Google-шрифт і палітра не поширюються на весь застосунок; правило не додає SDK, нового протоколу або реального auth до frozen demo.

### Visual Do's And Don'ts

Do:

- починати повідомлення з рішення, межі, ролі або фактичного статусу;
- використовувати короткі абзаци, нативні списки й selective emphasis;
- робити кожне повідомлення Фінальної рекомендації самодостатнім;
- зберігати зрозумілий plain-text fallback, якщо format markers не відобразилися;
- відділяти роль і `HH:MM` від body одним стабільним патерном;
- для нового agent-authored content віддавати перевагу списку над широкою таблицею.
- в settings завжди називати owner access/session status, current/default/effective, validation і atomic result текстом;
- тримати рівно три settings-групи в одному послідовному потоці;
- показувати явний focus і помилку біля пов'язаного control.

Don't:

- проєктувати власний Element header, bubble, composer, menu або theme;
- використовувати browser-preview, `consilium/live/styles.css` або dashboard як design target;
- приховувати довгу репліку за accordion, summary, link або product-added `read more`;
- перетворювати фактично надіслану таблицю чи code block після реєстрації: повне тіло зберігається дослівно;
- передавати critical meaning лише червоним/зеленим, emoji або анімацією;
- використовувати декоративні gradients, blobs, cards, ASCII-art або ручне вирівнювання пробілами.
- перетворювати settings на dashboard/sidebar, cards-in-cards або advanced/admin console;
- додавати password/OTP, резервний вхід, інший IdP, AI credential fields, free-text model slug, спільну шкалу міркування, Fast/PAYG/credits, sound/motion чи per-agent/per-unit controls;
- переносити Cloudflare-посередництво, demo email або непідтверджені моделі/рівні frozen prototype до чинної поведінки;
- розширювати Google-дію до реєстрації, іншої ідентичності, власної MFA чи відновлення пароля застосунку.

### Design Tokens

| Token | Value / contract |
|---|---|
| `surface.chat` | Поточна нативна E2EE Matrix-кімната в Element у відповідному клієнті й темі |
| `surface.message` | Нативна message presentation Element; продукт не перевизначає її |
| `surface.settings` | HappyPro pale blue `#dceeff` як одна product-owned responsive utility-поверхня без app-shell, sidebar чи dashboard |
| `surface.section` | White `#ffffff` або soft blue `#f4f8ff` зона з одним семантичним заголовком; не nested card |
| `color.content` | Нативний primary text color активного клієнта й теми |
| `color.secondary` | Нативний secondary text treatment; не використовується для critical meaning |
| `color.status` | Нативна platform treatment, якщо вона існує; значення завжди дублюється явним текстом |
| `color.border` | HappyPro-derived blue-grey `#b9cceb` з контрастом не нижче WCAG 2.2 AA для його семантичної ролі |
| `color.focus` | HappyPro amber `#f79e1b`; помітний indicator, що не залежить від кольору control |
| `color.danger` | HappyPro berry-dark `#9f1239` для error/reset boundary; завжди з текстовим label і наслідком |
| `color.success` | Confirmed-result green `#146c43`; не єдина ознака успіху |
| `type.body` | Нативна системна типографіка Element, regular, з user-controlled scaling |
| `type.heading` | Нативне selective bold для одного головного label або signal-line |
| `type.role-time` | `Конкретна предметна роль` selective bold + роздільник `·` + час `HH:MM` regular |
| `type.secondary` | Нативна italic або regular secondary фраза; лише для некритичного контексту |
| `type.code` | Нативний inline/monospace treatment Element/Matrix для точного технічного змісту |
| `type.ui` | Системний UI stack для settings з підтримкою 200% text zoom і без залежності від завантаження web-font |
| `type.label` | Явний persistent label для control/status; placeholder не замінює label |
| `type.meta` | Підтримувальний текст для identity, current/default/effective і mapping; критичне значення не покладається лише на secondary styling |
| `space.section` | Один порожній рядок між смисловими секціями одного повідомлення |
| `space.list` | Один окремий рядок на пункт без декоративних порожніх рядків між пунктами |
| `space.series` | Нативна межа між двома самодостатніми повідомленнями |
| `space.settings-section` | Послідовний вертикальний ритм між identity, трьома групами, status і actions; не dashboard grid |
| `shape.message` | Нативна форма повідомлення Element |
| `shape.control` | Послідовна system-like форма input/select/button з видимою межею й focus |
| `shape.utility` | Стримана межа одної settings-поверхні; без decorative panel nesting |
| `elevation.message` | Нативна depth/separation behavior Element |
| `elevation.utility` | Без decorative shadow; рівні відділяються border/spacing/heading |
| `motion.message` | Лише нативна поява/доставка/відкриття; product-authored animation відсутня |
| `motion.settings` | Жодної product-authored animation; стан завжди зрозумілий з тексту й status region |
| `focus.ring` | Неперервний видимий контур для клавіатурного focus, що не закриває контент |
| `priority.p0` | Явний текстовий статус або межа на початку + `type.heading`; потребує рішення чи негайної уваги |
| `priority.p1` | Основний результат або фактичний робочий зміст; перша змістова теза перед деталями |
| `priority.p2` | Підстава, причина, контекст або межа впевненості після основного сигналу |
| `priority.p3` | Попередня хронологія або некритичний контекст без доданого акценту |

## Experience Spine

### Foundation

Головний форм-фактор — асинхронна, а під час Консиліуму жива нативна розмова в Element. Головна primitive там — нове текстове повідомлення у штатному composer. Вузький допоміжний форм-фактор — responsive web settings з keyboard-accessible controls, атомарними діями й чітким status feedback. Жодна поверхня не залежить від drag, hover-only meaning або decorative motion.

Основний interaction feel — `visible progress without performance theater`: підтвердження, фактична репліка, пояснення очікування, збій або запит дозволу з'являються як зміст, а не як декоративна анімація.

### Information Architecture Implications

- `SUR-01` має одну хронологію; новий product-owned navigation layer відсутній.
- `MG-01`–`MG-13` зберігають порядок і content hierarchy з wireframes.
- `P-03` і critical `P-04` переривають звичайний потік лише для відповідної межі.
- `P-06` завершує роботу кількома короткими повідомленнями, але не замінює й не редагує попередні `P-05`.
- `Стоп`, `Нова задача` й `Витрати` читаються як точні команди, а не як navigation labels.
- Нативна історія може бути довгою; поточний стан знаходиться за останнім однозначним signal-first block, а не через custom sticky header.
- `SUR-02` не має спільного app-shell з Element, sidebar або dashboard IA; це одна послідовна settings-сторінка.
- Ієрархія `SUR-02` відповідає wireframes та `DB-D18`/`DB-D19`; локальний вихід не змішується з поверненням до Element.
- Google-сесія, локальний доступ та AI Subscription OAuth незалежні. Події входу не змінюють AI credentials; окремо дозволене захищене runtime-налаштування підписок не заборонене цією ізоляцією.

### Voice And Tone

- Мова за замовчуванням — природна українська з адаптацією до мови Власника.
- Звертання — `ви`; нормативна роль — `Власник`.
- Формулювання повні, прямі й affirmative; без канцеляризмів, англійських кальок, мотиваційного шуму та псевдовпевненості.
- Канонічний термін — `лійка продажів`; точні команди — `Стоп`, `Нова задача`, `Витрати`.
- Факт, інформація Власника, припущення, професійне судження й невідоме відділяються явними словами, коли це суттєво.
- Permission і failure copy спочатку називає стан і наслідок, потім пояснює; не звинувачує Власника й не приховує невідоме.
- Роль у `P-02` конкретна предметна, наприклад `Фінансовий консультант`; технічне слово `субагент` не показується.

### Component Behavior

| ID | Pattern | Behavior principle |
|---|---|---|
| `P-01` | Native message block | Додається в канонічному порядку й залишається самодостатнім після нативного line-wrap; не відкриває іншої поверхні |
| `P-02` | Role-time identity line | Належить лише наступному повному body; виправлення role/body додається новою реплікою, не переписує попередню |
| `P-03` | Permission / data-boundary message | Зупиняє лише названу дію; приймає явну згоду або відмову; не переносить дозвіл на іншу межу |
| `P-04` | Progress / failure message | Progress повертає до активного потоку; failure називає наслідок і лише безпечну підтверджену recovery-дію. Для `SS-29` не містить credential, token, `auth.json`, setup-token, reauth URL/code або API/PAYG fallback |
| `P-05` | Long verbatim agent reply | Публікується повністю; не ділиться, не переказується й не змінюється після підтвердженої реєстрації; client-native collapse не замінюється product collapse |
| `P-06` | Final recommendation series | Завершує стабілізовану роботу; зовнішня або високоризикова дія після рекомендації окремо переходить у `P-03` |
| `P-07` | Technical part | Існує лише за потреби й переноситься цілком; не розсипається на фрагменти між іншими повідомленнями |
| `P-08` | Native attachment and composer | Приймає лише підтверджені V1 inputs; unsupported input переходить у `P-03`/`P-04` без custom control |
| `P-09` | Same-chat delivery | Додає нову видиму репліку до `SUR-01` без створення іншої продуктової поверхні |
| `P-10` | Session / archive control result | Показує фактичний наслідок команди чи архівної дії; для `Витрати` розділяє налаштовані місячні AI-підписки, фактичну інфраструктуру й доступний usage/limit/reset без per-session token charge; не створює окремий dashboard, archive-browser або editable transcript |
| `P-11` | Google-дія й локальний доступ | Явна свіжа транзакція і same-tab повернення за `NFR-016.a`–`NFR-016.c`; кожний захищений запит перевіряється сервером. Видимий вихід/припинення своїх сесій, expiry та відкликання діють і після рестарту; local logout не є Google logout, відновлення не обходить `NFR-016.d`–`NFR-016.h` |
| `P-12` | Settings group | Незалежні підтверджені модель/міркування; точні версії, Claude `Opus → Sonnet → Haiku`, новіші версії сімейства першими. `За замовчуванням моделі` не передає явного effort; зміна одного провайдера не змінює іншого (`FR-040`–`FR-043`) |
| `P-13` | Current/default/effective distinction | Оновлює current лише після atomic success; default не мутується; active effective snapshot залишається незмінним |
| `P-14` | Compatibility / operation status | Inline error пов'язаний з полем, page-level status оголошується screen reader; unknown/drift/offline fail closed без silent downgrade |
| `P-15` | Atomic action area | Save доступний лише для dirty valid set; Reset потребує підтвердження; клавіатурний focus помітний; repeated submit не створює partial write |

#### Message-Group Coverage

Ця матриця не змінює контракти `MG-01`–`MG-13` із `docs/screen-map.md` і структуру з `docs/wireframes.md`; вона замикає кожну групу на presentation/behavior patterns brief.

| Message group | Design patterns | Appearance / behavior application |
|---|---|---|
| `MG-01` | `P-08` | Нативний owner message або attachment; у поточній Сесії працює як уточнення чи точна команда |
| `MG-02` | `P-03` | Одна конкретна межа, її наслідок і явне рішення без custom control |
| `MG-03` | `P-03`, за фактичного збою `P-04` | Межа input або Секрет названі без повторення забороненого значення; аналіз не маскується success-state |
| `MG-04` | `P-01` | Signal-line прийняття й дата/час старту нової Сесії в тому самому native stream |
| `MG-05` | `P-01` | Пряма відповідь починається з результату, не показує roster або fake agent identity |
| `MG-06` | `P-01` | Склад Консиліуму показує конкретні ролі й очікуваний наступний видимий крок |
| `MG-07` | `P-02`, `P-05`, `P-09` | Role/time identity, повне незмінне body, канонічний порядок і доставка в той самий чат |
| `MG-08` | `P-04` | Фактичний поступ, причина очікування, звуження або заміна агента без spinner |
| `MG-09` | `P-10` | Read-only result: налаштовані місячні платежі ChatGPT/Codex і Claude, фактичні інфраструктурні витрати та provider-reported usage/ліміт/reset; usage сесії — `входить у підписку`, недоступне — `невідомо`; per-session token charge і жорсткий ліміт не візуалізуються |
| `MG-10` | `P-10` | Однозначний результат `Стоп` або буквальний перехід `Нова задача` |
| `MG-11` | `P-04` | Збій/неповнота, наслідок, підтверджене/невідоме й доступна наступна перевірка; для `SS-29` — лише safe auth/quota/private category, відомий reset і позачатова reauth-дія без секрету, URL/code або paid fallback |
| `MG-12` | `P-06`, за потреби `P-07` | Рішення → до трьох дій → ризик/перегляд → окрема Технічна частина |
| `MG-13` | `P-10` | Фактичний архівний результат, незмінність попереднього body й допустимий наступний крок |

### State Patterns

Перелік і переходи належать `docs/screen-map.md`; нижче зафіксовано лише appearance/behavior coverage для `SS-01`–`SS-46`.

| State | Appearance pattern | Behavior pattern |
|---|---|---|
| `SS-01` Перевірка доступу | Захищеного `P-01` ще немає; лише platform-native delivery context | До підтвердження доступу агенти й захищений content не з'являються |
| `SS-02` Очікування Згоди на обробку даних | `P-03` із провайдерами, межею, наслідком і явним запитом | Згода веде до data check; без неї обробка не починається |
| `SS-03` Перевірка вхідних даних | `P-08`; agent identity і success styling відсутні | До завершення перевірки типу, Секрету й чутливості агентські репліки не публікуються |
| `SS-04` Доступ не підтверджено | Немає захищеного content; якщо згодом буде підтверджено safe reply, він використовує `P-04` без деталей | Exit без агентів, захищених даних і впливу на Активну сесію Власника |
| `SS-05` Непідтримуваний тип | `P-03`: тип не оброблено → аналіз не запущено → допустимий наступний input | Новий допустимий `P-08` або exit |
| `SS-06` Секрет зупинено | `P-03` без повторення значення Секрету | Новий безпечний input або exit; Секрет не реєструється |
| `SS-07` Очікування дозволу на чутливий документ | `P-03`, прив'язаний тільки до названого документа | Дозвіл веде до прийняття; без дозволу документ не обробляється |
| `SS-08` Активна сесія: Запит прийнято | `P-01` із датою/часом старту й signal-line прийняття | Перехід у direct або consilium flow; команди й уточнення доступні |
| `SS-09` Пряма відповідь | `P-01` без roster і `P-02`; результат перед підставою | Завершення, `P-06` за суттєвого action-contract або `SS-19` |
| `SS-10` Формування Консиліуму | `P-01` зі складом конкретних ролей; без fake agent bubbles | До 30 секунд — перший `P-02`/`P-05`, чесний `P-04` або failure |
| `SS-11` Живий перебіг Консиліуму | Повторювані `P-02` + `P-05`; `P-09` на нові вихідні репліки | Канонічний порядок; уточнення, команди, дозволи, фінал або failure |
| `SS-12` Видимий поступ, очікування або заміна агента | `P-04` між репліками, без spinner або fake typing | Повернення до `SS-11` або перехід у `SS-19` |
| `SS-13` Уточнення Активної сесії | Новий нативний owner message через `P-08` у поточній хронології | Повернення до актуального режиму тієї самої Сесії |
| `SS-14` Облік витрат показано | `P-10`: місячні платежі ChatGPT/Codex і Claude → фактична інфраструктура → доступний provider usage/ліміт/reset; usage сесії — `входить у підписку`, недоступне — `невідомо`; без per-session token charge або budget-limit styling | Read-only return до попереднього active/completed context |
| `SS-15` Зупинена сесія | `P-10` з однозначним результатом `Стоп`; success styling роботи відсутній | Нові виклики й пізні робочі повідомлення не продовжують Сесію |
| `SS-16` Поточну сесію закрито, нову створено | `P-10` з буквальним описом переходу без вигаданого lifecycle label | Новий entry без перенесення активного контексту |
| `SS-17` Очікування дозволу продовжити понад 10 хвилин | `P-03`: причина → часова межа → наслідок → явне рішення | Дозвіл повертає до `SS-11`; без нього робота не продовжується |
| `SS-18` Очікування іншого окремого дозволу | `P-03`, прив'язаний до однієї зовнішньої/високоризикової дії або коучингової межі | Виконується або ставиться лише явно дозволене |
| `SS-19` Збій або неповний результат | Critical `P-04`: збій → наслідок → підтверджене/невідоме → наступна перевірка | Recovery лише за підтвердженою дією; інакше чесний exit |
| `SS-20` Фінальна рекомендація | `P-06` і, за потреби, `P-07` | Архів за підтвердженої цілісності або `SS-18` для окремого дозволу |
| `SS-21` Завершена сесія в Архіві сесій | `P-10`; минулі `P-05` не стають editable | Витрати, експорт, видалення або зберігання без дії |
| `SS-22` Експорт отримано | `P-10` із фактичним результатом; формат файла не винаходиться | Повернення до незміненого Архіву сесій |
| `SS-23` Очікування підтвердження видалення | `P-03` із цілою Сесією як об'єктом необоротної дії | Підтвердження веде до `SS-24`; відмова повертає до `SS-21` |
| `SS-24` Цілу сесію видалено | `P-10` із фактичним результатом без редагування окремих реплік як проміжного кроку | Exit |
| `SS-25` Нативне recovery і verification потрібні | Product-authored protected content відсутній; Element володіє recovery і device-verification presentation | Успіх повертає до `SS-01`; невдача завершує шлях без розшифрування й обробки робочих повідомлень |
| `SS-26` Відкликання пристрою потрібне | Product-authored flow не починається; Element/Matrix володіє revocation presentation | Після відкликання й перевірки іншого пристрою — `SS-01`; інакше exit |
| `SS-27` Room invariants не підтверджено | Захищені `P-01`–`P-10` не з'являються; безпечний `P-04` можливий лише без protected details | Після відновлення інваріантів — `SS-01`; security exception для federation gate потребує явного рішення Власника |
| `SS-28` Передзапусковий subscription auth/quota/private preflight | За успіху невидимий: немає нового `P-01`, spinner, typing, login або credential prompt | Перед кожним model call і запуском залежного агента підтверджує subscription OAuth mode, квоту, відсутність API/PAYG credentials і single-owner eligibility: один захищений Codex OAuth-стан обслуговує окремі реальні sessions/threads, Критик проходить preflight вибраного subscription-провайдера; успіх веде до `SS-09`/`SS-10`, будь-яка невідповідність — до `SS-29` |
| `SS-29` Fail-closed auth/quota/private boundary | Critical `P-04` у `SUR-01`: безпечна категорія причини, відомий provider reset і позачатова наступна дія; без token, `auth.json`, setup-token, reauth URL/code, link або credential field | Жодного model call чи agent launch і жодного API/PAYG/credits fallback; після provider reset або provider-managed reauth поза Matrix — новий `SS-28`, інакше exit/неповний результат |
| `SS-30` Початок входу / локальний доступ завершено | P-11: пояснення та явна Google-кнопка, без пароля/захищених значень; скасування й вихід мають нейтральний результат | Свіжа явна спроба → SS-31; чинна перевірена сесія → SS-32; Element/закриття |
| `SS-31` Google-вхід і повернення | Google у тій самій вкладці; після повернення нейтральна перевірка входу, не loading каталогу; focus/status доступні без motion-only meaning | Успіх → SS-32; скасування → SS-30; недійсні токен/ідентичність/транзакція, replay або збій → SS-33; нова спроба не обходить обмеження |
| `SS-32` Локальний доступ надано | Безпечний статус, видимі локальний вихід і захищене припинення своїх сесій; email/credentials відсутні | SS-34 незалежно від каталогів/AI; локальний вихід → SS-30; expiry/revocation/відключення Власника → SS-33 |
| `SS-33` Доступ відхилено або припинено | Значення закриті; безпечна причина відрізняє невдалий вхід від завершення сесії; незбережене не застосовано | Свіжий явний Google-вхід, якщо доступ дозволений, або Element; без own-MFA/password fallback; відкликання не скасовується рестартом |
| `SS-34` Settings loading | `P-11`–`P-14` у loading/read-only state; placeholders не видаються за current | Save/reset unavailable до цілісного load і validation |
| `SS-35` Значення завантажені | P-12–15: незалежні provider-групи й швидкість, підтверджені версії та порядок Claude, чинні/стандартні/фактичні значення | Зміна/reset/локальний вихід/Element; Save недоступне без зміненого валідного набору |
| `SS-36` Dirty valid | Changed status біля джерела й позитивний `P-14` текст | `P-15` Save доступний; cancel повертає loaded state |
| `SS-37` Incompatible | Inline error біля несумісного control і page status; не color-only | Save і нова сесія fail closed; без silent downgrade |
| `SS-38` Каталог/можливості/провайдер не підтверджені | Стійкий P-14 називає неготову групу й наслідок; неперевірені варіанти не видаються за доступні | Свіжа перевірка або вихід; параметри й active snapshot незмінні; блокуються save/нова консультація, не Google-вхід або чинна локальна сесія |
| `SS-39` Atomic save in progress | `P-15` і status region показують збереження всього набору | Repeated submit unavailable; selected values видимі; результат лише whole-success або whole-failure |
| `SS-40` Save success | `P-14` success текст для всього набору; changed markers очищені | Current оновлено для нових сесій; active snapshot незмінний |
| `SS-41` Save failure | `P-14` error явно каже, що жодну групу не змінено | Reload/fix/retry після свіжої validation; без partial write чи false success |
| `SS-42` Reset confirmation | Фокусована permission boundary називає всі три групи і наслідок | Confirm/cancel мають однозначний keyboard focus order |
| `SS-43` Reset result | Whole-set success або `SS-41` failure; без partial status | Default стає current лише після atomic success і лише для нових сесій |
| `SS-44` Active snapshot notice | `P-13`/`P-14` помітно розрізняють current і active effective | Не пропонує live apply; exit до Element або повернення до loaded state |
| `SS-45` Offline | Позначено несвіжі дані й непідтверджений результат без success styling | Мережа → серверна перевірка сесії й перечитування результату; expiry → SS-33; не повторювати запис наосліп |
| `SS-46` Mobile/long content | Один стовпець; повні labels, model names, mappings, errors і actions без horizontal dependency | Той самий контракт на 390/430/768/1280/1440; нічого не вилучається |

Загальні стани:

- Empty: product-owned welcome або onboarding block відсутній.
- Hover/focus/active: повністю нативні; продукт не створює власних focusable controls.
- Disabled: заборонена дія пояснюється текстом, а не custom disabled control.
- Loading: `P-01`, `P-02`/`P-05` або `P-04`; custom spinner чи typing indicator не додається. Успішний `SS-28` не створює loading message взагалі.
- Offline/delivery: показує Element; product-authored success не виводиться з візуального індикатора без фактичного evidence.
- Long content: `P-05` лишається повним; якщо клієнт застосовує власне згортання, продукт не додає другий collapse layer.

### Interaction Primitives

- Надіслати текст, зображення або PDF через штатний composer.
- Надіслати звичайне уточнення в межах Активної сесії.
- Ввести точну команду `Стоп`, `Нова задача` або `Витрати`.
- Дати явну текстову згоду чи відмову щодо одного `P-03`; quick replies або buttons не припускаються.
- Прокручувати нативну хронологію та відкривати нативний preview вкладення.
- Запросити архівну дію текстом; точний intent-словник лишається відкритим.
- Відкрити GoDaddy settings URL, явно почати Google-вхід і повернутися в тій самій вкладці; локальний доступ — лише після перевірок.
- Незалежно вибрати підтверджені модель/міркування Codex та Claude Code й окремо швидкість; не переносити рівні між провайдерами.
- Атомарно зберегти dirty valid set, скасувати локальні зміни або після підтвердження повернути весь набір до default.
- Відкрити Element або закрити settings; це не локальний вихід. Окремий вихід/припинення своїх сесій не означає Google logout і не змінює AI OAuth.

### Accessibility Floor

1. WCAG 2.2 AA — ціль для product-authored content у межах його контролю, не твердження про перевірену відповідність: порядок, labels, читабельний fallback, errors/permissions і відсутність color-only meaning.
2. Нативний шрифт і його масштабування не перевизначаються. Prototype evidence має перевірити збереження змістової ієрархії зі збільшеним текстом, VoiceOver на iPhone/Mac і TalkBack на Samsung Flip7/Android; Windows desktop flow перевіряється з keyboard navigation і доступним screen reader.
3. Роль, час, статус, ризик і потрібна дія мають бути вимовними як звичайний текст. Emoji, punctuation art або typographic emphasis не є єдиним label.
4. У повідомленні з довгим body використовуються короткі абзаци й справжня послідовність списку. Ручні колонки та таблиці не є preferred authoring pattern, бо нестабільно переносяться й читаються screen reader; уже підтверджене тіло не змінюється.
5. Технічний content має текстову назву й контекст. Monospace не є єдиною ознакою того, що фрагмент потрібно скопіювати або виконати.
6. Критичний стан зрозумілий без motion; `P-09` не змінює його змісту.
7. Native controls успадковують target size, focus і input behavior Element/ОС. Brief не заявляє їхню відповідність без тесту поточних клієнтів.
8. Не використовувати images of text для product-authored відповідей. Якщо input image або PDF недоступний для аналізу, стан пояснюється текстом, не вгадується з thumbnail.
9. `SUR-02` має WCAG 2.2 AA як floor: семантичні заголовки й labels, повна keyboard navigation, видимий `focus.ring`, програмне пов'язання errors з controls, status region для async result і відсутність color-only meaning.
10. Interactive targets у `SUR-02` мають не менше 24×24 CSS px за WCAG 2.2 AA; для primary touch actions на 390/430px ціль — 44×44 CSS px або еквівалентна доступна зона.
11. Окремо плануються 320 CSS px reflow (або 400% zoom від 1280px) та 200% text resize без втрати Google-дії/локального виходу, параметрів і помилок. AA-межа 24×24 CSS px допускає застосовний виняток; 44×44 — house touch-орієнтир, не визначення AA. Provider-brand оформлення не скасовує keyboard/focus/semantics вимог.

### Key Flow Implications

| Journey source | Success coverage | Failure / permission coverage |
|---|---|---|
| `docs/user-journey.md`: Stages 1–4, доступ, дані й прийняття | `SS-08` через `P-01` | `SS-02`, `SS-04`–`SS-07`, `SS-25`–`SS-27` через native Element states і `P-03`/`P-04`; Секрет не повторюється |
| Stage 5 і Stage 6A, Пряма відповідь | Невидимий успішний `SS-28`, потім `SS-09` і за підтвердженої цілісності `SS-21` | `SS-29` fail closed без model call, credential UI чи paid fallback; general `SS-19` відділяє невідоме й наступну перевірку; fake consilium відсутній |
| Stage 6B, Повний Консиліум | Успішний `SS-28` перед кожним залежним model call/agent launch; `SS-10`–`SS-12` через roster, `P-02`, `P-05`, `P-09`; потім `SS-20` | `SS-29` показує safe same-room status і позачатову recovery-дію; заміна/очікування через `P-04`; понад 10 хвилин — `SS-17`; недоступний консиліум — `SS-19` |
| Stage 7, втручання Власника | `SS-13`/`SS-14` повертають до контексту; `SS-15`/`SS-16` дають контрольований exit/restart | Пізні репліки після `Стоп` не публікуються; контексти після `Нова задача` не змішуються |
| Stages 8–9, збій, час і Фінальна рекомендація | `SS-20` через `P-06`/`P-07` | `SS-17`–`SS-19` і `SS-29` через `P-03`/`P-04`; OAuth reauth відбувається лише поза Matrix, зовнішня дія не виконується з самої рекомендації |
| Stage 10, Архів, експорт і видалення | `SS-21`, `SS-22`, `SS-24` через `P-10` | `SS-23` потребує повторного дозволу; окрема репліка не редагується й не видаляється |
| Settings S1–S2, JOB-003 / UC-003 / UC-004 | SS-30–35: Google-дія, same-tab повернення, окрема локальна сесія та завантаження | Cancel → SS-30; deny/expiry/revocation → SS-33; каталог → SS-38; offline → SS-45; без витоку/fallback |
| Settings S3, change/validation | `SS-36` через `P-12`–`P-15`; dirty valid набір явний | `SS-37`–`SS-38` fail closed, error пов'язаний з джерелом, silent downgrade відсутній |
| Settings S4–S5, save/reset/return | `SS-39`–`SS-44` через `P-13`–`P-15`; whole-set result і active snapshot notice | `SS-41`/`SS-45`: без partial write або false success; `SS-42` reset потребує явного підтвердження |

## Responsive And Platform Behavior

Порядок і hierarchy однакові в усіх клієнтах; responsive contract змінює лише перенесення й доступний простір, не інформаційну архітектуру.

| Evidence viewport | Представляє | Contract |
|---:|---|---|
| `390px` | Вузький iPhone-class viewport | `SUR-01`: нативна chronology. `SUR-02`: один стовпець, повні три групи й дії з торкальними цілями, що не менші за accessibility floor |
| `430px` | Wide-phone Android / Samsung Flip7-class viewport | Той самий order на обох поверхнях; довгі role/model labels, mappings і errors переносяться без втрати association |
| `768px` | Проміжний stress viewport | Не створює tablet dashboard, sidebar або двоколонковий transcript/settings grid; перевіряє line-wrap, focus order і 200% text zoom |
| `1280px` | Mac або Windows desktop-class viewport | `SUR-01`: одна chronology. `SUR-02`: односторінкова readable utility width; додатковий простір не створює dashboard columns |
| `1440px` | Wide desktop stress viewport | Той самий content order і density; жодна поверхня не заповнює простір decorative chrome, cards-in-cards або sidebar |

На кожному актуальному клієнті окремо перевіряються:

- light/dark appearance й user text scaling, які реально підтримує клієнт;
- selective bold, списки, цитати й inline/monospace treatment, перш ніж вони стануть частиною approved prototype;
- перенесення довгої конкретної ролі та `HH:MM`;
- довгі українські agent replies, посилання й Технічна частина без горизонтальної композиції;
- VoiceOver/TalkBack/desktop keyboard та screen-reader reading order;

## Heuristic Review

Спільне трасування: Matrix — JOB-001/JOB-002/JOB-004/JOB-005, UC-001/UC-002/UC-005/UC-006, UJ 1–10; Settings — JOB-003, UC-003/UC-004, UJ S1–S5, SUR-02/SS-30–46. Поточна корекція охоплює лише Settings; незмінене Matrix planned coverage успадковано. Для кожного рядка застосовність підтверджена його primary scope та взаємодією; QA binding pending до створення актуальних IDs. 390/430/768/1280/1440px збережені; 320px reflow та text resize перевіряються окремо.

Це design-stage coverage за canonical H1–H10, а не виконаний user test, runtime proof, visual-fidelity verdict або accessibility conformance. Для всіх рядків coverage — `covered`, execution status — `not_run`; фактичний reviewer, час, evidence і findings мають бути записані під час окремого authorized walkthrough/QA.

| ID | Primary scope | Intended behavior | Planned evidence |
|---|---|---|---|
| `H1` Visibility of system status | `SUR-01` progress/failure/delivery; `SS-31`, `SS-34`, `SS-39`–`SS-45` | Кожна async, save, reset, permission і offline зміна має distinct text status; false success відсутній | State/transition walkthrough на 390/430/768/1280/1440px і runtime evidence там, де заявлено behavior |
| `H2` Match the real world | Обидві поверхні; українська мова Власника | Канонічні `Власник`, `Сесія`, `Консиліум`, `Стоп`, `Нова задача`, `Витрати`, current/default/effective та буквальна owner-access copy | Реалістичні українські fixtures, звірка з canonical terms і primary journey order |
| `H3` User control and freedom | Matrix-команди/дозволи; JOB-003, UC-003/004, S1–S5 | Google cancel/retry, локальний вихід окремо від Element/Google; параметри й active snapshot незмінні, незбережене не застосовується | Запланований cancel/expiry/revocation/relogin/reset walkthrough із preserved-data contract; runtime proof окремо |
| `H4` Consistency and standards | Element-клієнти; SUR-02/P-11–15 | Нативні Matrix conventions збережені; офіційні Google-brand правила тільки кнопки; сталі labels/focus/provider-групи | Cross-viewport keyboard/touch/screen-reader та asset-provenance review, planned/not_run |
| `H5` Error prevention | Room/data gates; UC-003/004 auth/validation/save/delete | Кожний NFR-016.a–h має allowed/denied/recovery наслідок; disabled/hidden control не авторизує; allowlists/атомарність незмінні | Заплановані токен/ідентичність/транзакція/replay/expiry/revocation/підроблений запит/обмеження, incompatible-set і destructive-confirmation paths; без password/own-MFA fallback |
| `H6` Recognition rather than recall | `SUR-01` signal-first messages; `SUR-02` form | Роль/час, поточний статус, потрібна дія, current/default/effective, mappings і changed state видимі в point of action | Long-content walkthrough без опори на пам'ять попередніх екранів/повідомлень |
| `H7` Flexibility and efficiency | Частий Matrix flow, рідкісний JOB-003 | Composer/exact commands незмінні; чинна локальна сесія не потребує зайвого входу; каталог не блокує Google; немає нових advanced/bulk/per-agent controls | Повторний task і keyboard/touch walkthrough зі збереженням простого початкового шляху; planned/not_run |
| `H8` Aesthetic and minimalist design | Candidate B v2, обидві поверхні | Deliberate restraint, chronology, utility-палітра; Google-brand стиль обмежено кнопкою | Майбутні captures з DB-D18/DB-D19; frozen bytes не видаються за чинний auth/model proof |
| `H9` Recognize, diagnose and recover from errors | P-03/P-04, SS-19/29; UC-003/004, SS-30–45 | Наслідує Error And Recovery Contract wireframes: причина → збережене → наступна дія → retry/undo → завершення; секрети й невідомий результат не вигадуються | Заплановані cancel/auth/expiry/revocation/catalog/validation/write/conflict/offline walkthroughs; runtime/user execution окремо |
| `H10` Help and documentation | Permission/recovery; JOB-003, S1–S5 | Коротка допомога біля Google-переходу, локального виходу, незалежного міркування й каталогу; без help-center/onboarding | Task-oriented next action, preserved data і completion за wireframes; planned/not_run, без нової поверхні |

## Usability Validation Plan

Учасник плану — єдиний Власник, без точної email-ідентичності в документі. Усі UV-* — task definitions, planned/not_run; поточних representative-user claims немає. Відповідальний за майбутнє спостереження — авторизований reviewer; timing змінених auth/provider-потоків — до прийняття їхнього design-handoff за можливості та після реалізації для runtime-поведінки. Original approval не повторюється. Неспостережений ризик — нерозуміння локального виходу/повтору чи незалежних параметрів; його закриває спостереження відповідного task, не document validation. QA bindings pending.

| Task | Context and viewport | Success signal | Evidence target |
|---|---|---|---|
| `UV-01` Надіслати простий Запит, а потім складний Запит для Консиліуму | Реальний Element на Mac і одному mobile client | Пряма відповідь не імітує консиліум; складний flow показує фактичні role/`HH:MM`, повні репліки й фінальний synthesis у тій самій кімнаті | Screen capture + registered-message/runtime trace; content integrity comparison |
| `UV-02` Відмовити в дозволі, дати уточнення, виконати `Витрати`, `Стоп` і `Нова задача` | `SUR-01`, long chronology | Відмова не переноситься; уточнення не створює паралельну Session; exact commands мають буквальний наслідок; пізня репліка після `Стоп` не публікується | State/transition log + visible same-room result |
| `UV-03` Google-вхід, cancel/retry/deny, локальний вихід/expiry/revocation (JOB-003, UC-003, S1/S5, SS-30–33/45) | Власник; 390/1280px і 320px reflow | Зрозумілий same-tab перехід, безпечний результат, local exit/retry; каталог не блокує вхід. Кожний auth-clause й durable revocation потребує окремого runtime evidence | План: спостереження й captures без email/секретів; runtime/security evidence окремо, не frozen demo; not_run |
| `UV-04` Незалежні параметри, помилка, save/reset/Element (JOB-003, UC-004, S2–S5, SS-34–46) | Власник; 430/768/1440px, keyboard/touch | Точні підтверджені версії й порядок Claude; provider changes незалежні; default без explicit effort; каталог/помилка зрозумілі, active snapshot незмінний | План: task спостереження; persistence/snapshot evidence після реалізації; not_run |
| `UV-05` Google-дія, local exit, помилка й long content (JOB-003, UC-003/004) | Власник; keyboard/screen reader, VoiceOver/TalkBack; 320px reflow та окремо 200% text resize | Логічний focus, names/errors/status, збережений зміст і зрозумілий recovery; Google-кнопка не скасовує доступність | План: accessibility walkthrough, captures і висновки; not_run, не conformance claim |

## Design Handoff Prompt

Реалізувати затверджену інтегровану revision `B — Дослівний консиліум v2`, яка разом покриває Matrix-native `SUR-01` і secure settings `SUR-02`.

Обов'язково:

- зберегти `MG-01`–`MG-13`, `SG-01`–`SG-05`, `SS-01`–`SS-46` і всі двоповерхневі sequences з `docs/wireframes.md`;
- показати representative narrow і desktop viewports, long verbatim agent reply, role/time identity, permission, progress, `SS-29` safe same-room failure і final series; успішний `SS-28` лишити невидимим;
- використати лише перевірені нативні text-formatting і Matrix reply affordances Element/Matrix та current-client chrome як контекст, не як нову product-owned system;
- не створювати browser chat/dashboard, custom Element bubbles/composer або shared app-shell; `SUR-02` лишати one-page secure utility без sidebar, cards-in-cards чи advanced controls;
- застосувати в SUR-02 тільки DB-D18/DB-D19: Google/same-tab і local-session стани, незалежні provider-групи, каталог/сумісність, атомарність і recovery за wireframes;
- не переносити Cloudflare-посередництво, demo email, спільний effort чи непідтверджені модельні fixtures; не додавати password/own-MFA/fallback, іншого IdP або AI credentials;
- не створювати login/reauth screen для AI-підписок чи credential/link/code field у Matrix; це не забороняє підтверджену Google-дію P-11; SS-29 лишається безпечним повідомленням;
- показати `Витрати` як місячні платежі AI-підписок, фактичну інфраструктуру й доступний usage/limit/reset; usage сесії — `входить у підписку`, недоступне — `невідомо`, без per-session token charge;
- не скорочувати й не перефразовувати representative registered agent body;
- зберегти frozen baseline з DB-D18/DB-D19; mockup/approval не є runtime/security/user/accessibility evidence й не дозволяє production без окремого пізнішого prompt.

## Approved Visual Baseline

Локальна перевірка лише читанням 05.09.2026 підтвердила поточні hashes target, обох receipts, чотирьох файлів кореня й двох прямих shared-залежностей. Кореневий `sdd-tree-sha256-v1` збережений як компонент; поточний повний hash-домен — корінь і дві точні залежності за `sdd-render-sha256-v2`. Це підтверджує нинішні bytes, не їхню безперервну тотожність від 16.08.2026. Links, newline paths і виключення не застосовані. Prototype/validator не запускалися; visual/heuristic/user/accessibility/runtime/security execution цього invocation — not_run.

- Status: approved
- Baseline ID: `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`
- Selected Candidate And Version: `B — Дослівний консиліум v2` — Matrix-native `SUR-01` + HappyPro-palette `SUR-02`
- Immutable Visual Target Reference And SHA-256: `forge/design/candidates/candidate-b/v2/index.html`; `07e3675265e8cadef1e65c132f32e3cbbf4d6537cbfd316ea16a6bacd56f1bd6`
- Frozen Prototype Source Root, Algorithm And Tree Hash: `forge/design/candidates/candidate-b/v2`; `sdd-render-sha256-v2`; `57d103c5ed17bcc9a9d95a58718f83c33b8257229fc825b756367321eaa33199`
- Render Dependencies: `forge/design/candidate-sets/whatsapp-consultant/v1/shared/scenario-fixture.js` — `96732f738a41bf1f838736de77a748ef65704d68010553bbf43638f83ddd1af6`; `forge/design/candidate-sets/matrix-consultant/v2/shared/scenario-fixture.js` — `0f3959792187148a2e1ae842c738644da7ed60ddc01776948f86914b8fb207e6`. Обидва файли підключено з `index.html`; вони входять до aggregate, а не до самого кореня.
- Previous Normalized Root Hash: `sdd-tree-sha256-v1`; `4c6f2d51be1baf5962035933deeec7095d31f1d3e6c473ec9e43cb0e3a360744` — незмінний поточний чотирифайловий корінь, який відповідає нормалізації 04.09.2026; сам по собі не охоплює shared-залежності.
- Prototype Artifact References: `index.html`, `styles.css`, `app.js`, `validate.mjs`; `forge/design/evidence/candidate-b/v2/visual-qa.json`; four screenshots under `forge/design/evidence/candidate-b/v2/`
- Visual Definition Of Done Scope: повна відповідність цій revision для `SUR-01` і `SUR-02`: Matrix-native content choreography, повний дослівний body, роль/`HH:MM`, safe states, settings one-page hierarchy, HappyPro palette, keyboard/focus, responsive order; старі v1-кандидати не є visual target
- Covered Screens States And Viewports: `SUR-01`–`SUR-02`, `MG-01`–`MG-13`, `SG-01`–`SG-05`, `SS-01`–`SS-46`, `390/430/768/1280/1440px`
- Approval Receipt: `forge/design/evidence/candidate-b/v2/approval-receipt.json`; SHA-256 `1b39065b05a2c9b987ab8bf88c118f92e144190769c4ebb9e8a039f21540c300`; явне повідомлення Власника 16.08.2026: «ОК. Закрий хром і продовжуй розробку» після перегляду Candidate B v2. Original receipt не змінено.
- Dependency Binding Receipt: `forge/design/evidence/candidate-b/v2/approval-render-binding-20260905.json`; SHA-256 `30d4d7665209f591821ed00bdb551789fb560a4056c50c3aa0ee7a64eade7598`; поточний операційний запис `owner_reviewed_legacy_dependency_binding`, `recorded_at: 2026-09-05T15:16:10Z`, review invocation `1d2b3940-a05a-4bd6-a413-9142fe504684`. Для v2 binding застосовується цей запис із посиланням на original receipt, а не нова згода Власника.
- Approved At: `2026-08-16T02:22:48+03:00`
- Approval Provenance: original whole-design approval та його час збережені. Нормалізація `2026-09-04T21:43:42+03:00` записала поточні target/root metadata; міграція 05.09.2026 додала до hash-домену лише дві залежності з hashes, що збігаються з історичними fixture-доказами. Це поточна owner-reviewed прив'язка без зміни frozen bytes, не нове visual approval і не ретроспективний доказ точного rendering bundle від 16.08.2026.
- Historical Evidence Limitation: початковий legacy hash `96b91ba9622f8301809ed10ef661a313006e0c2743712912c624edc36a2ca8eb` залишається невідтвореним; безперервна тотожність точних bytes кореня від 16.08.2026 не доведена. Це обмеження не є доказом несанкціонованої зміни після approval; історичні QA-результати не приписуються нинішньому bundle як щойно виконані перевірки.
- Permitted Variance: нативні Element/ОС відмінності допустимі як platform variance; body/order/role/Matrix replies і незмінена поведінка збережені. Лише DB-D18/DB-D19 і scoped refinement DB-D20 замінюють відповідні access/provider наслідки frozen demo; довільна зміна палітри або цілісного напряму не дозволена.
- Current Critic Override: `DB-D20` уточнює `DB-D19`: `SUR-02`, `P-12`–`P-15`, `SG-02`–`SG-05`, `SS-35`–`SS-44`; selector Claude Code/Codex і його незалежні поля, no-Claude recovery, без зміни палітри, загальної ієрархії або заморожених файлів. Прийнята scoped-корекція — пряме повідомлення Власника «I need a router switch for Critic - both Claude and Codex»; зафіксовано 06.09.2026, точний час отримання невідомий. Original approval/receipt не змінено.
- Operator Overrides: історичні палітра HappyPro й заборона спеціальних звуків збережені. Чинні DB-D18 (Google/local-session presentation замість DB-D17) і DB-D19 (незалежні provider model/effort, точні версії/порядок, каталог) спираються на підтверджені upstream-рішення. Scope: SUR-02, P-11–15, SG-01–05, SS-30–46 лише в названих access/provider/recovery наслідках. Збережені one-page utility, палітра, Matrix-подача, Baseline ID, frozen bytes та original receipt. Це не новий whole-design approval і не live-login доказ.
- Supersedes: попередні WhatsApp `A/B/C v1` як поточний design target; їхні source/evidence артефакти лишаються незмінними історичними записами
- Superseded By: none
- Downstream Invalidation: архітектура → DoD/evals → QA → development plan мають звірити лише наслідки DB-D18/DB-D19/DB-D20 із тим самим Baseline ID/target та поточною v2-прив'язкою кореня і залежностей, зберігаючи історичне обмеження. Попередня implementation authorization не переноситься автоматично; потрібен окремий пізніший implementation prompt. Frozen demo — provenance, не буквальний auth/shared-effort/model target; цей owner не змінює runtime або manifest.

## Validation Report

### Pass 1 — Mechanical coverage

`0 findings` у зміненій auth/provider/provenance області. Незмінені результати попереднього document-review нижче успадковані, не є новим широким аудитом.

- Key-flow coverage: незмінені Matrix-групи успадковано; JOB-003/UC-003/UC-004 покрито Google/session/provider success, denial і recovery, H1–H10 та запланованими UV-03–05.
- Token resolution: кожен token reference у brief визначено один раз у `Design Tokens`; unresolved token references — 0.
- Pattern closure: `P-01`–`P-15` мають appearance і behavior principles — 15/15.
- Screen/state coverage: `SUR-01`–`SUR-02` — 2/2; `MG-01`–`MG-13` — 13/13; settings-групи `SG-01`, `SG-02`, `SG-03`, `SG-04`, `SG-05` — 5/5; `SS-01`–`SS-46` — 46/46 через state-pattern contract.
- Direction inventory: активний approved baseline — один, Candidate B v2; historical superseded набір містить рівно три candidates `A/B/C v1`. Нові A/C не вигадані після явного вибору Власника.
- Source inventory: поточні DBM-джерела відокремлені від успадкованої історії; усі 17 hashes поточного dispatch перевірено: сім upstream-документів, чотири файли кореня, дві shared-залежності, два історичні QA-записи й обидва receipts. V2 aggregate відтворюється; це byte-evidence, не browser/runtime validation.

### Pass 2 — Judgment

У зміненій області: `0 Critical/High findings; 1 Medium non-blocking evidence mismatch`. Це document-review, не release/evidence gate execution.

- Bloat: custom pixel specs, decorative palette, parallel design system, re-stated wireframe layouts і implementation tasks відсутні.
- Inheritance: нативна система Element/Matrix явно успадкована; `consilium/live/styles.css` явно відхилено як product design source.
- Shape: Design Spine визначає presentation, Experience Spine — behavior; product scope і state inventory не переозначені.
- Generic-AI critique: обраний Candidate B має продуктово специфічний signature rhythm — фактична адресована репліка, роль, `HH:MM`, native Matrix reply і канонічний порядок — а не випадкову палітру чи decorative styling.
- Scoped-override review: DB-D18/DB-D19 змінюють тільки Google/session/provider контракти; нових поверхонь, Matrix-подачі або глобальної token-системи немає. Google-brand виняток стосується лише кнопки.
- Evidence mismatch (Medium, неблокувальний для авторства): frozen prototype зберігає історичні Cloudflare/demo identity, shared effort і непідтверджені model fixtures. DB-D18/DB-D19 замінюють ці наслідки без переписування bytes/receipt. Живий вхід, user/heuristic/accessibility execution не перевірялися.
- Unresolved-content marker scan: 0 markers; approved-baseline поля мають повні canonical metadata та provenance.

### Перевірка міграції прив'язки залежностей — 05.09.2026

Зміна обмежена metadata, inventory і provenance; DB-D18/DB-D19, решта design-контракту, original receipt та frozen bytes збережені. Нових продуктових або візуальних рішень немає. Поточний aggregate та hashes джерел перевірено; невідтворений legacy hash і недоведена тотожність кореня від 16.08.2026 явно залишаються обмеженням історичного доказу, не прихованим pass. Міграція не виконує й не замінює visual, heuristic, user, accessibility, runtime, security або release-перевірки.

## Confirmed Design Decisions

- V1 має рівно дві поверхні: приватну Element/Matrix-кімнату `SUR-01` і вузькі responsive `Налаштування власника` `SUR-02`.
- Нативний Element/ОС володіє chrome, кольором, шрифтом, повідомленнями, delivery/offline indicators, composer, notification sounds, accessibility і motion.
- Product design володіє content hierarchy, message choreography, role/time identity, readable formatting і state meaning.
- Повна Підтверджена репліка агента не скорочується, не згортається, не редагується й не очищується після реєстрації.
- Фінальна рекомендація — окремі самодостатні повідомлення: рішення, до трьох дій, ризик/припущення/умова перегляду, Технічна частина лише за потреби.
- Critical meaning завжди явний у тексті й не залежить лише від appearance або motion.
- Candidate B «Дослівний консиліум v2» є Approved Visual Baseline для інтегрованих `SUR-01` + `SUR-02`.
- `SUR-02` — стримана system-like one-page utility з трьома групами, current/default/effective, compatibility status, atomic Save/Reset і active-session snapshot notice.
- DB-D18/DB-D19 є чинними scoped overrides; DB-D17 — скасована історія. Google/local-session та незалежні provider-параметри не змінюють original approval, frozen bytes, палітру або Matrix-подачу.
- Успішний `SS-28` невидимий; `SS-29` fail closed і показує лише safe category, відомий reset та provider-managed reauth поза Matrix, без credential/link/code fields і без API/PAYG fallback.
- `Витрати` показують налаштовані місячні платежі за ChatGPT/Codex і Claude, фактичну інфраструктуру та доступний usage/limit/reset; usage сесії входить у підписку, а недоступне позначається `невідомо`.

## Rejected Directions

- Будь-який browser chat, live-preview, dashboard, archive-browser, cost panel або consent-center; `SUR-02` — єдиний web-виняток і не є жодним із них.
- Custom Element chrome, theme, bubble, header, composer, button, quick reply, card, badge або role avatar.
- Успадкування browser-specific styles із `consilium/live/styles.css`.
- Product-added transcript summary, accordion, collapse або reader-screen замість повного body.
- Custom spinner або typing animation.
- Будь-який Settings login поза Google: password/fallback, власна MFA/OTP, magic link, інший IdP/ідентичність, реєстрація чи password recovery/reset застосунку; AI credential/login surface, code у Matrix та PAYG/credits заборонені.
- Вигадана per-session token charge, budget-limit visualization або автоматичні usage credits для subscription usage.
- Довільну нову цілісну візуальну revision без потрібного рішення; підтверджені scoped DB-D18/DB-D19 не створюють повторного whole-design approval.
- Попередні WhatsApp `A/B/C v1` як актуальний visual target; вони лишаються лише immutable superseded historical evidence.

## Out Of Scope

- Нові функції, ролі, screens, routes, message groups, states, input types або паралельні Сесії.
- Точний final copy для кожного сценарію та intent-словник непідтверджених команд.
- Архітектура Matrix, GoDaddy/MySQL, Google-входу, локальних сесій, A2A, archive/keys/retries/delivery й витрат належить відповідним власникам; Cloudflare cleanup — історична JIT-межа.
- QA-кроки, implementation tasks, code, browser chat або evidence UI; custom frontend лише в SUR-02, включно з підтвердженою Google-дією до доступу.
- Зміна нативних налаштувань Element чи операційної системи від імені Власника; власний звук повідомлень.

## Open Questions

1. Яка точна safe visible reaction потрібна для стороннього або непідтвердженого відправника: мовчазна відмова чи повідомлення без захищених деталей?
2. Який lifecycle-термін отримує попередня Сесія після `Нова задача`? До рішення повідомлення лишається буквальним: поточну сесію закрито, нову створено.
3. Чи зберігається Зупинена сесія після `Стоп` в Архіві сесій і з яким статусом?
4. Які точні фрази запускають експорт, видалення цілої Сесії та відмову від цих дій?
5. Які формулювання однозначно є явною згодою або відмовою для кожного `MG-02`?
6. Яка policy-класифікація визначає Особливо чутливий документ?
7. Які current-client відмінності в native formatting, long-message presentation, text scaling і screen-reader reading order виявить prototype/evidence pass на чотирьох цільових клієнтах?

Ці питання не блокують approved design contract, не дозволяють додати третю поверхню або custom Element chrome і не є pre-prototype approval gate.

## Маршрутизатор Критика — узгодження 06.09.2026

`DB-D20` — вузька прийнята корекція від Власника, після перегляду upstream security consequences у PRD. Вона зберігає три групи й наявні semantic tokens; Критик має один доступний selector провайдера та fields тільки вибраної гілки. Focus після перемикання залишається на selector; зміна статусу оголошується без автозбереження. Неактивний Claude не приховує елементи керування Codex; недоступні вибрані model/effort позначаються явно без підміни. Claude зберігає порядок версій; параметри Codex-агентів не змінюються.

H1/H2/H6: видно конкретну роль, маршрут і чинні/збережені значення; H3/H5/H9: cancel/retry/preservation і недоступний маршрут; H4: labels/focus/keyboard/AT; H7: одне явне перемикання без повторної Google-авторизації чи реконфігурації агентів; H8: лише активна гілка без нової панелі; H10: коротко пояснено, як відновити саме обраний маршрут. Coverage — covered, execution — not_run. Scope: `JOB-003`, `UC-004`, S2–S5, `SUR-02/SS-35–44`, 390/430/768/1280/1440px плюс 320px reflow і 200% text zoom.

`UV-04` доповнено задачею вибрати Codex → підтверджені Astra/Extra High за недоступного Claude, зберегти, повернутися на Claude й побачити його попередні значення без зміни Codex-агентів або активної сесії. Учасник — Власник; success — самостійно розуміє маршрут і межу наступної сесії. Pre-approval спостереження для цієї scoped-корекції відкладене: немає реалізованого selector; ризик плутанини ролі/провайдера, відповідальний — authorized reviewer, строк — після реалізації перед прийняттям зміненого UI. Це не пройдений user test.

Механічна та змістова перевірки документа: нових поверхонь, token system або прихованого fallback немає; upstream state/recovery/рольові межі узгоджені. Заморожений target/render bundle повторно хешовано без змін: aggregate `57d103c5ed17bcc9a9d95a58718f83c33b8257229fc825b756367321eaa33199`. Історичне обмеження baseline збережене. Нових browser/visual/heuristic/user/accessibility або runtime доказів немає.
