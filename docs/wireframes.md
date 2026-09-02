# Wireframes

- Продукт: `Personal Consultant`
- Версія wireframes: V1
- Дата: 16.08.2026
- owner_invocation_id: `9ba7d59c-efae-40d3-8a85-a6f3496f715a`

V1 має рівно дві користувацькі поверхні: приватну invite-only E2EE Matrix-кімнату `SUR-01` у штатному Element для щоденної консультації та вузьку responsive web-поверхню `SUR-02` для `Налаштувань власника`. Цей артефакт визначає низькодеталізовану структуру, ієрархію, дії та структурні зміни станів обох поверхонь. Він не визначає кастомний Element chrome, фінальний текст, візуальний стиль або технічну реалізацію. Candidate B лишається обраним напрямом для чату; візуальний напрям `SUR-02` ще не затверджено.

## Source References

Порядок джерел відповідає `docs/guardrails.md`. Безпосередня залежність — валідований `docs/screen-map.md` із SHA-256 `5f138005cf9b6c9b347cc8d876bd74f6f9c977503ad6dc53436ccd35e75f0a5b`.

| Джерело | Спожиті фрагменти |
|---|---|
| `README.md` | Початкове позиціонування; принцип практичного результату; історичний browser-preview лише як нецільовий контекст |
| `docs/product-idea.md` | Межі V1; дві поверхні; Element/Matrix Candidate B; Google-only `Налаштування власника`; три settings groups; atomic save; immutable active-session snapshot |
| `docs/prd.md` | §3.2–3.5; §4–5; `FR-001`–`FR-046`; `NFR-001`–`NFR-019`; §8–12; `AC-001`–`AC-016` |
| `docs/project-context.md` | Desired User Outcomes; Platform Targets; Core Scenarios; MVP Boundaries; Out of Scope; Constraints; Assumptions; Risks; Open Questions |
| `docs/canonical-terms.md` | Ролі; доменні об'єкти; дії; продуктові стани; назви потоків; approved/internal terms; нормалізація; Open Vocabulary Questions |
| `docs/user-journey.md` | Consultation Journey Stages 1–10; Settings Journey S1–S5; Decision Points; Failure Paths; Entry And Exit Points; Success States; Confirmed Facts And Constraints; Open Questions |
| `docs/screen-map.md` | `SUR-01`–`SUR-02`; `MG-01`–`MG-13`; `SG-01`–`SG-05`; Surface Closure Matrix; Route Map; Navigation Model; Journey-To-Screen Trace; `SS-01`–`SS-46`; Transition Notes; Entry And Exit Points; Edge Paths; Out Of Scope Screens; Open Questions |
| `docs/guardrails.md` | Source Of Truth Order; AI Autonomy Boundaries; Forbidden Changes; Scope Boundaries; Design Authority Rules; When To Ask; When To Stop; Artifact Separation Rules; Verification Rules; Evidence Requirements |
| `DAS Forge 4` | Лише bounded pattern evidence для typed allowlists, validate-before-save, atomic save, default/reset та effective-value display; не product scope, не четверта група й не конкретний UI |

Скорочення трасування: `PRD` — `docs/prd.md`; `PC` — `docs/project-context.md`; `CT` — `docs/canonical-terms.md`; `UJ` — `docs/user-journey.md`; `SM` — `docs/screen-map.md`; `GR` — `docs/guardrails.md`.

Використані SHA-256: `docs/product-idea.md` — `263a5d15949e2ebf70f9fb4fa8ba67ff1e882cb5ae2774ecf218ccff16586ac5`; `docs/prd.md` — `2d9546dd7b0f4cd25dea0f225ffa35c0819966e3edb9efaa72f781f3fb70d660`; `docs/project-context.md` — `529ee8b70ec81b2a4734cb7580e5bfc84052a9f2552b039cd52bd42dfe4b2fee`; `docs/canonical-terms.md` — `75e8ab94a47faa0f89a51605543f2f643ce9b53c8513d26ee7d5bb54037f26fc`; `docs/guardrails.md` — `54c7ccd20d612e908f1038499c2db101d47e587c141a2d5363e003b2a0dbb3bc`; `docs/user-journey.md` — `e4dfa9801ef0eab241c4b768719732628e37aebb068a8fd8067eeedbe1a6d7cd`; `docs/screen-map.md` — `5f138005cf9b6c9b347cc8d876bd74f6f9c977503ad6dc53436ccd35e75f0a5b`.

## Wireframe Principles

1. **Дві поверхні з різними повноваженнями.** Щоденна консультація, згода, архів, витрати, сповіщення й керування сесіями лишаються тільки в `SUR-01`; `SUR-02` є єдиним вузьким web-винятком лише для трьох груп налаштувань. `[SM: Screen Inventory, Navigation Model]`
2. **Змістовий блок замість кастомного компонента.** Wireframe описує порядок інформації в нативних повідомленнях Element/Matrix, а не нові панелі, форми, картки, меню чи кнопки. `[SM: Out Of Scope Screens; GR: Design Authority Rules]`
3. **Найважливіше — на початку блоку.** Рішення, межа дозволу, збій, фактичний статус або потрібна дія передують поясненню. `[PRD: FR-026–FR-030; UJ: Stages 8–9]`
4. **Одна Підтверджена репліка агента — один незмінний змістовий блок.** Роль і `HH:MM` передують повному тілу; тіло не скорочується, не згортається й не редагується. `[SM: MG-07, Transition Notes 3–4]`
5. **Критична межа перериває звичайний потік.** Запит дозволу, Секрет, команда `Стоп`, збій або непідтверджена цілісність отримують вищий пріоритет за progress-повідомлення. `[SM: MG-02, MG-03, MG-10, MG-11; GR: When To Stop]`
6. **Видимий поступ є змістом, а не індикатором.** Немає custom spinner або progress-screen; до спливу 60 секунд показується агентська репліка чи змістовне пояснення очікування. `[SM: SS-11–SS-12, general state categories]`
7. **Команди не відкривають нову локацію.** `Стоп`, `Нова задача` й `Витрати` вводяться у штатний composer і отримують відповідь у тому самому потоці. `[SM: Navigation Model, Transition Notes 5–7]`
8. **Нативні межі не імітуються.** Invitation, recovery, verification, revocation, доставка, offline-стан, прокручування, Matrix replies, вкладення й сповіщення належать Element/Matrix або операційній системі. Продукт не додає власного звуку. `[SM: general state categories, Transition Notes]`
9. **Candidate B показує фактичну роботу одразу й дослівно.** Кожне фактично надіслане агентське доручення, проміжна репліка, критика або виправлення з'являється після реєстрації повністю, без пакетування до фіналу, від одного Matrix-акаунта бота з конкретною роллю та `HH:MM`. `[SM: MG-07, SS-11; PRD: FR-014–FR-016, FR-034]`
10. **Subscription preflight не є login UI.** `SS-28` передує кожному model call і залежному agent launch, але не показує credential fields. Успіх непомітно продовжує маршрут; `SS-29` додає лише безпечний `MG-11`, а повторний вхід відбувається поза Matrix. `[SM: SS-28–SS-29; GR: When To Stop]`
11. **Google-вхід має окрему вузьку межу.** `SUR-02` відкривається лише через Cloudflare Access Google-вхід exact allowlisted email і валідний Access JWT; він не є Codex/Claude Subscription OAuth і не показує provider credentials. `[SM: SG-01, SS-30–SS-33; GR: Access And Identity]`
12. **Налаштування не змінюють інваріанти консультації.** Три групи керують лише дозволеними моделями, спільною глибиною міркування та orchestration preset швидкості для нових сесій; critic, A2A, E2EE, дослівність, research, safety, privacy і permission guards не мають settings controls. `[SM: SG-02–SG-05, Transition Notes 18–21]`

