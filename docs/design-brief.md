# Design Brief

- Продукт: `Personal Consultant`
- Версія brief: V1, до цілісного design-затвердження
- Статус: proposed
- Дата: 16.08.2026
- owner_invocation_id: `84b69db5-abcf-48b2-b344-3b101ca1f8b5`

## Source References

Порядок джерел відповідає `docs/guardrails.md`. Цей brief не змінює продуктову поведінку, перелік станів або структуру wireframes; він визначає presentation- і interaction-контракт для рівно двох підтверджених поверхонь: `SUR-01` і `SUR-02`.

| Джерело | SHA-256 / статус | Спожиті фрагменти |
|---|---|---|
| `README.md` | `d1afdf92181df9e002f9f75678f8ca46083c90bec0a9a33e47535a0593fa1c9c` | Позиціонування; принцип практичного результату; історичний browser-preview лише як нецільовий контекст |
| `docs/product-idea.md` | `263a5d15949e2ebf70f9fb4fa8ba67ff1e882cb5ae2774ecf218ccff16586ac5` | Дві поверхні V1; Element/Matrix; Candidate B; `Налаштування власника`; Google-only exact-email access; три групи; atomic save; immutable active-session snapshot |
| `docs/prd.md` | `2d9546dd7b0f4cd25dea0f225ffa35c0819966e3edb9efaa72f781f3fb70d660` | §3.2–3.5; §4–5; `FR-001`–`FR-046`; `NFR-001`–`NFR-019`; §8–12; `AC-001`–`AC-016` |
| `docs/project-context.md` | `529ee8b70ec81b2a4734cb7580e5bfc84052a9f2552b039cd52bd42dfe4b2fee` | Platform Targets; Core Scenarios; Google Access/JWT; три settings-групи; responsive web; subscription OAuth boundary; Risks |
| `docs/canonical-terms.md` | `75e8ab94a47faa0f89a51605543f2f643ce9b53c8513d26ee7d5bb54037f26fc` | `Налаштування власника`; `Google-вхід`; `Subscription OAuth`; `Моделі`; `Глибина міркування`; `Пресет швидкості`; `Фактичні налаштування сесії`; Terms to Avoid |
| `docs/guardrails.md` | `54c7ccd20d612e908f1038499c2db101d47e587c141a2d5363e003b2a0dbb3bc` | Source order; two-surface boundary; Google Access/JWT; exact three groups; atomic save; immutable snapshot; forbidden settings expansion; Design Authority Rules |
| `docs/user-journey.md` | `e4dfa9801ef0eab241c4b768719732628e37aebb068a8fd8067eeedbe1a6d7cd` | Element Journey Stages 1–10; Settings Journey S1–S5; failure paths; exits; success states |
| `docs/screen-map.md` | `5f138005cf9b6c9b347cc8d876bd74f6f9c977503ad6dc53436ccd35e75f0a5b` | `SUR-01`–`SUR-02`; `MG-01`–`MG-13`; `SG-01`–`SG-05`; `SS-01`–`SS-46`; route, transition, entry/exit and edge contracts |
| `docs/wireframes.md` | `df7ca5c68e238416d16541e765b6a062bd29ab1328de06dc0f064f0600fb2edc` | `SUR-01` native chat structure; `SUR-02` authenticated settings structure; message, settings and state blueprints; responsive notes; content priorities |

Актуальні платформні джерела перевірено 15.08.2026:

