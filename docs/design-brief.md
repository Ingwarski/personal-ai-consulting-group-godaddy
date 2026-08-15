# Design Brief

- Продукт: `Personal Consultant`
- Версія brief: V1, до цілісного design-затвердження
- Статус: proposed
- Дата: 15.08.2026
- owner_invocation_id: `d2347c59-79df-4df6-998c-a9daa04ff987`

## Source References

Порядок джерел відповідає `docs/guardrails.md`. Цей brief не змінює продуктову поведінку, перелік станів або структуру wireframes; він визначає presentation- і interaction-контракт для вже підтвердженої єдиної поверхні `SUR-01`.

| Джерело | SHA-256 / статус | Спожиті фрагменти |
|---|---|---|
| `README.md` | `d1afdf92181df9e002f9f75678f8ca46083c90bec0a9a33e47535a0593fa1c9c` | Позиціонування; принцип практичного результату; історичний browser-preview лише як нецільовий контекст |
| `docs/product-idea.md` | `bb6392c8762ebad8ad50be8da4cfc69cb925bc59a37fc993d5b75a8900b8ba73` | Позиціонування; Результат для користувача; Основний сценарій; Досвід живого чату; Фінальна рекомендація; Межі V1; Правила даних і доступу; Стандарт швидкості; Критерій готовності V1; Підтверджені рішення |
| `docs/prd.md` | `196af1b75e9a8b89bb581203403cbb9a986c1dca5630639150fa192cd04f01ec` | §3.2–3.4; §4–5; `FR-001`–`FR-036`; `NFR-001`–`NFR-015`; §8–12; `AC-001`–`AC-011` |
| `docs/project-context.md` | `19bc260c395412d5332e7bae62f60e4befea79fcf60b876fdd18db2e19e514c0` | Desired User Outcomes; Platform Targets; Core Scenarios; MVP Boundaries; Out of Scope; Constraints; Assumptions; Risks; Open Questions |
| `docs/canonical-terms.md` | `e9555a092cd994ec120013b62ac79615ac2f85b45c4180b1b1e9c505b82d105f` | Ролі; Core Domain Objects; User Actions; Product States; Screen / Flow Names; Approved User-Facing Terms; Internal Terms; Synonyms to Normalize; Terms to Avoid; Open Vocabulary Questions |
| `docs/guardrails.md` | `64a1e0998ac811202d96de532a04b70912a2ed6ad288295d1f4ffbb0f6d559db` | Source Of Truth Order; AI Autonomy Boundaries; Forbidden Changes; Scope Boundaries; Design Authority Rules; Conflict Resolution; When To Ask; When To Stop; Artifact Separation Rules; Verification Rules; Evidence Requirements; Open Questions |
| `docs/user-journey.md` | `a9b39c4102c2715622a77973069eb0adbc722a04382083e1f975cc72b880a7d3` | Journey Overview; Journey Stages 1–10; Climax Beat; Decision Points; Friction And Risks; Failure Path; Exit Points; Success State; Confirmed Facts And Constraints; Open Questions |
| `docs/screen-map.md` | `36b6c720adc3edb819027610e5eecbbdd05d987670b096e9bc2e4e3759a0e786` | `SUR-01`; `MG-01`–`MG-13`; Surface Closure Matrix; Route Map; Navigation Model; Journey-To-Screen Trace; `SS-01`–`SS-27`; загальні state-категорії; Transition Notes; Entry And Exit Points; Edge Paths; Out Of Scope Screens; Open Questions |
| `docs/wireframes.md` | `b078bdcaf96b7f0f5fc822e842ae3339c93d3816875e8396b4df3a48eff37e83` | Wireframe Principles; оборотні структурні рішення; `SUR-01` blueprint; conversational sequences A–F; Responsive Structure Notes; `MG-01`–`MG-13`; Permission pattern; Atomic agent-reply pattern; `SS-01`–`SS-27`; structural variants; Content Priority Notes; Open Questions |

Актуальні платформні джерела перевірено 15.08.2026:

- [Element Support: The Middle Panel](https://docs.element.io/latest/element-support/quick-start-guide/the-middle-panel/) — офіційна довідка про нативні message, composer, formatting, reply, attachment і thread affordances Element.
- [Matrix Client-Server API v1.19](https://spec.matrix.org/v1.19/client-server-api/) — офіційний контракт `body`/`formatted_body`, rich replies і client-specific fallback/rendering.
- [Element Download](https://element.io/download) — офіційне джерело підтримуваних desktop і mobile клієнтів.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) — базова accessibility-ціль для змісту й майбутніх design-evidence артефактів.
- [Apple Human Interface Guidelines: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility/) і [Android Developers: Make apps more accessible](https://developer.android.com/guide/topics/ui/accessibility/apps) — системне масштабування тексту, screen-reader use, контраст і нативні елементи керування мають перевірятися на відповідних клієнтах.

`consilium/live/styles.css` оглянуто лише для перевірки inheritance. Його кастомні браузерні кольори, бульбашки, шрифти, анімації й controls не спожиті: upstream-джерела прямо визначають browser-preview як нецільовий evidence-інструмент.

## Design Brief

`Personal Consultant` має відчуватися як приватна, спокійна й доказова ділова розмова в нативній E2EE Element/Matrix-кімнаті. Дизайн витрачає виразність на змістову ієрархію — рішення, конкретну роль, критичну межу, фактичний статус і наступну дію — та свідомо не витрачає її на новий chrome, декоративний бренд-шар або імітацію окремого застосунку.

Єдиний design surface — `SUR-01`. Product-owned presentation складається з:

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
| `DB-D06` | Candidate B «Дослівний консиліум» є обраним content/UX-напрямом; Matrix-native rendered candidate ще не затверджено | Confirmed direction: explicit operator decision; visual baseline лишається proposed до окремого whole-design approval |
| `DB-D07` | Не успадковувати `consilium/live/styles.css` | Confirmed scope cut: це browser evidence, а не продуктова поверхня V1 |
| `DB-D08` | WCAG 2.2 AA є floor для product-authored content і prototype evidence; conformance нативного Element chrome не приписується продукту | Confirmed boundary: content контролює продукт, chrome — Element/ОС |
| `DB-D09` | Попередні WhatsApp-кандидати `A/B/C v1` та їх evidence незмінні, але superseded і не є поточним visual target | Confirmed: Design Authority Rules; актуальний target — Matrix-native Candidate B |

## Audience And Context

Єдиний користувач V1 — Власник. Він працює з практичними бізнесовими, фінансовими, управлінськими, продуктовими, маркетинговими й продажними задачами та переходить між Mac, iPhone, Samsung Flip7/Android і Windows PC. Повсякденний досвід не повинен вимагати технічної підготовки, окремого browser UI або розуміння внутрішньої оркестрації агентів.

Інформаційна щільність нерівномірна за природою продукту: системні статуси й Фінальна рекомендація мають бути короткими, а Підтверджена репліка агента може бути довгою і завжди залишається повною. Design-контракт не розв'язує цю напругу приховуванням; він робить довгий потік сканованим через стабільну роль, порядок, абзаци, списки та сильний початок повідомлення.

## Product Experience Goal

Власник у будь-якому підтримуваному клієнті має швидко відповісти на три питання:

1. Що зараз відбувається і чи потрібна від мене дія?
2. Хто саме говорить і наскільки твердження підтверджене?
3. Яке рішення або наступна перевірка випливає з роботи?

Критерій досвіду: навіть якщо нативне форматування, колір або ширина бульбашки відрізняються між клієнтами, хронологія, роль, статус, критична межа й наступна дія залишаються однозначними в самому тексті.

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

Наступний design-evidence артефакт має бути Matrix-native rendered candidate цього напряму з покриттям `SUR-01`, `MG-01`–`MG-13` і `SS-01`–`SS-27`. Сам вибір напряму не є approval receipt. Попередні WhatsApp-кандидати `A/B/C v1` та їх evidence лишаються незмінними історичними артефактами зі статусом superseded.

### Colors

Кольори повністю визначає активний клієнт Element через `surface.chat`, `surface.message`, `color.content`, `color.secondary` і `color.status`. Product-authored зміст не задає власну палітру та не використовує колір як єдину ознаку успіху, помилки, ролі або дозволу.

### Typography

Шрифт, базовий розмір, line-height і масштабування визначає клієнт через `type.body`. Ієрархія використовує лише `type.heading`, `type.role-time`, `type.secondary` і `type.code`:

- один короткий `type.heading` на початку product-authored block, якщо без нього важко знайти рішення або межу;
- `type.role-time` перед кожною Підтвердженою реплікою агента;
- `type.secondary` лише для справді підтримувального контексту, не для критичної умови;
- `type.code` тільки для точних команд, ідентифікаторів, короткого inline code або цілісної Технічної частини.

Верхній регістр, decorative Unicode, кілька стилів одночасно й emoji-типографіка не утворюють hierarchy.

### Layout And Spacing

`priority.p0` завжди передує `priority.p1`, а `priority.p2` і `priority.p3` не можуть відсунути критичну межу або рішення нижче. Усередині повідомлення використовуються `space.section` і `space.list`; між самодостатніми частинами Фінальної рекомендації — `space.series`.

Ручні відступи пробілами, центрування, горизонтальні колонки, ASCII-діаграми й decorative separators не використовуються. Довжина рядка, ширина бульбашки, зовнішні відступи та scroll належать Element.

### Elevation And Depth

Лише `elevation.message`, успадкований від Element. Product-authored зміст не додає shadows, layers, overlays, floating controls або card-in-card hierarchy.

### Shapes

Лише `shape.message`, успадкований від Element. Product-authored blocks не імітують badges, pills, buttons, cards або panels за допомогою символів.

### Component Appearance

Нижче `P-01`–`P-10` — content patterns усередині нативної розмови, а не кастомні UI-компоненти.

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

### Visual Do's And Don'ts

Do:

- починати повідомлення з рішення, межі, ролі або фактичного статусу;
- використовувати короткі абзаци, нативні списки й selective emphasis;
- робити кожне повідомлення Фінальної рекомендації самодостатнім;
- зберігати зрозумілий plain-text fallback, якщо format markers не відобразилися;
- відділяти роль і `HH:MM` від body одним стабільним патерном;
- для нового agent-authored content віддавати перевагу списку над широкою таблицею.

Don't:

- проєктувати власний Element header, bubble, composer, menu або theme;
- використовувати browser-preview, `consilium/live/styles.css` або dashboard як design target;
- приховувати довгу репліку за accordion, summary, link або product-added `read more`;
- перетворювати фактично надіслану таблицю чи code block після реєстрації: повне тіло зберігається дослівно;
- передавати critical meaning лише червоним/зеленим, emoji або анімацією;
- використовувати декоративні gradients, blobs, cards, ASCII-art або ручне вирівнювання пробілами.

### Design Tokens

| Token | Value / contract |
|---|---|
| `surface.chat` | Поточна нативна E2EE Matrix-кімната в Element у відповідному клієнті й темі |
| `surface.message` | Нативна message presentation Element; продукт не перевизначає її |
| `color.content` | Нативний primary text color активного клієнта й теми |
| `color.secondary` | Нативний secondary text treatment; не використовується для critical meaning |
| `color.status` | Нативна platform treatment, якщо вона існує; значення завжди дублюється явним текстом |
| `type.body` | Нативна системна типографіка Element, regular, з user-controlled scaling |
| `type.heading` | Нативне selective bold для одного головного label або signal-line |
| `type.role-time` | `Конкретна предметна роль` selective bold + роздільник `·` + час `HH:MM` regular |
| `type.secondary` | Нативна italic або regular secondary фраза; лише для некритичного контексту |
| `type.code` | Нативний inline/monospace treatment Element/Matrix для точного технічного змісту |
| `space.section` | Один порожній рядок між смисловими секціями одного повідомлення |
| `space.list` | Один окремий рядок на пункт без декоративних порожніх рядків між пунктами |
| `space.series` | Нативна межа між двома самодостатніми повідомленнями |
| `shape.message` | Нативна форма повідомлення Element |
| `elevation.message` | Нативна depth/separation behavior Element |
| `motion.message` | Лише нативна поява/доставка/відкриття; product-authored animation відсутня |
| `priority.p0` | Явний текстовий статус або межа на початку + `type.heading`; потребує рішення чи негайної уваги |
| `priority.p1` | Основний результат або фактичний робочий зміст; перша змістова теза перед деталями |
| `priority.p2` | Підстава, причина, контекст або межа впевненості після основного сигналу |
| `priority.p3` | Попередня хронологія або некритичний контекст без доданого акценту |

## Experience Spine

### Foundation

Форм-фактор — одна асинхронна, але під час Консиліуму жива нативна розмова. Головна interaction primitive — нове текстове повідомлення у штатному composer. Product experience не залежить від hover, drag, custom button або browser route.

Основний interaction feel — `visible progress without performance theater`: підтвердження, фактична репліка, пояснення очікування, збій або запит дозволу з'являються як зміст, а не як декоративна анімація.

### Information Architecture Implications

- `SUR-01` має одну хронологію; новий product-owned navigation layer відсутній.
- `MG-01`–`MG-13` зберігають порядок і content hierarchy з wireframes.
- `P-03` і critical `P-04` переривають звичайний потік лише для відповідної межі.
- `P-06` завершує роботу кількома короткими повідомленнями, але не замінює й не редагує попередні `P-05`.
- `Стоп`, `Нова задача` й `Витрати` читаються як точні команди, а не як navigation labels.
- Нативна історія може бути довгою; поточний стан знаходиться за останнім однозначним signal-first block, а не через custom sticky header.

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
| `P-04` | Progress / failure message | Progress повертає до активного потоку; failure називає наслідок і recovery лише за наявності підтвердженої дії |
| `P-05` | Long verbatim agent reply | Публікується повністю; не ділиться, не переказується й не змінюється після підтвердженої реєстрації; client-native collapse не замінюється product collapse |
| `P-06` | Final recommendation series | Завершує стабілізовану роботу; зовнішня або високоризикова дія після рекомендації окремо переходить у `P-03` |
| `P-07` | Technical part | Існує лише за потреби й переноситься цілком; не розсипається на фрагменти між іншими повідомленнями |
| `P-08` | Native attachment and composer | Приймає лише підтверджені V1 inputs; unsupported input переходить у `P-03`/`P-04` без custom control |
| `P-09` | Same-chat delivery | Додає нову видиму репліку до `SUR-01` без створення іншої продуктової поверхні |
| `P-10` | Session / archive control result | Показує фактичний наслідок команди чи архівної дії; не створює окремий dashboard, archive-browser або editable transcript |

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
| `MG-09` | `P-10` | Дві фактичні суми як read-only result; жорсткий ліміт не візуалізується |
| `MG-10` | `P-10` | Однозначний результат `Стоп` або буквальний перехід `Нова задача` |
| `MG-11` | `P-04` | Збій/неповнота, наслідок, підтверджене/невідоме й доступна наступна перевірка |
| `MG-12` | `P-06`, за потреби `P-07` | Рішення → до трьох дій → ризик/перегляд → окрема Технічна частина |
| `MG-13` | `P-10` | Фактичний архівний результат, незмінність попереднього body й допустимий наступний крок |

### State Patterns

Перелік і переходи належать `docs/screen-map.md`; нижче зафіксовано лише appearance/behavior coverage для кожного `SS-01`–`SS-27`.

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
| `SS-14` Витрати показано | `P-10` із двома фактичними сумами й без budget-limit styling | Read-only return до попереднього active/completed context |
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

Загальні стани:

- Empty: product-owned welcome або onboarding block відсутній.
- Hover/focus/active: повністю нативні; продукт не створює власних focusable controls.
- Disabled: заборонена дія пояснюється текстом, а не custom disabled control.
- Loading: `P-01`, `P-02`/`P-05` або `P-04`; custom spinner чи typing indicator не додається.
- Offline/delivery: показує Element; product-authored success не виводиться з візуального індикатора без фактичного evidence.
- Long content: `P-05` лишається повним; якщо клієнт застосовує власне згортання, продукт не додає другий collapse layer.

### Interaction Primitives

- Надіслати текст, зображення або PDF через штатний composer.
- Надіслати звичайне уточнення в межах Активної сесії.
- Ввести точну команду `Стоп`, `Нова задача` або `Витрати`.
- Дати явну текстову згоду чи відмову щодо одного `P-03`; quick replies або buttons не припускаються.
- Прокручувати нативну хронологію та відкривати нативний preview вкладення.
- Запросити архівну дію текстом; точний intent-словник лишається відкритим.

### Accessibility Floor

1. Product-authored content відповідає WCAG 2.2 AA за принципами, які продукт контролює: змістовий порядок, зрозумілі labels, відсутність color-only meaning, читабельний plain-text fallback, meaningful link text і однозначні errors/permissions.
2. Нативний шрифт і його масштабування не перевизначаються. Prototype evidence має перевірити збереження змістової ієрархії зі збільшеним текстом, VoiceOver на iPhone/Mac і TalkBack на Samsung Flip7/Android; Windows desktop flow перевіряється з keyboard navigation і доступним screen reader.
3. Роль, час, статус, ризик і потрібна дія мають бути вимовними як звичайний текст. Emoji, punctuation art або typographic emphasis не є єдиним label.
4. У повідомленні з довгим body використовуються короткі абзаци й справжня послідовність списку. Ручні колонки та таблиці не є preferred authoring pattern, бо нестабільно переносяться й читаються screen reader; уже підтверджене тіло не змінюється.
5. Технічний content має текстову назву й контекст. Monospace не є єдиною ознакою того, що фрагмент потрібно скопіювати або виконати.
6. Критичний стан зрозумілий без motion; `P-09` не змінює його змісту.
7. Native controls успадковують target size, focus і input behavior Element/ОС. Brief не заявляє їхню відповідність без тесту поточних клієнтів.
8. Не використовувати images of text для product-authored відповідей. Якщо input image або PDF недоступний для аналізу, стан пояснюється текстом, не вгадується з thumbnail.

### Key Flow Implications

| Journey source | Success coverage | Failure / permission coverage |
|---|---|---|
| `docs/user-journey.md`: Stages 1–4, доступ, дані й прийняття | `SS-08` через `P-01` | `SS-02`, `SS-04`–`SS-07`, `SS-25`–`SS-27` через native Element states і `P-03`/`P-04`; Секрет не повторюється |
| Stage 5 і Stage 6A, Пряма відповідь | `SS-09` і за підтвердженої цілісності `SS-21` | `SS-19` відділяє невідоме й наступну перевірку; fake consilium відсутній |
| Stage 6B, Повний Консиліум | `SS-10`–`SS-12` через roster, `P-02`, `P-05`, `P-09`; потім `SS-20` | Заміна/очікування через `P-04`; понад 10 хвилин — `SS-17`; недоступний консиліум — `SS-19` |
| Stage 7, втручання Власника | `SS-13`/`SS-14` повертають до контексту; `SS-15`/`SS-16` дають контрольований exit/restart | Пізні репліки після `Стоп` не публікуються; контексти після `Нова задача` не змішуються |
| Stages 8–9, збій, час і Фінальна рекомендація | `SS-20` через `P-06`/`P-07` | `SS-17`–`SS-19` через `P-03`/`P-04`; зовнішня дія не виконується з самої рекомендації |
| Stage 10, Архів, експорт і видалення | `SS-21`, `SS-22`, `SS-24` через `P-10` | `SS-23` потребує повторного дозволу; окрема репліка не редагується й не видаляється |

## Responsive And Platform Behavior

Порядок і hierarchy однакові в усіх клієнтах; responsive contract змінює лише перенесення й доступний простір, не інформаційну архітектуру.

| Evidence viewport | Представляє | Contract |
|---:|---|---|
| `390px` | Вузький iPhone-class viewport | Один стовпець; `P-02` безпосередньо перед `P-05`; жодних manual columns; кожний `P-06` читається окремо |
| `430px` | Wide-phone Android / Samsung Flip7-class viewport | Той самий порядок; довгий role label переноситься природно й не відриває `HH:MM` від body в інший product block |
| `768px` | Проміжний stress viewport | Не створює tablet IA, side panel або двоколонковий transcript; перевіряє line-wrap і збільшений текст |
| `1280px` | Mac або Windows desktop-class viewport | Одна chronology; wider native bubble не є підставою для wide tables, dashboards або додаткової metadata column |
| `1440px` | Wide desktop stress viewport | Той самий content order і density; продукт не заповнює простір декоративним chrome |

На кожному актуальному клієнті окремо перевіряються:

- light/dark appearance й user text scaling, які реально підтримує клієнт;
- selective bold, списки, цитати й inline/monospace treatment, перш ніж вони стануть частиною approved prototype;
- перенесення довгої конкретної ролі та `HH:MM`;
- довгі українські agent replies, посилання й Технічна частина без горизонтальної композиції;
- VoiceOver/TalkBack/desktop keyboard та screen-reader reading order;

## Design Handoff Prompt

Створити Matrix-native rendered candidate обраного напряму `B — Дослівний консиліум` для єдиної приватної E2EE Element/Matrix-кімнати `SUR-01`.

Обов'язково:

- зберегти `MG-01`–`MG-13`, `SS-01`–`SS-27` і conversational sequences з `docs/wireframes.md`;
- показати representative narrow і desktop viewports, long verbatim agent reply, role/time identity, permission, progress, failure і final series;
- використати лише перевірені нативні text-formatting і Matrix reply affordances Element/Matrix та current-client chrome як контекст, не як нову product-owned system;
- не створювати browser product, dashboard, custom bubbles, composer, buttons, cards, colors, fonts або motion;
- не скорочувати й не перефразовувати representative registered agent body;
- не позначати rendered candidate approved. Whole-design approval відбувається лише після явного затвердження Matrix-native інтегрованого прототипу.

## Approved Visual Baseline

- Status: proposed
- Baseline ID: не присвоєно, бо цілісний прототип ще не затверджено
- Selected Candidate And Version: content/UX-напрям `B — Дослівний консиліум` обрано; Matrix-native rendered version ще не затверджено
- Immutable Visual Target Reference And Hash: не встановлено до approval receipt
- Frozen Prototype Source Root And Tree Hash: не встановлено до approval receipt
- Prototype Artifact References: попередні WhatsApp `A/B/C v1` є immutable superseded historical evidence; поточний Matrix-native Candidate B ще не створено або не затверджено
- Visual Definition Of Done Scope: proposed contract цього brief; не є approved visual baseline
- Covered Screens States And Viewports: proposed coverage `SUR-01`, `MG-01`–`MG-13`, `SS-01`–`SS-27`, `390/430/768/1280/1440px`
- Approval Receipt: відсутній; approval не запитувався й не надавався
- Approved At: не застосовується до proposed state
- Permitted Variance: нативні відмінності Element/ОС допускаються лише як platform variance; product behavior, повнота body, порядок, роль, Matrix reply semantics і state meaning не змінюються
- Operator Overrides: немає зафіксованих
- Supersedes: попередні WhatsApp `A/B/C v1` як поточний design target; їхні source/evidence артефакти лишаються незмінними історичними записами
- Superseded By: none
- Downstream Invalidation: none; approved baseline ще не існує

## Validation Report

### Pass 1 — Mechanical coverage

`0 findings`.

- Key-flow coverage: 6/6 journey groups мають success і failure/permission pattern із названим джерелом.
- Token resolution: кожен token reference у brief визначено один раз у `Design Tokens`; unresolved token references — 0.
- Pattern closure: `P-01`–`P-10` мають appearance і behavior principles — 10/10.
- Screen/state coverage: `SUR-01` — 1/1; `MG-01`–`MG-13` — 13/13 через wireframe/pattern contract; `SS-01`–`SS-27` — 27/27.
- External references: актуальні official Element, Matrix, WCAG, Apple і Android platform sources доступні; недоступних load-bearing visual references немає.

### Pass 2 — Judgment

`0 findings`.

- Bloat: custom pixel specs, decorative palette, parallel design system, re-stated wireframe layouts і implementation tasks відсутні.
- Inheritance: нативна система Element/Matrix явно успадкована; `consilium/live/styles.css` явно відхилено як product design source.
- Shape: Design Spine визначає presentation, Experience Spine — behavior; product scope і state inventory не переозначені.
- Generic-AI critique: обраний Candidate B має продуктово специфічний signature rhythm — фактична адресована репліка, роль, `HH:MM`, native Matrix reply і канонічний порядок — а не випадкову палітру чи decorative styling.
- Unresolved-content marker scan: 0 markers; proposed-baseline fields мають явні причини відсутності approval metadata.

## Confirmed Design Decisions

- Єдина поверхня — приватна invite-only E2EE Element/Matrix-кімната `SUR-01`.
- Нативний Element/ОС володіє chrome, кольором, шрифтом, повідомленнями, delivery/offline indicators, composer, notification sounds, accessibility і motion.
- Product design володіє content hierarchy, message choreography, role/time identity, readable formatting і state meaning.
- Повна Підтверджена репліка агента не скорочується, не згортається, не редагується й не очищується після реєстрації.
- Фінальна рекомендація — окремі самодостатні повідомлення: рішення, до трьох дій, ризик/припущення/умова перегляду, Технічна частина лише за потреби.
- Critical meaning завжди явний у тексті й не залежить лише від appearance або motion.
- Candidate B «Дослівний консиліум» обрано як content/UX-напрям; Approved Visual Baseline лишається proposed до явного затвердження Matrix-native rendered candidate.

## Rejected Directions

- Окремий browser chat, live-preview, dashboard, archive-browser, cost panel або consent-center.
- Custom Element chrome, theme, bubble, header, composer, button, quick reply, card, badge або role avatar.
- Успадкування browser-specific styles із `consilium/live/styles.css`.
- Product-added transcript summary, accordion, collapse або reader-screen замість повного body.
- Custom spinner або typing animation.
- Автоматичне перетворення вибору Candidate B на Approved Visual Baseline без Matrix-native rendered evidence та явного approval receipt.
- Попередні WhatsApp `A/B/C v1` як актуальний visual target; вони лишаються лише immutable superseded historical evidence.

## Out Of Scope

- Нові функції, ролі, screens, routes, message groups, states, input types або паралельні Сесії.
- Точний final copy для кожного сценарію та intent-словник непідтверджених команд.
- Архітектура hosted Matrix homeserver, Cloudflare, A2A, agent execution, archive, keys, queues, retries, delivery і cost accounting.
- QA steps, implementation tasks, code, custom frontend або browser evidence UI.
- Зміна нативних налаштувань Element чи операційної системи від імені Власника; власний звук повідомлень.

## Open Questions

1. Яка точна safe visible reaction потрібна для стороннього або непідтвердженого відправника: мовчазна відмова чи повідомлення без захищених деталей?
2. Який lifecycle-термін отримує попередня Сесія після `Нова задача`? До рішення повідомлення лишається буквальним: поточну сесію закрито, нову створено.
3. Чи зберігається Зупинена сесія після `Стоп` в Архіві сесій і з яким статусом?
4. Які точні фрази запускають експорт, видалення цілої Сесії та відмову від цих дій?
5. Які формулювання однозначно є явною згодою або відмовою для кожного `MG-02`?
6. Яка policy-класифікація визначає Особливо чутливий документ?
7. Які current-client відмінності в native formatting, long-message presentation, text scaling і screen-reader reading order виявить prototype/evidence pass на чотирьох цільових клієнтах?
8. Який Matrix-native rendered reference Candidate B буде подано на whole-design approval? До цього Baseline ID, immutable target hash і approval receipt не заповнюються.

Ці питання не блокують proposed design contract, не дозволяють додати нову поверхню або custom chrome і не є pre-prototype approval gate.