### Оборотні структурні рішення wireframe

- `MG-02` подається одним самодостатнім блоком у порядку: конкретна межа → навіщо потрібен дозвіл → що станеться без дозволу → прохання про явну відповідь. Точне формулювання відповіді не задається.
- `MG-07` зберігає атомарність кожної репліки; наступна репліка або виправлення завжди додається нижче новим блоком, а адресування показується нативним Matrix reply relationship.
- `MG-12` розкладається на послідовність самодостатніх повідомлень: рішення → до трьох дій → ризик/припущення/умова перегляду → Технічна частина лише за потреби. Це конкретизує вже підтверджений порядок без додавання нового змісту.

## Screen Blueprints

### `SUR-01` — Приватна Element/Matrix-кімната

**Source Screen**

`docs/screen-map.md`: `SUR-01`, `MG-01`–`MG-13`, `SS-01`–`SS-29`.

**Purpose**

Прийняти Запит або команду Власника, провести пряму консультацію чи видимий Консиліум, показати потрібні дозволи й чесні стани, видати Фінальну рекомендацію та підтримати витрати й архівні дії в одному нативному Element/Matrix-потоці. `[SM: Screen Inventory; UJ: Journey Overview]`

**Primary User Intent**

Перетворити практичну проблему на рішення або наступну перевірку, зберігаючи контроль над даними, сесією, дозволами, зовнішніми діями, витратами й архівом. `[PC: Desired User Outcomes; UJ: User Goal]`

**Layout Structure**

Пріоритети: `P0` — критичний; `P1` — основний; `P2` — підтримувальний; `P3` — контекстний. Ієрархія `H1` є найвищою всередині відповідного повідомлення, `H3` — найнижчою.

| Порядок | Зона в хронології | Ієрархія | Пріоритет | Структурний контракт |
|---:|---|---|---|---|
| 0 | Native host-client prerequisite | Нативна | `P0` | Invitation; за потреби recovery + verification або revocation; далі exact access і room-invariant check. Це не продуктовий onboarding і не custom screen |
| 1 | Попередній нативний контекст кімнати | `H3` | `P3` | Існуюча історія Element/Matrix; продукт не додає archive-browser або окрему навігацію |
| 2 | Запит, вкладення або команда Власника (`MG-01`) | `H1` | `P1` | Нативне вхідне повідомлення: текст, зображення, PDF, уточнення або точна команда |
| 3 | Межа доступу, даних або дозволу (`MG-02`/`MG-03`), якщо спрацювала | `H1` | `P0` | Зупиняє лише відповідну дію; не приховує наслідок і не повторює Секрет |
| 4 | Початок і прийняття Сесії (`MG-04`) | `H1` | `P1` | Дата й час старту нової Сесії, підтвердження прийняття до 5 секунд, один активний контекст |
| 5 | Subscription auth/quota/private preflight (`SS-28`) | Системна | `P0` | Без credential UI перевіряє subscription OAuth, quota, private eligibility й відсутність API/PAYG fallback; успіх веде далі, failure додає `SS-29`/`MG-11` |
| 6 | Основний робочий потік (`MG-05` або `MG-06`–`MG-08`) | `H1` | `P1` | Пряма відповідь або склад і повні репліки Консиліуму; progress-пояснення вклинюється тільки за потреби |
| 7 | Керівне втручання (`MG-09`/`MG-10`) | `H1` | `P0` для `Стоп`/`Нова задача`; `P1` для `Витрати` | Команда отримує самодостатній результат; `Витрати` повертає до контексту, `Стоп` або `Нова задача` змінюють маршрут |
| 8 | Збій або неповний результат (`MG-11`), якщо спрацював | `H1` | `P0` | Безпечна категорія → наслідок → підтверджене/невідоме → позачатова recovery-дія або інша наступна перевірка; credentials/codes відсутні |
| 9 | Фінальна рекомендація (`MG-12`) | `H1` | `P1` | Послідовність коротких самодостатніх повідомлень; не більше трьох дій |
| 10 | Архівна відповідь (`MG-13`), за окремим запитом | `H1` | `P1` | Експорт, відмова змінювати окрему репліку, підтвердження або результат видалення цілої Сесії |
| 11 | Штатний composer Element | Нативна | `P0` під час потрібної відповіді | Єдиний вхід для Запиту, уточнення, дозволу, команди й архівної дії; OAuth credentials, reauth URL/code й custom auth controls тут не приймаються |

Базовий low-fi каркас:

```text
┌─ Нативна E2EE Matrix-кімната в Element ─────────────────────┐
│ Попередній хронологічний контекст                           │
│                                                            │
│ Власник — Запит / вкладення / команда              [MG-01] │
│                                                            │
│ Межа або дозвіл, лише якщо потрібні              [MG-02/03] │
│                                                            │
│ Дата й час старту + Запит прийнято                 [MG-04] │
│                                                            │
│ Subscription preflight; без login UI                [SS-28] │
│   failure → безпечний статус, reauth поза Matrix    [SS-29] │
│                                                            │
│ Пряма відповідь                                  [MG-05]   │
│ або                                                        │
│ Склад → повні репліки → поступ                   [MG-06–08] │
│                                                            │
│ Збій / Фінальна рекомендація / архівна дія     [MG-11–13] │
│                                                            │
│ Штатний composer Element: текст або вкладення               │
└────────────────────────────────────────────────────────────┘
```

**Primary CTA**

Надіслати потрібну відповідь у штатному composer: новий Запит, уточнення або явне рішення щодо конкретного дозволу. У стані готового результату головної обов'язкової відповіді немає; наступну дію визначає зміст Фінальної рекомендації. `[SM: Entry And Exit Points; MG-02; MG-12]`

**Secondary Actions**

- `Витрати` — read-only відгалуження з поверненням до поточного контексту.
- `Стоп` — пріоритетне припинення Активної сесії.
- `Нова задача` — закриття поточного контексту й початок нового без змішування.
- Уточнення звичайним повідомленням — продовження тієї самої Активної сесії.
- Експорт або запит видалення цілої Сесії — архівна дія в цій самій розмові; точні фрази залишаються відкритими. `[SM: Navigation Model; Transition Notes 5–7, 13]`

**Inputs And Content**

- Вхідні матеріали: текст, зображення, PDF; інші типи не запускають аналіз.
- У `SUR-01` нативний composer є єдиним полем вводу. Окремих форм, селекторів ролей, меню режиму або settings controls у чаті немає.
- Режим `Пряма відповідь` або `Консиліум` обирає Головний консультант; Власник не проходить окремий wizard.
- Усі вихідні продуктові повідомлення надходять від одного Matrix-акаунта бота; конкретна роль і `HH:MM` містяться всередині повідомлення, а адресованість показує нативна Matrix reply relationship.
- У видимому потоці дозволені зміст Запиту, дата й час старту, конкретні ролі, час `HH:MM`, повні Підтверджені репліки агентів, видимий поступ, рішення, дії, ризики, витрати та архівні результати.
- Заборонені системні інструкції, приховані міркування, журнали інструментів, технічні ID, номери повідомлень, секунди й сирі Markdown-маркери як код чату. `[SM: message-group boundary; CT: Approved User-Facing Terms]`
- OAuth token, setup-token, `auth.json`, OAuth-cache/refresh state, reauth URL/code та API/PAYG credentials не є користувацьким input/content. `SS-29` може показати лише категорію збою, доступний reset і безпечну інструкцію завершити provider-managed reauth поза Matrix.
- Сповіщення, включно зі звуком, якщо він увімкнений Власником, належать лише штатному Element та операційній системі; продуктовий звук або notification-center не створюються.