- [HappyPro Academy CSS](https://happypro.academy/styles.css?v=20260814-september-cohort-v23) — первинне джерело палітри `#071a33`, `#dceeff`, `#2e6fdc`, `#c0265b` і `#f79e1b` для product-owned `SUR-02`, перевірене 16.08.2026.
- [Element Support: The Middle Panel](https://docs.element.io/latest/element-support/quick-start-guide/the-middle-panel/) — офіційна довідка про нативні message, composer, formatting, reply, attachment і thread affordances Element.
- [Matrix Client-Server API v1.19](https://spec.matrix.org/v1.19/client-server-api/) — офіційний контракт `body`/`formatted_body`, rich replies і client-specific fallback/rendering.
- [Element Download](https://element.io/download) — офіційне джерело підтримуваних desktop і mobile клієнтів.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) — базова accessibility-ціль для змісту й майбутніх design-evidence артефактів.
- [Apple Human Interface Guidelines: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility/) і [Android Developers: Make apps more accessible](https://developer.android.com/guide/topics/ui/accessibility/apps) — системне масштабування тексту, screen-reader use, контраст і нативні елементи керування мають перевірятися на відповідних клієнтах.

`consilium/live/styles.css` оглянуто лише для перевірки inheritance. Його кастомні браузерні кольори, бульбашки, шрифти, анімації й controls не спожиті: upstream-джерела прямо визначають browser-preview як нецільовий evidence-інструмент.

## Design Brief

`Personal Consultant` має відчуватися як приватна, спокійна й доказова ділова розмова в нативній E2EE Element/Matrix-кімнаті та як стримана безпечна utility-поверхня, коли Власник відкриває `Налаштування власника`. Спільний принцип — deliberate restraint: виразність витрачається на рішення, критичну межу, identity/access, сумісність, фактичний статус і наступну дію, а не на декоративний бренд-шар.

`SUR-01` успадковує Element і володіє лише content choreography. `SUR-02` є єдиним web-винятком: одна responsive сторінка з рівно трьома групами, ясним identity/access status, current/default/effective значеннями, compatibility/status патернами, атомарним Save/Reset і повідомленням про незмінний snapshot Активної сесії. Google sign-in належить Cloudflare Access; продукт стилізує лише authenticated settings і безпечні denied/status результати, де це застосовно.

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
| `DB-D15` | Cloudflare Access володіє Google sign-in presentation; product-owned design починається після grant і обмежується safe status result за deny | Confirmed: `SG-01`, `SS-30`–`SS-34` |
| `DB-D16` | `SUR-02` бере семантичну палітру з HappyPro Academy: navy, blue, pale blue, berry та amber focus | Confirmed: явне доручення Власника; значення з актуального CSS `happypro.academy` від 16.08.2026. `SUR-01` лишається нативною Element-поверхнею |

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
| Settings security utility | Одна сторінка, явний identity/access status, три групи, validation і atomic actions | Не чат, dashboard, sidebar, cards-in-cards чи admin console |
| Settings access | Google sign-in UI належить Cloudflare Access; продукт показує authenticated identity/status або safe denial | Без password/OTP/magic link/іншого IdP, credentials чи Subscription OAuth fields |
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

`SUR-02` завжди зберігає односторінкову ієрархію: identity/access → current/default/effective → рівно три групи → compatibility/status → atomic actions → active-session notice. Групи розділяються `space.settings-section`, а не cards-in-cards, sidebar чи dashboard grid.

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
| `P-11` | Settings identity/access strip | `surface.section` + `type.meta`; підтверджена identity і safe access status без policy secrets чи provider credentials |
| `P-12` | Settings group | Один заголовок, коротке пояснення, label/control/status у `surface.settings`; рівно три такі групи без nested cards |
| `P-13` | Current/default/effective distinction | Три текстово підписані трактування з різною вагою, але без color-only meaning |
| `P-14` | Compatibility / operation status | `type.label` + явний status text; inline error біля джерела і один page-level atomic result |
| `P-15` | Atomic action area | Одна головна Save-дія, окрема Reset-дія з підтвердженням і помітне `focus.ring`; success/failure належить усьому набору |

### Visual Do's And Don'ts

Do:

- починати повідомлення з рішення, межі, ролі або фактичного статусу;
- використовувати короткі абзаци, нативні списки й selective emphasis;
- робити кожне повідомлення Фінальної рекомендації самодостатнім;
- зберігати зрозумілий plain-text fallback, якщо format markers не відобразилися;
- відділяти роль і `HH:MM` від body одним стабільним патерном;
- для нового agent-authored content віддавати перевагу списку над широкою таблицею.
- в settings завжди називати identity/access, current/default/effective, validation і atomic result текстом;
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
- додавати credential fields, free-text model slug, Claude Fast Mode, API/PAYG/credits, sound/motion або per-agent/per-unit controls;
- стилізувати Cloudflare Access Google sign-in як product-owned screen.

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
- Ієрархія `SUR-02` стабільна: identity/access → values → три групи → validation/status → Save/Reset → active-session notice.
- Google sign-in і initial Access denial належать Cloudflare Access; authenticated settings і safe product status не імітують login flow.

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
| `P-11` | Settings identity/access strip | Показує лише підтверджену Google identity й safe access status; не приймає credentials і не подає Google-вхід як Subscription OAuth |
| `P-12` | Settings group | Зберігає рівно три границі; labels пов'язані з controls програмно, довгі значення переносяться, довільний model input відсутній |
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
| `SS-28` Передзапусковий subscription auth/quota/private preflight | За успіху невидимий: немає нового `P-01`, spinner, typing, login або credential prompt | Перед кожним model call і запуском залежного агента підтверджує subscription OAuth mode, квоту, відсутність API/PAYG credentials і single-owner eligibility: один захищений Codex OAuth-стан обслуговує окремі реальні sessions/threads, Claude Code-критик проходить subscription setup-token preflight; успіх веде до `SS-09`/`SS-10`, будь-яка невідповідність — до `SS-29` |
| `SS-29` Fail-closed auth/quota/private boundary | Critical `P-04` у `SUR-01`: безпечна категорія причини, відомий provider reset і позачатова наступна дія; без token, `auth.json`, setup-token, reauth URL/code, link або credential field | Жодного model call чи agent launch і жодного API/PAYG/credits fallback; після provider reset або provider-managed reauth поза Matrix — новий `SS-28`, інакше exit/неповний результат |
| `SS-30` Settings entry | Нейтральний utility context без chat/dashboard chrome | Перехід до Cloudflare Access-owned Google sign-in; product login controls відсутні |
| `SS-31` Access loading | `P-11` loading/status без protected values | Grant або safe deny; keyboard/screen-reader status оголошено без animation-only meaning |
| `SS-32` Access granted | `P-11` з підтвердженою owner identity | Завантажити versioned settings; Google identity не видається за Subscription OAuth |
| `SS-33` Access denied | Одна safe permission boundary без settings values і policy secrets | Лише повторний дозволений Google-вхід або exit; без fallback |
| `SS-34` Settings loading | `P-11`–`P-14` у loading/read-only state; placeholders не видаються за current | Save/reset unavailable до цілісного load і validation |
| `SS-35` Loaded | `P-12`–`P-15`: рівно три групи, current/default/effective і status | Change, reset або exit; Save unavailable без dirty valid set |
| `SS-36` Dirty valid | Changed status біля джерела й позитивний `P-14` текст | `P-15` Save доступний; cancel повертає loaded state |
| `SS-37` Incompatible | Inline error біля несумісного control і page status; не color-only | Save і нова сесія fail closed; без silent downgrade |
| `SS-38` Drift/provider unavailable | Persistent `P-14` warning/error з чітким наслідком | Свіжа validation або exit; current і active effective не мутують |
| `SS-39` Atomic save in progress | `P-15` і status region показують збереження всього набору | Repeated submit unavailable; selected values видимі; результат лише whole-success або whole-failure |
| `SS-40` Save success | `P-14` success текст для всього набору; changed markers очищені | Current оновлено для нових сесій; active snapshot незмінний |
| `SS-41` Save failure | `P-14` error явно каже, що жодну групу не змінено | Reload/fix/retry після свіжої validation; без partial write чи false success |
| `SS-42` Reset confirmation | Фокусована permission boundary називає всі три групи і наслідок | Confirm/cancel мають однозначний keyboard focus order |
| `SS-43` Reset result | Whole-set success або `SS-41` failure; без partial status | Default стає current лише після atomic success і лише для нових сесій |
| `SS-44` Active snapshot notice | `P-13`/`P-14` помітно розрізняють current і active effective | Не пропонує live apply; exit до Element або повернення до loaded state |
| `SS-45` Offline | Persistent text status; stale values позначені, Save/Reset не мають success styling | Після online — свіжі Access/config checks; без partial write |
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
- Відкрити protected settings URL і пройти Cloudflare Access-owned Google sign-in.
- Вибрати окремі allowlisted Codex і Claude моделі, спільну глибину міркування й orchestration preset швидкості.
- Атомарно зберегти dirty valid set, скасувати локальні зміни або після підтвердження повернути весь набір до default.
- Відкрити Element або закрити settings; bot-link не є передумовою.

### Accessibility Floor

1. Product-authored content відповідає WCAG 2.2 AA за принципами, які продукт контролює: змістовий порядок, зрозумілі labels, відсутність color-only meaning, читабельний plain-text fallback, meaningful link text і однозначні errors/permissions.
2. Нативний шрифт і його масштабування не перевизначаються. Prototype evidence має перевірити збереження змістової ієрархії зі збільшеним текстом, VoiceOver на iPhone/Mac і TalkBack на Samsung Flip7/Android; Windows desktop flow перевіряється з keyboard navigation і доступним screen reader.
3. Роль, час, статус, ризик і потрібна дія мають бути вимовними як звичайний текст. Emoji, punctuation art або typographic emphasis не є єдиним label.
4. У повідомленні з довгим body використовуються короткі абзаци й справжня послідовність списку. Ручні колонки та таблиці не є preferred authoring pattern, бо нестабільно переносяться й читаються screen reader; уже підтверджене тіло не змінюється.
5. Технічний content має текстову назву й контекст. Monospace не є єдиною ознакою того, що фрагмент потрібно скопіювати або виконати.
6. Критичний стан зрозумілий без motion; `P-09` не змінює його змісту.
7. Native controls успадковують target size, focus і input behavior Element/ОС. Brief не заявляє їхню відповідність без тесту поточних клієнтів.
8. Не використовувати images of text для product-authored відповідей. Якщо input image або PDF недоступний для аналізу, стан пояснюється текстом, не вгадується з thumbnail.
9. `SUR-02` має WCAG 2.2 AA як floor: семантичні заголовки й labels, повна keyboard navigation, видимий `focus.ring`, програмне пов'язання errors з controls, status region для async result і відсутність color-only meaning.
10. Interactive targets у `SUR-02` мають не менше 24×24 CSS px за WCAG 2.2 AA; для primary touch actions на 390/430px ціль — 44×44 CSS px або еквівалентна доступна зона.
11. Під час 200% text zoom не зникають identity, три settings-групи, current/default/effective, validation, Save/Reset або active-session notice; horizontal scrolling не потрібен для основного content.

### Key Flow Implications

| Journey source | Success coverage | Failure / permission coverage |
|---|---|---|
| `docs/user-journey.md`: Stages 1–4, доступ, дані й прийняття | `SS-08` через `P-01` | `SS-02`, `SS-04`–`SS-07`, `SS-25`–`SS-27` через native Element states і `P-03`/`P-04`; Секрет не повторюється |
| Stage 5 і Stage 6A, Пряма відповідь | Невидимий успішний `SS-28`, потім `SS-09` і за підтвердженої цілісності `SS-21` | `SS-29` fail closed без model call, credential UI чи paid fallback; general `SS-19` відділяє невідоме й наступну перевірку; fake consilium відсутній |
| Stage 6B, Повний Консиліум | Успішний `SS-28` перед кожним залежним model call/agent launch; `SS-10`–`SS-12` через roster, `P-02`, `P-05`, `P-09`; потім `SS-20` | `SS-29` показує safe same-room status і позачатову recovery-дію; заміна/очікування через `P-04`; понад 10 хвилин — `SS-17`; недоступний консиліум — `SS-19` |
| Stage 7, втручання Власника | `SS-13`/`SS-14` повертають до контексту; `SS-15`/`SS-16` дають контрольований exit/restart | Пізні репліки після `Стоп` не публікуються; контексти після `Нова задача` не змішуються |
| Stages 8–9, збій, час і Фінальна рекомендація | `SS-20` через `P-06`/`P-07` | `SS-17`–`SS-19` і `SS-29` через `P-03`/`P-04`; OAuth reauth відбувається лише поза Matrix, зовнішня дія не виконується з самої рекомендації |
| Stage 10, Архів, експорт і видалення | `SS-21`, `SS-22`, `SS-24` через `P-10` | `SS-23` потребує повторного дозволу; окрема репліка не редагується й не видаляється |
| Settings S1–S2, access і load | `SS-30`–`SS-35` через `P-11`–`P-14`; authenticated identity та повний current/default/effective set | `SS-33`, `SS-38`, `SS-45`: без protected values, іншого login fallback чи stale-as-current |
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

## Design Handoff Prompt

Реалізувати затверджену інтегровану revision `B — Дослівний консиліум v2`, яка разом покриває Matrix-native `SUR-01` і secure settings `SUR-02`.

Обов'язково:

- зберегти `MG-01`–`MG-13`, `SG-01`–`SG-05`, `SS-01`–`SS-46` і всі двоповерхневі sequences з `docs/wireframes.md`;
- показати representative narrow і desktop viewports, long verbatim agent reply, role/time identity, permission, progress, `SS-29` safe same-room failure і final series; успішний `SS-28` лишити невидимим;
- використати лише перевірені нативні text-formatting і Matrix reply affordances Element/Matrix та current-client chrome як контекст, не як нову product-owned system;
- не створювати browser chat/dashboard, custom Element bubbles/composer або shared app-shell; `SUR-02` лишати one-page secure utility без sidebar, cards-in-cards чи advanced controls;
- показати в `SUR-02` identity/access status, current/default/effective, три групи, inline/global compatibility, atomic Save/Reset і active-session snapshot notice на всіх п'яти viewports;
- не стилізувати Cloudflare Access-owned Google sign-in; не додавати credentials, arbitrary model text, Fast/PAYG/credits, sound/motion або per-unit controls;
- не створювати login/reauth screen, credential/link/code field або API/PAYG/credits fallback; `SS-29` містить тільки safe category, відомий reset і текстову інструкцію завершити provider-managed reauth поза Matrix;
- показати `Витрати` як місячні платежі AI-підписок, фактичну інфраструктуру й доступний usage/limit/reset; usage сесії — `входить у підписку`, недоступне — `невідомо`, без per-session token charge;
- не скорочувати й не перефразовувати representative registered agent body;
- зберегти затверджений baseline нижче; кожна user-visible production реалізація має перевірятися проти нього, а не проти старих v1-кандидатів.

## Approved Visual Baseline

- Status: approved
- Baseline ID: `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`
- Selected Candidate And Version: `B — Дослівний консиліум v2` — Matrix-native `SUR-01` + HappyPro-palette `SUR-02`
- Immutable Visual Target Reference And Hash: `forge/design/candidates/candidate-b/v2`; `96b91ba9622f8301809ed10ef661a313006e0c2743712912c624edc36a2ca8eb`
- Frozen Prototype Source Root And Tree Hash: `forge/design/candidates/candidate-b/v2`; `96b91ba9622f8301809ed10ef661a313006e0c2743712912c624edc36a2ca8eb`
- Prototype Artifact References: `index.html`, `styles.css`, `app.js`, `validate.mjs`; `forge/design/evidence/candidate-b/v2/visual-qa.json`; four screenshots under `forge/design/evidence/candidate-b/v2/`
- Visual Definition Of Done Scope: повна відповідність цій revision для `SUR-01` і `SUR-02`: Matrix-native content choreography, повний дослівний body, роль/`HH:MM`, safe states, settings one-page hierarchy, HappyPro palette, keyboard/focus, responsive order; старі v1-кандидати не є visual target
- Covered Screens States And Viewports: `SUR-01`–`SUR-02`, `MG-01`–`MG-13`, `SG-01`–`SG-05`, `SS-01`–`SS-46`, `390/430/768/1280/1440px`
- Approval Receipt: явне повідомлення Власника 16.08.2026: «ОК. Закрий хром і продовжуй розробку» після перегляду Candidate B v2
- Approved At: `2026-08-16T02:22:48+0300`
- Permitted Variance: нативні відмінності Element/ОС допускаються лише як platform variance; product behavior, повнота body, порядок, роль, Matrix reply semantics і state meaning не змінюються
- Operator Overrides: палітра `SUR-02` має походити з `happypro.academy`; браузерні спеціальні звуки не дозволені
- Supersedes: попередні WhatsApp `A/B/C v1` як поточний design target; їхні source/evidence артефакти лишаються незмінними історичними записами
- Superseded By: none
- Downstream Invalidation: architecture, DoD/evals, QA checklist і development plan мають послатися на цей Baseline ID та hash перед виконанням user-visible implementation units

## Validation Report

### Pass 1 — Mechanical coverage

`0 findings`.

- Key-flow coverage: 6/6 journey groups мають success і failure/permission pattern із названим джерелом.
- Token resolution: кожен token reference у brief визначено один раз у `Design Tokens`; unresolved token references — 0.
- Pattern closure: `P-01`–`P-15` мають appearance і behavior principles — 15/15.
- Screen/state coverage: `SUR-01`–`SUR-02` — 2/2; `MG-01`–`MG-13` — 13/13; settings-групи `SG-01`, `SG-02`, `SG-03`, `SG-04`, `SG-05` — 5/5; `SS-01`–`SS-46` — 46/46 через state-pattern contract.
- Direction inventory: активний approved baseline — один, Candidate B v2; historical superseded набір містить рівно три candidates `A/B/C v1`. Нові A/C не вигадані після явного вибору Власника.
- External references: актуальні official Element, Matrix, WCAG, Apple і Android platform sources доступні; недоступних load-bearing visual references немає.

### Pass 2 — Judgment

`0 findings`.

- Bloat: custom pixel specs, decorative palette, parallel design system, re-stated wireframe layouts і implementation tasks відсутні.
- Inheritance: нативна система Element/Matrix явно успадкована; `consilium/live/styles.css` явно відхилено як product design source.
- Shape: Design Spine визначає presentation, Experience Spine — behavior; product scope і state inventory не переозначені.
- Generic-AI critique: обраний Candidate B має продуктово специфічний signature rhythm — фактична адресована репліка, роль, `HH:MM`, native Matrix reply і канонічний порядок — а не випадкову палітру чи decorative styling.
- Unresolved-content marker scan: 0 markers; proposed-baseline fields мають явні причини відсутності approval metadata.

## Confirmed Design Decisions

- V1 має рівно дві поверхні: приватну Element/Matrix-кімнату `SUR-01` і вузькі responsive `Налаштування власника` `SUR-02`.
- Нативний Element/ОС володіє chrome, кольором, шрифтом, повідомленнями, delivery/offline indicators, composer, notification sounds, accessibility і motion.
- Product design володіє content hierarchy, message choreography, role/time identity, readable formatting і state meaning.
- Повна Підтверджена репліка агента не скорочується, не згортається, не редагується й не очищується після реєстрації.
- Фінальна рекомендація — окремі самодостатні повідомлення: рішення, до трьох дій, ризик/припущення/умова перегляду, Технічна частина лише за потреби.
- Critical meaning завжди явний у тексті й не залежить лише від appearance або motion.
- Candidate B «Дослівний консиліум v2» є Approved Visual Baseline для інтегрованих `SUR-01` + `SUR-02`.
- `SUR-02` — стримана system-like one-page utility з трьома групами, current/default/effective, compatibility status, atomic Save/Reset і active-session snapshot notice.
- Успішний `SS-28` невидимий; `SS-29` fail closed і показує лише safe category, відомий reset та provider-managed reauth поза Matrix, без credential/link/code fields і без API/PAYG fallback.
- `Витрати` показують налаштовані місячні платежі за ChatGPT/Codex і Claude, фактичну інфраструктуру та доступний usage/limit/reset; usage сесії входить у підписку, а недоступне позначається `невідомо`.

## Rejected Directions

- Будь-який browser chat, live-preview, dashboard, archive-browser, cost panel або consent-center; `SUR-02` — єдиний web-виняток і не є жодним із них.
- Custom Element chrome, theme, bubble, header, composer, button, quick reply, card, badge або role avatar.
- Успадкування browser-specific styles із `consilium/live/styles.css`.
- Product-added transcript summary, accordion, collapse або reader-screen замість повного body.
- Custom spinner або typing animation.
- Login/reauth screen, OAuth/setup-token/`auth.json` input, reauth link/code у Matrix або API/PAYG/credits upsell/fallback.
- Вигадана per-session token charge, budget-limit visualization або автоматичні usage credits для subscription usage.
- Будь-яку нову візуальну revision без нового цілісного approval receipt; чинний Baseline ID не змінюється мовчки.
- Попередні WhatsApp `A/B/C v1` як актуальний visual target; вони лишаються лише immutable superseded historical evidence.

## Out Of Scope

- Нові функції, ролі, screens, routes, message groups, states, input types або паралельні Сесії.
- Точний final copy для кожного сценарію та intent-словник непідтверджених команд.
- Архітектура `matrix.org`, Cloudflare, A2A, agent execution, archive, keys, queues, retries, delivery і cost accounting.
- QA steps, implementation tasks, code, browser chat або browser evidence UI; custom frontend дозволений лише в межах authenticated `SUR-02`.
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