**States**

`SS-01`–`SS-29`. Їхні структурні дельти наведено в розділі `State Variants`; жоден стан не створює іншої продуктової поверхні.

**Notes For Design Brief**

- Візуальна система продукту обмежена тим, що реально підтримує нативне форматування Element/Matrix; не проєктувати власний Element chrome.
- Майбутня presentation-робота має допомагати відрізняти Власника, системний статус, конкретні предметні ролі, Фінальну рекомендацію та критичну межу лише сумісними з Element/Matrix засобами.
- Повне тіло репліки й канонічний порядок важливіші за компактність; скорочений, accordion- або card-based режим не вводиться.
- Browser-preview може бути лише evidence-засобом і не є design target. `[GR: Design Authority Rules; SM: Out Of Scope Screens]`

### `SUR-02` — Налаштування власника

**Source Screen**

`docs/screen-map.md`: `SUR-02`, `SG-01`–`SG-05`, `SS-30`–`SS-46`.

**Purpose**

Дати єдиному Власнику вузьку responsive web-поверхню, де після дозволеного Google-входу можна переглянути й атомарно зберегти три групи налаштувань для нових сесій. Поверхня не переносить консультацію з Element і не показує чат, архів, витрати, live agent status або admin controls. `[SM: Screen Inventory, Surface Closure Matrix; UJ: Settings Journey S1–S5]`

**Primary User Intent**

Безпечно вибрати сумісні моделі, одну спільну глибину міркування та пресет швидкості, зрозуміти current/default/effective значення й застосувати весь валідний набір однією дією лише до наступної Сесії. `[PRD: US-024–US-029; SM: SG-02–SG-05]`

**Layout Structure**

До access grant (`SG-01`) показується лише entry/loading/denied boundary без protected settings. Після grant сторінка має один послідовний document flow без settings navigation або sidebar:

| Порядок | Зона | Ієрархія | Пріоритет | Структурний контракт |
|---:|---|---|---|---|
| 0 | Google access boundary (`SG-01`) | `H1` | `P0` | Cloudflare Access Google entry/status; exact allowlisted owner email; denied-state не розкриває жодних setting values і не пропонує іншого способу входу |
| 1 | Identity/status header | `H1` | `P0` | Назва `Налаштування власника`; підтверджена owner identity; статус свіжості/доступу; короткий вихід до штатного Element. Жодних Codex/Claude credential, token, setup-token або OAuth-state details |
| 2 | Фактичні значення й межа сесії (`SG-05`) | `H2` | `P0` | Видимі current, default та, якщо є Активна сесія, її immutable effective snapshot; пояснення, що save/reset діє лише для нової Сесії |
| 3 | `Моделі` (`SG-02`) | `H2` | `P1` | Два окремі typed allowlisted selectors: `Codex-агенти` і `Claude Code-критик`; current/default маркери біля кожного; free text та довільний slug відсутні |
| 4 | Provider-specific міркування (`SG-03`) | `H2` | `P1` | Окремі select controls у блоках Codex і Claude Code: «За замовчуванням моделі» плюс тільки фактично підтверджені рівні; provider-specific несумісність пояснюється inline й блокує save без silent downgrade |
| 5 | `Швидкість` (`SG-04`) | `H2` | `P1` | Один вибір `швидко` / `збалансовано` / `ретельно`; біля кожного стислий orchestration impact на pacing/budget, але без послаблення обов'язкових перевірок |
| 6 | Validation summary (`SG-05`) | `H2` | `P0` за помилки, `P1` за valid | Показує валідність усього набору, capability freshness, offline/version conflict і точну групу з помилкою; не перетворюється на fourth settings group |
| 7 | Action row (`SG-05`) | `H1` | `P0` | Primary `Зберегти` виконує одну atomic validated save; secondary `Повернути default` відкриває явне підтвердження; `Скасувати зміни` відкидає лише локальний dirty set |
| 8 | Result/status region (`SG-05`) | `H1` | `P0/P1` | Loading, success або error оголошуються текстом; success підтверджує повний набір і наступну Сесію, error підтверджує незмінність попереднього current |

Desktop low-fi blueprint; дві колонки дозволені лише всередині основного form-flow, коли ширина не послаблює порядок читання:

```text
┌─ Налаштування власника ─────────────────────────────────────────────┐
│ Підтверджено: owner identity        Статус: актуально    [Element] │
│ Google-доступ ≠ Codex/Claude Subscription OAuth                    │
├────────────────────────────────────────────────────────────────────┤
│ Current для нових сесій │ Default │ Effective Активної сесії      │
│ Effective snapshot незмінний; збережене діє з наступної Сесії.    │
├───────────────────────────────┬────────────────────────────────────┤
│ Моделі                       │ Глибина міркування                 │
│ Codex-агенти       [select]  │ [low][medium][high][xhigh]        │
│ Claude Code-критик [select]  │ Codex: effective mapping/status   │
│ current/default позначені    │ Claude: effective mapping/status  │
│                               │ inline incompatibility, якщо є    │
├───────────────────────────────┴────────────────────────────────────┤
│ Швидкість                                                         │
│ ( ) швидко — коротший pacing/budget                               │
│ ( ) збалансовано — базовий pacing/budget                          │
│ ( ) ретельно — ширший pacing/budget                               │
│ Mandatory critic/A2A/E2EE/verbatim/research/safety/privacy сталі. │
├────────────────────────────────────────────────────────────────────┤
│ Validation / save status                                           │
│ [Повернути default] [Скасувати зміни]          [Зберегти]          │
└────────────────────────────────────────────────────────────────────┘
```

Mobile low-fi blueprint з тим самим DOM/read order і без sidebar:

```text
┌─ Налаштування власника ──────┐
│ Owner identity · status      │
│ [Відкрити Element]           │
├──────────────────────────────┤
│ Current / Default            │
│ Effective Активної сесії     │
│ Snapshot notice              │
├──────────────────────────────┤
│ Моделі                       │
│ Codex            [select]    │
│ Claude critic    [select]    │
├──────────────────────────────┤
│ Глибина міркування [select]  │
│ Codex mapping/status         │
│ Claude mapping/status        │
│ Inline validation            │
├──────────────────────────────┤
│ Швидкість                    │
│ ( ) швидко + impact          │
│ ( ) збалансовано + impact    │
│ ( ) ретельно + impact        │
├──────────────────────────────┤
│ Validation / result          │
│ [Зберегти]                   │
│ [Повернути default]          │
│ [Скасувати зміни]            │
└──────────────────────────────┘
```

**Primary CTA**

`Зберегти` доступне лише для dirty-набору, який пройшов свіжу capability validation для обох runtimes. Дія зберігає всі три групи як одну версію або не змінює жодної; під час `SS-39` повторне натискання не створює duplicate/partial write. `[SM: SS-36–SS-41; PRD: FR-043–FR-044]`

**Secondary Actions**

- `Повернути default` → окреме підтвердження `SS-42` → атомарний результат `SS-43`.
- `Скасувати зміни` повертає локальні значення до current без server write.
- `Відкрити Element` або закрити сторінку повертає до щоденної консультації; це не глобальна web-навігація.

**Inputs And Content**

- Рівно три settings groups: `Моделі`, `Глибина міркування`, `Швидкість`. Identity/status, validation, actions і snapshot є службовими зонами `SG-01`/`SG-05`, а не додатковими групами.
- Моделі обираються лише з окремих typed allowlists; поля довільного model slug немає.
- Глибина має один shared value, але показує фактичне provider mapping/status для обох runtimes; невідома чи несумісна capability не замінюється мовчки.
- Швидкість є лише orchestration preset. Вона не означає Claude Fast Mode, API/PAYG, usage credits або вимкнення критика, A2A, E2EE, visible verbatim, research, safety, privacy чи permissions.
- Google identity/status не містить Google token; сторінка не показує й не приймає Codex/Claude OAuth credentials, `auth.json`, setup-token, API keys або reauth codes.
- Password, OTP, magic link, інший IdP, реєстрація, dashboard, чат, архів, admin settings, звук і motion-control відсутні.

**States**

`SS-30`–`SS-46`. Entry/access: `SS-30`–`SS-33`; loading/read: `SS-34`–`SS-35`; edit/validation: `SS-36`–`SS-38`; atomic save: `SS-39`–`SS-41`; reset: `SS-42`–`SS-43`; active snapshot: `SS-44`; offline: `SS-45`; mobile/long content: `SS-46`. Точні структурні дельти наведено в `State Variants`.

**Notes For Design Brief**

- Зберегти вузьку, спокійну single-page hierarchy; не додавати sidebar, tabs, app shell або fourth settings group.
- На достатньо широкому desktop `Моделі` та `Глибина міркування` можуть стояти у двох колонках; порядок читання, inline errors і action/result region лишаються однозначними. На mobile всі зони стають в одну колонку.
- Current/default/effective не кодувати лише кольором. Label, help/error association, focus order, keyboard operation і live status мають бути доступними семантично.
- Candidate B є затвердженим структурним напрямом лише для `SUR-01`; цей low-fi blueprint не є схваленням візуального напряму `SUR-02` або Approved Visual Baseline.

### Conversational sequence A — доступ, дані та прийняття

```text
Native Element invitation
    ├─ новий пристрій → recovery key у нативному Element → verification SS-25
    ├─ втрачений/скомпрометований пристрій → native revocation      SS-26
    └─ готовий verified/non-revoked пристрій
         ↓ exact room_id + owner_mxid і room invariants
         ├─ invariants не підтверджено → без обробки                 SS-27
         ├─ доступ не підтверджено → без агентів/protected data      SS-04
         └─ доступ підтверджено                                      SS-01
              ↓
Власник: Запит / зображення / PDF                                  MG-01
    ├─ немає першої згоди → межа + наслідок + явна відповідь       MG-02
    └─ згода чинна
         ├─ непідтримуваний тип / Секрет → без аналізу              MG-03
         ├─ чутливий документ → окремий дозвіл                      MG-02
         └─ допустимий вхід → дата/час + прийняття                   MG-04
```

Invitation, recovery, verification і revocation — нативні host-client передумови, а не окремі екрани продукту. Структурний пріоритет: довіра до кімнати й пристрою (`P0`) → захист даних (`P0`) → явне рішення Власника (`P0`) → підтвердження прийняття (`P1`). `[SM: Route Map; SS-01–SS-08, SS-25–SS-27]`

### Conversational sequence B — Пряма відповідь

```text
Дата й час старту + прийняття                              MG-04
Subscription OAuth/quota/private preflight                 SS-28
    ├─ fail closed → safe status; reset/reauth поза Matrix SS-29 / MG-11
    └─ success
         ↓
Короткий головний висновок                                  MG-05
Докази або межа впевненості, лише коли потрібні             MG-05
Наступна перевірка або дія, якщо відповідь без неї неповна  MG-05
Фінальна рекомендація, лише для суттєвого action-contract   MG-12
Завершення й Архів сесій, якщо цілісність підтверджено
```

`MG-05` не містить склад, ролі або імітацію Консиліуму. Якщо проста відповідь уже дає достатній результат, дублювати її окремим фінальним блоком не потрібно. `[SM: SS-09 transitions; UJ: Stage 6A]`

### Conversational sequence C — Повний живий Консиліум

```text
Дата й час старту + прийняття                                  MG-04
Subscription OAuth/quota/private preflight                     SS-28
    ├─ fail closed → safe status; reset/reauth поза Matrix     SS-29 / MG-11
    └─ success: one managed Codex OAuth state, separate real sessions;
                Claude subscription setup-token, separate critic process
         ↓
Режим Консиліум + 2–5 конкретних ролей + роль критика          MG-06

Конкретна роль · HH:MM                                         MG-07
Повне незмінене тіло першої репліки — до 30 секунд

Конкретна роль · HH:MM                                         MG-07
↳ нативна Matrix reply relationship до адресованої репліки
Повне незмінене тіло відповіді

Поступ / причина очікування / звуження / заміна — за потреби   MG-08

Claude Code-агент-критик · HH:MM                               MG-07
Повне незмінене тіло критики

Нові підтверджені репліки або завершення                       MG-07
Фінальна рекомендація                                          MG-12
```

Структурні правила:

- перша Підтверджена репліка з'являється до 30 секунд після прийняття Запиту на Консиліум;
- `SS-28` проходить до кожного залежного model call/agent launch; спільний Codex OAuth-стан не об'єднує окремі реальні sessions/threads, а auth/setup-token не стають видимими roster fields;
- auth/quota/private failure переходить у `SS-29`: жодної agent reply, API/PAYG/credits fallback або login-form у Matrix;
- `MG-07` і `MG-08` формують progress-loop без мовчання понад 60 секунд;
- кожна репліка має власні роль і `HH:MM`, але не номер, секунди або технічний ID;
- адресування між агентами показується нативною Matrix reply relationship, без дублювання повного quoted-body у новому custom-блоці;
- виправлення не замінює попереднє тіло, а додається новою реплікою;
- якщо до 10 хвилин Фінальна рекомендація не готова, звичайний потік перериває `MG-02` із причиною та запитом дозволу. `[SM: MG-06–MG-08; SS-10–SS-12, SS-17; Transition Notes 3–4, 8–9]`

### Conversational sequence D — втручання під час Активної сесії

```text
Активний потік
    ├─ звичайне повідомлення → Уточнення → повернення в актуальний режим
    ├─ Витрати             → місячні subscription fees
    │                        + фактична інфраструктура
    │                        + provider usage/limit/reset або «невідомо»
    │                        + AI usage сесії «входить у підписку» → повернення
    ├─ Стоп                → підтвердження припинення → exit
    └─ Нова задача         → поточну сесію закрито, нову створено → new entry
```

`Стоп` і `Нова задача` мають вищий пріоритет за ще не опубліковані робочі повідомлення. `Витрати` не зупиняють основний потік, не створюють ліміту й не вигадують per-session token cost або автоматичну купівлю credits. `[SM: Transition Notes; SS-13–SS-16]`

### Conversational sequence E — Фінальна рекомендація

```text
Повідомлення 1 — Рішення
  H1/P1: один головний висновок
  H2/P2: критична межа впевненості, якщо потрібна

Повідомлення 2 — Дії
  H1/P1: до трьох дій
  H2/P1: для кожної доречної дії — результат, відповідальний, строк,
         ознака виконання, доказ, ризик та умова перегляду

Повідомлення 3 — Ризик і перегляд
  H1/P0: критичний ризик, припущення або невідоме
  H2/P1: умова перегляду чи наступна перевірка

Повідомлення 4 — Технічна частина, лише за потреби
  H1/P1: самодостатній переносний зміст
```

Якщо рекомендована дія є зовнішньою або високоризиковою, після рекомендації потрібен окремий `MG-02`; сам текст рекомендації не є дозволом. `[SM: MG-12, SS-18, SS-20; PRD: FR-026–FR-028, FR-035]`

### Conversational sequence F — архів, експорт і видалення

```text
Завершена сесія в Архіві сесій                              SS-21
    ├─ запит Витрати → subscriptions + фактична інфраструктура
    │                    + provider status/«невідомо» → повернення MG-09
    ├─ запит експорту → повна сесія → архів без змін        MG-13
    ├─ видалити репліку → дія недоступна                    MG-13
    └─ видалити цілу сесію → повторне явне підтвердження    MG-02
                                ├─ ні / немає → архів без змін
                                └─ так → результат видалення MG-13
```

Формат експортованого файла або спосіб доставки не задається цим wireframe. `[SM: archive Route Map; SS-21–SS-24; Open Questions 4–5]`

## Responsive Structure Notes

**`SUR-01` — нативний Element/Matrix**

- Порядок змістових блоків однаковий на Mac, iPhone, Samsung Flip7/Android і Windows PC; wireframe не задає різних desktop/mobile інформаційних архітектур.
- Нативне перенесення рядків, ширина повідомлення, прокручування, Matrix reply preview, preview вкладення й composer належать клієнту Element.
- На вузькому viewport роль і `HH:MM` залишаються перед тілом тієї самої репліки; метадані не відриваються в окремий продуктовий блок.
- Роль, `HH:MM`, критичний стан і потрібна дія мають читатися як текст і не можуть передаватися лише кольором, положенням або піктограмою.
- Довге тіло репліки залишається повним у хронології. Його не замінюють summary, посиланням «ще» або окремим reader-screen.
- Послідовність Фінальної рекомендації зберігається як кілька самодостатніх повідомлень; кожне має бути зрозумілим після нативного перенесення рядків.
- Нові репліки залишаються в тій самій розмові. Власної паралельної поверхні продукт не додає. `[SM: general state categories; Navigation Model; Transition Note 14]`
- Keyboard navigation, screen-reader semantics, масштабування тексту, фокус і нативні стани доставки не перевизначаються продуктом; wireframe вимагає лише зберегти читабельний порядок «роль + `HH:MM` → повне тіло → нативний reply context» у підтримуваних Element-клієнтах.

**`SUR-02` — responsive web-settings**

- Mobile використовує одну колонку в source order: identity/status → current/default/effective → `Моделі` → `Глибина міркування` → `Швидкість` → validation → actions/result.
- Desktop лишається читабельно вузьким; дві колонки допустимі лише для `Моделі` + `Глибина міркування`. Status, snapshot, `Швидкість`, validation та atomic actions займають повну ширину потоку.
- На zoom/reflow значення, help, inline error й effective mapping не роз'єднуються з відповідним label/control. Довгі allowlisted model names і incompatibility explanations переносяться без обрізання або horizontal page scroll.
- Primary/secondary порядок не змінюється між viewport: `Зберегти` є primary; `Повернути default` і `Скасувати зміни` — secondary. На mobile кнопки можуть стати full-width, але reset не набуває візуального пріоритету save.
- Loading, save success/error, offline та denied status оголошуються текстом і семантично; ані колір, ані motion, ані звук не є єдиним носієм стану. `[SM: SS-34–SS-46; PRD: NFR-016, NFR-019]`

## Shared Patterns

### `MG-01`–`MG-13`: внутрішня структура повідомлень

| ID | Послідовність змістових зон | Головна дія або перехід |
|---|---|---|
| `MG-01` | `H1/P1` текст Запиту або команда; `H2/P1` нативне вкладення з доступною службовою інформацією Element | Надіслати; під час Активної сесії звичайний текст є уточненням |
| `MG-02` | `H1/P0` конкретна межа; `H2/P1` причина й істотний наслідок; `H2/P1` що не відбудеться без дозволу; `H1/P0` прохання про явне рішення | Явно дозволити або відмовити лише щодо названої межі |
| `MG-03` | `H1/P0` що не оброблено; `H2/P1` причина категорією без повторення Секрету; `H2/P1` який безпечний вхід можна надіслати далі | Надіслати допустимий матеріал або завершити гілку |
| `MG-04` | `H1/P1` дата й час старту нової Сесії; `H1/P1` підтвердження прийняття; `H2/P2` що Запит належить поточному активному контексту | Дочекатися відповіді або надіслати уточнення/команду |
| `MG-05` | `H1/P1` пряма відповідь; `H2/P2` достатня підстава; `H2/P1` межа впевненості чи наступна перевірка, коли потрібна | Використати відповідь або продовжити уточненням |
| `MG-06` | `H1/P1` режим `Консиліум`; `H2/P1` 2–5 конкретних предметних ролей окремих реальних Codex-сесій/тредів; `H2/P1` окремий Claude Code-агент-критик; `H3/P2` очікуваний наступний видимий крок. Один Codex OAuth-стан і Claude setup-token є preflight facts, а не credential content чи окремі UI fields | Дочекатися першої репліки або керувати сесією |
| `MG-07` | `H2/P1` конкретна роль + `HH:MM`; `H2/P1` нативний Matrix reply context, коли репліка адресована; `H1/P1` повне незмінене тіло; джерела, списки, таблиці або код лише коли вони фактично входять до тіла | Продовження канонічного потоку; виправлення лише новою реплікою |
| `MG-08` | `H1/P1` фактичний status update; `H2/P1` причина; `H2/P1` звуження, заміна або очікувана наступна подія | Повернення до `MG-07` або перехід у `MG-11` |
| `MG-09` | `H1/P1` налаштовані місячні платежі ChatGPT/Codex і Claude; `H1/P1` фактичні infrastructure spend; `H2/P1` provider-reported usage/limit/reset або `невідомо`; `H2/P2` AI usage сесії `входить у підписку`; `H2/P2` без per-session token charge, auto credits чи жорсткого ліміту | Повернення до active/completed context |
| `MG-10` | `H1/P0` результат точної команди; `H2/P1` наслідок для поточної Сесії; для `Нова задача` — буквальне створення нової без перенесення контексту | `Стоп` → exit; `Нова задача` → new entry |
| `MG-11` | `H1/P0` безпечна категорія збою або неповноти; `H2/P1` залежну роботу зупинено; `H2/P1` підтверджене й невідоме; `H2/P1` provider reset, якщо відомий; `H1/P1` reauth лише поза Matrix або інша безпечна дія; `H2/P0` не надсилати token/setup-token/`auth.json`/URL/code і не очікувати API/PAYG/credits fallback | Після reset/out-of-band recovery → свіжий `SS-28`; інакше exit/неповний результат |
| `MG-12` | Окремі повідомлення: `H1/P1` рішення; `H1/P1` до трьох дій; `H1/P0` ризик/припущення/умова перегляду; `H1/P1` Технічна частина лише за потреби | Завершення або окремий дозвіл на конкретну дію |
| `MG-13` | `H1/P1` архівна дія й фактичний результат; `H2/P1` що сталося з Архівом сесій; `H1/P0` потрібне підтвердження або недоступність зміни окремої репліки | Повернення до архіву, підтвердження видалення або exit після видалення |

### `SG-01`–`SG-05`: внутрішня структура settings

| ID | Послідовність змістових зон | Головна дія або перехід |
|---|---|---|
| `SG-01` | `H1/P0` Google access entry/status; `H2/P1` точна owner identity після grant; `H2/P0` safe denied reason category без protected values; чітке відокремлення від Subscription OAuth | Дозволений Google-вхід → settings load; denied → повторити тільки дозволений Google-вхід або exit |
| `SG-02` | `H1/P1` `Моделі`; `H2/P1` Codex typed allowlisted selector; `H2/P1` окремий Claude critic typed allowlisted selector; current/default markers | Валідний вибір → shared validation; unknown/arbitrary value недоступне |
| `SG-03` | `H1/P1` provider-specific міркування; окремий control у кожному provider block; `H2/P1` Codex capability/status; `H2/P1` Claude Code capability/status; `H1/P0` inline incompatibility | Обидва незалежні значення валідні → dirty valid; provider incompatibility/drift → save і нова сесія blocked |
| `SG-04` | `H1/P1` `Швидкість`; три mutually exclusive presets; біля кожного короткий orchestration impact; `H2/P0` mandatory guards unchanged | Вибір змінює лише pacing/budget наступної сесії |
| `SG-05` | `H1/P0` current/default/effective + snapshot notice; `H1/P0/P1` validation/result; primary atomic save; secondary reset confirmation і cancel | Save/reset → whole-version result; cancel → current; active snapshot лишається незмінним |

### Permission pattern

Один `MG-02` стосується лише однієї межі. Якщо одночасно виникли різні межі, кожна потребує окремого рішення; цей wireframe не об'єднує їх у загальний дозвіл. Після відмови відповідна дія структурно позначається як така, що не відбулася; жодного disabled custom control не додається. `[GR: When To Ask; SM: Transition Note 10]`

### Safe out-of-band reauth pattern

Representative low-fi wording, не фінальний copy:

```text
Не вдалося підтвердити доступ за підпискою. Залежну роботу зупинено.
Якщо провайдер повідомив час відновлення, покажіть його; інакше скажіть,
що час відновлення невідомий.
Для повторного входу скористайтеся захищеним способом провайдера поза Matrix,
а потім повторіть запит.
Не надсилайте сюди OAuth token, setup-token, auth.json, посилання або код входу.
API/PAYG і автоматичні usage credits не використовуються як fallback.
```

У повідомленні немає кнопки входу, URL, QR, code field, token input або іншого custom auth UI. Воно не називає невідомий reset time і не просить підтвердити credential у чаті. `[SM: MG-11, SS-29; GR: When To Ask, When To Stop]`

### Atomic agent-reply pattern

```text
Конкретна предметна роль · HH:MM
↳ нативна Matrix reply relationship, якщо повідомлення адресоване
Повне тіло Підтвердженої репліки агента:
- адресована позиція або відповідь;
- факти, аргументи, ризики чи потрібні дані;
- джерела, таблиця або код, якщо вони фактично входять до репліки.
```

Роль і час є єдиними обов'язковими продуктовими метаданими над реплікою; адресованість відображає нативний Matrix reply relationship. `[PRD: FR-015–FR-019; SM: MG-07]`

## State Variants

Для `SS-01`–`SS-29` базовий blueprint — допустимий Запит прийнято в `SUR-01`, нижче доступний штатний composer, а нові блоки додаються хронологічно. Для `SS-30`–`SS-46` базовий blueprint — успішно завантажений authenticated `SUR-02` із current/default/effective values та трьома settings groups. Кожний стан описано як дельту від відповідного baseline.

| ID | Стан | Структурна дельта від базового blueprint | Наступна взаємодія |
|---|---|---|---|
| `SS-01` | Перевірка Matrix-доступу й room/device state | Видимого захищеного змісту ще немає; exact `room_id` + `owner_mxid`, verified/non-revoked device та room invariants перевіряються перед `MG-02`–`MG-13` | До `SS-02`/`SS-03`, `SS-04`, `SS-25`, `SS-26`, `SS-27` або безпечного exit |
| `SS-02` | Очікування Згоди на обробку даних | Активний робочий блок замінено `MG-02`: провайдери → межа згоди → наслідок відмови → явна відповідь | Згода → перевірка даних; інакше обробка не починається |
| `SS-03` | Перевірка вхідних даних | Після `MG-01` немає агентських реплік до завершення перевірки типу, Секрету та чутливості | До `SS-05`–`SS-08` |
| `SS-04` | Exact Matrix-доступ не підтверджено | Жодних захищених зон, архіву чи agent-content; активна Сесія Власника не змінюється; безпечне повідомлення можливе лише без protected details | `SS-25`/`SS-26`, якщо доступна нативна recovery/revocation дія; інакше exit |
| `SS-05` | Непідтримуваний тип | `MG-03` замість `MG-04`: тип не оброблено → аналіз не запущено → допустимі входи | Новий допустимий `MG-01` або exit |
| `SS-06` | Секрет зупинено | `MG-03` не повторює значення: категорія межі → не передано/не зареєстровано → безпечна наступна дія | Новий безпечний `MG-01` або exit |
| `SS-07` | Очікування дозволу на чутливий документ | Документ не переходить у прийняття; `MG-02` містить межу й окреме рішення | Дозвіл → `SS-08`; інакше документ не обробляється |
| `SS-08` | Активна сесія: Запит прийнято | Додано `MG-04` з датою/часом старту й підтвердженням до 5 секунд; agent content і model calls ще відсутні | Після вибору режиму → `SS-28`; доступні уточнення й команди |
| `SS-09` | Пряма відповідь | Лише після успішного `SS-28` додано один самодостатній `MG-05`; відсутні roster і agent-reply блоки | Завершення, `MG-12` за потреби, `SS-29` або чесний partial-state |
| `SS-10` | Формування Консиліуму | Лише після успішного `SS-28` додано `MG-06`: конкретні ролі окремих реальних Codex sessions/threads через один managed OAuth state і окремого Claude Code critic process через subscription setup-token; credential fields не показуються. До 30 секунд нижче має з'явитися перший `MG-07` або чесний status/failure | `SS-11`, `SS-12`, `SS-19` або `SS-29` |
| `SS-11` | Живий дослівний перебіг Candidate B | Повторювані атомарні `MG-07` нижче складу: кожне actual assignment, intermediate reply, critique і correction з'являється одразу й дослівно від одного Matrix-акаунта бота; роль + `HH:MM`; адресованість через native Matrix reply relationship; канонічний порядок | Продовження, команда, дозвіл, фінал, general failure або auth/quota/private failure → `SS-29` |
| `SS-12` | Поступ, очікування або заміна агента | Між agent-reply блоками додано `MG-08`; він не приховує причину чи заміну | Повернення до `SS-11` або `SS-19` |
| `SS-13` | Уточнення Активної сесії | Новий `MG-01` вставлено в поточну хронологію; нижче продовжується оновлений, а не паралельний потік | До актуального режиму `SS-09`–`SS-11` |
| `SS-14` | Облік витрат показано | `MG-09` вклинюється як read-only відповідь: налаштовані місячні ChatGPT/Codex і Claude fees → фактичні infrastructure spend → provider usage/limit/reset або `невідомо` → AI usage сесії `входить у підписку`. Per-session token charge, auto credits і hard limit відсутні; основний контекст не закривається | Повернення до попереднього active/completed context |
| `SS-15` | Зупинена сесія | Після команди додано `MG-10`; усі наступні робочі виходи цієї Сесії структурно відсутні | Exit; архівний статус відкритий |
| `SS-16` | Поточну сесію закрито, нову створено | `MG-10` закриває попередній контекст; наступний Запит починає нову sequence A | Новий entry без перенесення робочого контексту |
| `SS-17` | Очікування дозволу продовжити понад 10 хвилин | Progress-loop перервано `MG-02`: причина → межа часу → наслідок без дозволу → явне рішення | Дозвіл → `SS-11`; інакше робота не продовжується |
| `SS-18` | Очікування іншого окремого дозволу | Після рекомендації чи питання додано `MG-02`, прив'язаний лише до конкретної дії або коучингової межі | Виконується/ставиться лише явно дозволене; інакше межа не переходиться |
| `SS-19` | Збій або неповний результат | Для general agent/evidence failure замість success-структури додано `MG-11`: збій → наслідок → невідоме → наступна перевірка/дія; auth/quota/private failures мають спеціалізований `SS-29` | Recovery лише коли вона підтверджена; інакше exit |
| `SS-20` | Фінальна рекомендація | Робочий потік завершує sequence E; окрема Технічна частина існує лише за потреби | Архів за підтвердженої цілісності або `SS-18` |
| `SS-21` | Завершена сесія в Архіві сесій | У потоці немає редагування минулих блоків; архівні дії починаються новим `MG-01` і отримують `MG-09`/`MG-13` | Витрати, експорт, видалення або без дії |
| `SS-22` | Експорт отримано | Додано `MG-13` і повний експорт; попередня хронологія та архів не змінюються | Повернення до `SS-21` |
| `SS-23` | Очікування підтвердження видалення | Перший запит ще нічого не видаляє; додано `MG-02` із цілою Сесією як об'єктом дії | Підтверджено → `SS-24`; інакше `SS-21` |
| `SS-24` | Цілу сесію видалено | Додано `MG-13` із фактичним результатом; окремі минулі репліки не редагуються як проміжний крок | Exit |
| `SS-25` | Нативне recovery і verification потрібні | Продуктовий потік не починається. Штатний Element відновлює ключі нового пристрою за recovery key і проводить verification; recovery key не з'являється у `SUR-01`, журналі чи агентському контексті | Успіх → `SS-01`; невдача → exit без розшифрування й обробки нових робочих повідомлень |
| `SS-26` | Відкликання пристрою потрібне | Продуктовий потік не починається. Втрачений або скомпрометований Matrix-пристрій відкликається нативними засобами Element/Matrix і не може лишатися production-клієнтом | Відкликано та інший пристрій перевірено → `SS-01`; інакше exit |
| `SS-27` | Room invariants не підтверджено | Жоден робочий блок не додається, доки не підтверджено `matrix.org`, E2EE, invite-only, рівно Власник + бот, no pending invites, history `joined`, no public address/listing, no guests/bridges/widgets і verified devices | Після відновлення → `SS-01`; інакше exit |
| `SS-28` | Передзапусковий subscription auth/quota/private preflight | Після `MG-04` і до кожного залежного model call/agent launch немає нового agent block або auth UI. Система перевіряє subscription OAuth mode, quota, private single-owner eligibility та відсутність API/PAYG credentials; для Codex — один managed-refresh OAuth state без клонів `auth.json`/cache, але окремі real sessions/threads; для critic — Claude subscription setup-token | Успіх → `SS-09` або `SS-10`; unknown/expired/revoked/refresh failure/invalid setup-token/quota exhausted/forbidden credential/third-party or ineligible path → `SS-29` |
| `SS-29` | Fail-closed auth/quota/private boundary | Додано лише safe `MG-11`: категорія → залежну роботу зупинено → відомий reset або `невідомо` → reauth тільки поза Matrix → заборона надсилати token/setup-token/`auth.json`/URL/code → no API/PAYG/credits fallback. Немає agent reply, login form, button або success-state; уже підтверджені репліки незмінні | Provider reset або завершена Власником out-of-band reauth → свіжий `SS-28`; інакше exit/неповний результат |
| `SS-30` | Вхід до `Налаштувань власника` | Базовий protected form ще відсутній; показано тільки назву вузької settings-поверхні й перехід у Cloudflare Access, без chat/dashboard/archive chrome | До `SS-31` |
| `SS-31` | Google-вхід і Access-перевірка тривають | Показано нейтральний loading/access status. Немає settings values, password/OTP/magic-link fields, іншого IdP або Subscription OAuth content | Grant → `SS-32`; denied → `SS-33` |
| `SS-32` | Google-доступ надано | У identity/status header з'являється підтверджена owner identity і safe access status; provider credentials відсутні | До `SS-34` |
| `SS-33` | Доступ до settings відхилено | Form і protected current/default/effective values не рендеряться; одна permission boundary пояснює, що потрібні exact allowlisted email і валідний Access JWT, без розкриття policy details чи іншого login fallback | Повторний дозволений Google-вхід або exit |
| `SS-34` | Завантаження current/default/effective | Identity header лишається; form controls мають loading/read-only стан, а value placeholders не видаються за актуальні дані. Save/reset заблоковані до цілісного versioned load | Успіх → `SS-35`; offline/drift → `SS-45`/`SS-38` |
| `SS-35` | Current/default/effective і три групи завантажені | Повний базовий `SUR-02`: рівно `SG-02`–`SG-04`, видимі current/default і окремий active effective snapshot; validation актуальна; save disabled, поки немає dirty set | Зміна → `SS-36`/`SS-37`; reset → `SS-42`; exit |
| `SS-36` | Dirty valid | Changed markers з'являються біля відповідних controls, current/default лишаються видимими, global validation каже, що обидва runtime mappings сумісні; `Зберегти` доступне | Save → `SS-39`; cancel → `SS-35`; нова несумісність → `SS-37` |
| `SS-37` | Несумісний набір | Inline error стоїть безпосередньо біля problem selector/control; provider mapping/status пояснює несумісність. `Зберегти` недоступне, current та active effective snapshot не змінені; silent effort downgrade відсутній | Виправити → `SS-36`; cancel → `SS-35` |
| `SS-38` | Capability drift або provider unavailable | Верхній validation status і відповідна група показують, що сумісність не підтверджена. Controls можуть лишатися readable, але save і запуск нової сесії з неперевіреним набором fail closed | Свіжа перевірка → `SS-35`/`SS-36`; інакше exit |
| `SS-39` | Atomic save in progress | У status region — `Зберігаємо весь набір`; actions захищені від повторного submit, але selected values лишаються видимими. Немає success до підтвердження whole-version write | Success → `SS-40`; failure/conflict/offline → `SS-41`/`SS-45` |
| `SS-40` | Atomic save succeeded | Один success status підтверджує новий current для всіх трьох груп; changed markers очищені, default/effective visibility збережена; partial-success copy відсутній | До `SS-44`, далі `SS-35` або exit |
| `SS-41` | Atomic save failed | Один error status підтверджує, що жодна група не змінена й попередня version лишається current; form не показує false success, active snapshot незмінний | Reload/fix/retry після свіжої validation або exit |
| `SS-42` | Підтвердження reset to defaults | Inline/modal confirmation називає всі три групи й те, що default стане current лише для нових сесій; `Підтвердити повернення` і `Скасувати` мають однозначний focus order | Confirm → atomic reset/`SS-43`; cancel → попередній form-state |
| `SS-43` | Reset result | Success показує default як новий current для всіх трьох груп; error використовує `SS-41` і зберігає попередню version. Часткового reset немає | Success → `SS-44`; failure → `SS-41` |
| `SS-44` | Повідомлення про active-session snapshot | Біля effective values і в result region явно повторено: активна Сесія використовує незмінний snapshot, а current settings застосуються лише до нової | До `SS-35` або exit до Element |
| `SS-45` | Settings offline | Persistent text status позначає values як несвіжі; save/reset не отримують success, pending operation не вважається завершеною. Після відновлення потрібні нові Access і config validation | Online → `SS-31`/`SS-34`; або exit |
| `SS-46` | Mobile або long-content settings | Усі зони переходять в одну колонку; довгі model names, mapping/status і incompatibility explanation переносяться повністю; labels/errors/actions зберігають association та порядок. Жодної групи чи effective detail не вилучено | Лишається в актуальному `SS-30`–`SS-45` або exit |

### Загальні structural variants

| Категорія | Структура |
|---|---|
| Empty | Продукт не додає welcome- або empty-блок; до першого Запиту видно штатну Element/Matrix-кімнату. Native invitation/recovery/verification/revocation не замінюються власним onboarding. |
| Loading / in progress | `MG-04`, системний `SS-28`, потім `MG-07` або `MG-08`; custom spinner, auth form і credential field відсутні. |
| Error | `MG-03` для вхідної межі або `MG-11` для робочого збою; success-блок не додається. |
| Success | `MG-05`, `MG-12`, `MG-13` або підтверджений архівний стан — залежно від гілки; success не використовується без потрібного доказу. |
| Disabled / action unavailable | Немає custom disabled controls. Структурно відсутня заборонена дія, а повідомлення пояснює межу: без дозволу, після `Стоп`, для Секрету, auth/quota/private fail-closed або для видалення окремої репліки. |
| Permission denied / absent | Після `MG-02` додається наслідок відмови або очікування; відповідна дія не переходить межу й не успадковує дозвіл з іншої гілки. |
| Offline / native delivery | Окремого продуктового повідомлення чи screen немає; мережу, надсилання, доставку та сповіщення показує Element/ОС. Продукт не робить непідтвердженої заяви про отримання й не створює власного звуку. |
| Long content | Репліка лишається повною й атомарною; наступна репліка починається тільки після її повного тіла. Нативне прокручування й Matrix reply context належать Element. Фінальна рекомендація розкладається на короткі самодостатні повідомлення без скорочення агентського transcript. |
| Same-chat delivery | Нова вихідна репліка з'являється в `SUR-01`; окремої продуктової поверхні немає. |
| Settings loading / in progress | `SS-31`, `SS-34` і `SS-39` мають різні status labels; жоден не показує protected values до grant, stale values як current або непідтверджений save як success. |
| Settings error / permission denied | `SS-33`, `SS-37`, `SS-38`, `SS-41` і `SS-45` показують boundary/error text у відповідній зоні; protected values, partial write, silent downgrade й інший login fallback відсутні. |
| Settings success | `SS-40` або success-гілка `SS-43` підтверджують увесь atomic set; `SS-44` окремо фіксує незмінність active effective snapshot. |
| Settings disabled / unavailable | `Зберегти` недоступне без dirty valid set, під час unresolved loading/drift/offline або incompatible mapping; причина доступна текстом, а current values не мутують. |
| Settings mobile / long content | `SS-46` переходить до однієї колонки й повного перенесення тексту; labels, effective mapping, inline errors та actions не втрачаються. |

## Content Priority Notes

1. **`P0`: безпека й контроль.** Доступ не підтверджено; Секрет; subscription auth/quota/private preflight або fail-closed; окремий дозвіл; `Стоп`; `Нова задача`; збій; непідтверджена цілісність; критичний ризик.
2. **`P1`: практичний результат.** Запит, прийняття, пряма відповідь, конкретні ролі, повні репліки, фактичний поступ, рішення, до трьох дій, витрати й архівний результат.
3. **`P2`: пояснення.** Достатня підстава, причина очікування, межа впевненості, контекст фактичного статусу.
4. **`P3`: історичний контекст.** Попередня розмова залишається доступною нативно, але не конкурує з поточною критичною межею чи активною дією.

Для `SUR-02` порядок пріоритету: `P0` access/identity → current/default/effective і active snapshot → inline/global validation → atomic result; `P1` три групи та їхні дозволені controls; `P2` стислі пояснення mapping і orchestration impact. Візуальна компактність не може приховати incompatibility, stale/offline status або незмінність Активної сесії.

Коли простір обмежений, порядок усередині повідомлення не змінюється: результат або межа → дія → наслідок/доказ → додатковий контекст. Повне тіло `MG-07` не скорочується навіть за довгого змісту. `[SM: message contracts, Long content; PRD: FR-016, FR-026]`

## Cross-Screen Notes For Design Brief

- `SUR-01` і `SUR-02` не утворюють спільний app shell: чат лишається в нативному Element, settings — за окремим protected URL. Перехід може бути лише простим `Відкрити Element`/закриттям сторінки; bot-link не є передумовою.
- Google settings identity не замінює й не відображає Codex/Claude Subscription OAuth. Жодні credentials або provider reauth states не переносяться між поверхнями.
- Збережений current у `SUR-02` стає immutable effective snapshot лише на старті нової Сесії в `SUR-01`. Уже Активна сесія не змінює model/effort/preset.
- Candidate B, повні live verbatim agent messages, команди, дозволи, витрати, архів і нативні Element notifications існують тільки в `SUR-01`; settings не дублюють їх.

## Open Questions

1. Якою має бути видима реакція для стороннього або непідтвердженого відправника: мовчазна відмова чи безпечне повідомлення без захищених деталей? До рішення wireframe не показує захищений зміст і не запускає агентів.
2. Який lifecycle-термін отримує попередня Сесія після `Нова задача`? До рішення `MG-10` буквально повідомляє: поточну сесію закрито, нову створено.
3. Чи зберігається `Зупинена сесія` після `Стоп` в Архіві сесій і з яким статусом? До рішення `SS-15` не переходить автоматично в `SS-21`.
4. Які точні фрази запускають експорт, запит видалення цілої Сесії та відмову від цих дій? Wireframe не винаходить окремі команди або меню.
5. Які формулювання є однозначним дозволом або відмовою для кожного `MG-02`? До рішення використовується структурна вимога явної відповіді без вигаданих quick replies або кнопок.
6. Яка policy-класифікація визначає Особливо чутливий документ? До затвердження невизначений документ переходить у `SS-07`.
7. Чи доступний на дату release безкоштовний план `matrix.org`, чи виконано live room/device/invariant test? Це не додає нового screen; без доказу production не готовий.

Жодне з цих питань не блокує структурні wireframes і не дозволяє додати нову поверхню, паралельну Сесію, новий тип вкладення, кастомний Element chrome або автоматичну зовнішню дію.
