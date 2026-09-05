# Guardrails

- Продукт: `Personal Consultant`
- Версія правил: V1
- Дата актуалізації: 04.09.2026
- Робоча мова: `uk`
- owner_invocation_id: `642f1125-ddd5-4f2e-9395-8c8179cc6c72`

## Source References

- `docs/product-idea.md`: «Позиціонування», «Основний сценарій», «Досвід живого чату», «Налаштування власника», «Межі V1», «Правила даних і доступу», «Модель використання підписок і витрат», «Критерій готовності V1», «Підтверджені рішення» та «Припущення та відкладені рішення».
- `docs/prd.md`: розділи 3–4; `US-001`–`US-029`; `FR-001`–`FR-046`; `NFR-001`–`NFR-019`; розділи 8–12 та `AC-001`–`AC-016`. PRD прямо називає `docs/product-idea.md` основним джерелом продуктового наміру.
- `docs/project-context.md`: розділи 7–14, зокрема платформні межі, V1, доступ і приватність, цілісність, дозволи, припущення, ризики та неблокувальні відкриті питання.
- `docs/canonical-terms.md`: `Власник`, агентські ролі, `Консиліум`, `Дослівний консиліум`, Matrix/data/archive terms, `Облік витрат`, `Налаштування власника`, `Локальний вхід власника`, `Пароль власника`, `GoDaddy Node runtime`, `MySQL-сховище`, `Stateless Preview`, `Гейт незворотного очищення`, агентські OAuth-терміни, `A2A`, `Реєстратор`, `Канонічний порядок`, `Незмінний журнал сесії`, `allowlist`, `room_id` і `owner_mxid`, а також розділи 6–11.
- Явне поточне рішення Власника для Matrix security guardrails: акаунти Власника й бота на публічному `matrix.org`; E2EE та invite-only; рівно два joined-учасники без інших pending invites; history visibility `joined`; без public address/listing, guests, bridges і widgets. V1 не заявляє server-level контроль federation і не покладається на `m.federate: false`.
- Актуальна узгоджена deployment/Settings-auth межа: серверна частина працює в наявному GoDaddy Node.js application з MySQL; `Налаштування власника` використовують локальну автентифікацію одним owner password і fail closed допускають лише Власника; Google OAuth і Cloudflare Access не використовуються. Йдеться про GoDaddy hosting на штатному hostname, а не про перенесення домену. Cloudflare/Google згадки допустимі лише як historical superseded decisions.
- Явна актуальна межа репозиторіїв і cleanup: репозиторій HappyPro та його дані не торкаються. Будь-яке руйнівне видалення legacy Cloudflare/D1/R2/Access/Google-auth ресурсів або даних дозволене лише після окремого JIT-підтвердження Власника, точного inventory цілей і перевіреного backup/restore path.
- `README.md`: лише початкове позиціонування та історичний опис локального preview. Його браузерний surface не визначає V1.
- `DAS Forge 4`: лише bounded pattern evidence для typed allowlists, validate-before-save, atomic save, defaults/reset і effective-value display; не джерело product scope, четвертої групи, конкретного UI чи implementation contract.

Використані SHA-256: `docs/product-idea.md` — `ecc16d6b81c0019f462947b52c013b96636577bd3a14503638102004c7058c8a`; `docs/prd.md` — `32d42a752cae06c4a5dd09a9fce408b537ae06cf6c8fd2fceb7e40773b0c3b94`; `docs/project-context.md` — `1b1268b1055984b5c142740196d3473a3c68518b47db7e1a1645fd8684e3ed15`; `docs/canonical-terms.md` — `e94b5540ac769b72fa454d364fcd708cbfa4b2a7d6fd19a3ed0a184fc4f253da`.

## Source Of Truth Order

1. Явне актуальне рішення Власника щодо продуктового наміру або високоризикової межі.
2. `docs/product-idea.md` як основне джерело актуального продуктового наміру V1.
3. `docs/prd.md` як нормалізований контракт обсягу, поведінки, вимог та acceptance-сценаріїв, доки він не суперечить актуальнішому явному рішенню або `docs/product-idea.md`.
4. `docs/project-context.md` як підтверджений контекстний bundle, що уточнює, але не розширює PRD.
5. `docs/canonical-terms.md` як джерело канонічної мови; словник не змінює продуктову поведінку.
6. `README.md` лише як історичний контекст. Опис локального browser-preview поступається Element/Matrix-рішенню в актуальних джерелах.

`DAS Forge 4`, локальний код, tests, mockups і prototypes є лише bounded evidence відповідної властивості, а не окремим джерелом product scope. Downstream-артефакти можуть деталізувати власну сферу, але не можуть мовчки змінювати цю ієрархію, продуктову межу або дозвіл. Якщо джерела одного рівня суперечать одне одному в суттєвому питанні, роботу над відповідною частиною потрібно зупинити й отримати рішення Власника.

## AI Autonomy Boundaries

- ШІ може автономно аналізувати, досліджувати, рекомендувати та виконувати оборотні внутрішні кроки в межах підтвердженого наміру V1.
- Головний консультант автономно визначає, чи достатньо `Прямої відповіді`, чи потрібен `Консиліум`. Простий запит не виправдовує запуск зайвих агентів.
- Для `Консиліуму` Головний консультант ситуаційно добирає 2–5 окремих Codex-агентів-спеціалістів у різних реальних Codex-сесіях/тредах і залучає окремий Claude Code-процес агента-критика. Codex-сесії використовують один авторитетний захищений ChatGPT OAuth-стан власника зі штатним managed refresh; Claude Code використовує subscription OAuth token від `claude setup-token`. Окремість агентів доводиться їхніми сесіями й фактичними A2A-повідомленнями, а не окремими копіями credentials.
- Головний консультант є єдиним реєстратором підтверджених міжагентних повідомлень і єдиним відповідальним за фінальну рекомендацію. Агенти адресуються одне одному через нього за протоколом A2A.
- ШІ може автономно знаходити й перевіряти дані, потрібні для рекомендації, але має мінімізувати контекст кожного агента, маскувати непотрібні ідентифікатори та не передавати дані поза підтвердженими провайдерами й метою.
- ШІ може пропонувати оборотні presentation-рішення в межах нативних можливостей Element/Matrix, Candidate B «Дослівний консиліум» і вузьких `Налаштувань власника`. Він не може додати web surface поза Settings, перетворити Settings на чат/архів/дашборд, створити окремі Matrix-акаунти агентів або власний звук повідомлень.
- ШІ може перевірити й атомарно застосувати лише валідний набір трьох Settings groups до майбутньої сесії. Він не може вигадати model slug, capability, default, downgrade чи fourth group, частково зберегти набір або змінити `Фактичні налаштування сесії` вже активної сесії.
- Аналіз і рекомендація не є дозволом на зовнішню дію. Остаточне рішення та дозвіл залишаються за Власником.
- ШІ може перевірити дозволений auth mode і квоту та правдиво повідомити про збій, але не може змінити спосіб автентифікації, придбати usage credits, прийняти OAuth-секрет у Matrix або виконати повторну авторизацію від імені Власника.

## Allowed Changes

- Створювати, уточнювати, узгоджувати й перевіряти оборотні SDD-артефакти в межах підтвердженого V1 та відповідальності кожного артефакту.
- Уточнювати формулювання без зміни значення, використовуючи `docs/canonical-terms.md`.
- Додавати трасування до джерела, умови зупинки, межі доказу та чесні стани часткового результату, якщо вони вже випливають із підтверджених вимог.
- Виправляти фактичну помилку агента лише новою підтвердженою реплікою; зареєстроване тіло попередньої репліки залишається незмінним.
- Оновлювати typed model allowlists, capability map, provider-specific reasoning mapping і source-backed defaults лише в межах підтверджених `Моделі`, `Глибина міркування`, `Швидкість`, із свіжою валідацією та без зміни користувацької семантики.

## Forbidden Changes

- Не розширювати V1 на інших користувачів, Matrix-кімнати, Matrix-акаунти, канали, типи вкладень, паралельні сесії, монетизацію, жорсткі грошові ліміти або web surface поза вузькими `Налаштуваннями власника`. Browser chat, live-preview, archive, live status, admin console і dashboard не є дозволеними Settings functions.
- Не дозволяти доступ до `Налаштувань власника` без успішної локальної перевірки owner password і чинної захищеної owner session. Wrong/missing password, missing/invalid/expired session, довільний header/cookie, registration, password recovery/reset або будь-яка друга identity не отримують доступу. Пароль чи його еквівалент не можна повертати клієнту, зберігати в plaintext, логувати або записувати до MySQL як Settings data.
- Не змішувати локальну Settings auth із `Subscription OAuth`: owner session не авторизує Codex/Claude, не читає й не змінює їхні credentials; AI OAuth token, setup-token, refresh state, `auth.json` або reauth material не входять до Settings client/session/data path.
- Не додавати четверту Settings group, довільний model slug/free-text model input, спільний selector замість окремих Codex/Claude typed allowlists, sound/motion, per-agent або per-unit override.
- Не зберігати Settings до повної validation і не робити partial write. Не приймати stale/unknown capability map, не виконувати silent reasoning-effort downgrade, не створювати нову сесію з incompatible set і не мутувати immutable `Фактичні налаштування сесії` активної сесії після save/reset.
- Не трактувати `швидко / збалансовано / ретельно` як provider billing/speed mode. Жодний `Пресет швидкості` не вмикає Claude Fast Mode, API/PAYG, extra usage або usage credits і не вимикає чи послаблює обов'язкового критика, A2A, E2EE, дослівну публікацію, потрібне дослідження, safety, privacy або permission gates; контролів для цих інваріантів у Settings немає.
- Не використовувати платні підписки або OAuth-стани Власника для клієнтів, працівників, членів команди чи інших третіх осіб; не передавати й не перепродавати доступ і не перетворювати V1 на SaaS. Дозволений лише приватний сценарій, який ініціює єдиний Власник і який допускають чинний план та правила кожного провайдера.
- Не замінювати актуальні платформи й межі: Element/Matrix на публічному `matrix.org`, наявний GoDaddy Node.js application з MySQL, OpenAI/Codex, Anthropic/Claude Code та A2A. Cloudflare Worker/Access/DO/R2, Google OAuth, WhatsApp і Meta WhatsApp Cloud API є historical superseded та не є runtime dependency V1.
- Не торкатися репозиторію HappyPro, його deployment, credentials або даних. Не переносити домен: актуальна ціль — GoDaddy hosting на штатному hostname.
- Не виконувати destructive legacy cleanup без окремого JIT-дозволу Власника після exact inventory, scope confirmation, backup і перевірюваного restore plan; міграція даних та видалення старого ресурсу є різними гейтами.
- Не використовувати власний VPS, власний Matrix homeserver, платний Matrix-hosting або локальний Mac як production-сервер V1.
- Не запускати робочу кімнату без E2EE, не робити її публічною чи доступною гостям, не додавати інших учасників, ботів, bridges або widgets. У кімнаті мають бути рівно два joined-учасники — один Matrix-акаунт Власника й один Matrix-акаунт бота на `matrix.org` — без інших запрошених акаунтів; історія кімнати доступна лише після вступу (`joined`).
- Не змінювати E2EE, invite-only, membership, history visibility, public address/listing, guest access, bridge/widget або device-trust інваріанти мовчки. Публічний `matrix.org` не дає Власнику server-level контролю federation; заміна цього захисту іншим provider або власним сервером потребує нового явного рішення Власника.
- Не називати один агентський монолог `Консиліумом`, не вигадувати агентів, репліки, джерела, перевірки, витрати або результати.
- Не скорочувати, не очищувати, не переказувати, не виправляти, не згортати, не пакетувати до фіналу й не приховувати частину тіла фактично надісланого та зареєстрованого агентського доручення, проміжної репліки, критики або виправлення. Не реєструвати міжагентні повідомлення в обхід Головного консультанта.
- Не показувати в користувацькому чаті системні інструкції, приховані міркування моделей, журнали інструментів, технічні ID, номери повідомлень, секунди або сирий Markdown як код чату.
- Не стверджувати, що Matrix E2EE приховує службові метадані від `matrix.org` або захищає розшифрований зміст після завершення E2EE на verified Matrix device бота в GoDaddy runtime. OpenAI та Anthropic отримують переданий їм зміст через TLS.
- Не публікувати, журналювати чи передавати агентам, OpenAI або Anthropic recovery key, Matrix device keys, access tokens або інші секрети.
- Не клонувати, не синхронізувати між незалежними runtime, не вбудовувати в image/repository і не створювати окремі копії Codex `auth.json`, OAuth-cache, refresh state або іншого credential store для головного консультанта чи спеціалістів. Один Codex OAuth-стан не скасовує вимогу окремих реальних агентських сесій/тредів.
- Не встановлювати й не приймати `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` або інші API/PAYG чи alternative-provider auth variables, здатні увімкнути API, Bedrock, Vertex, PAYG або автоматичні usage credits. Єдиний дозволений Claude automation secret — subscription `CLAUDE_CODE_OAUTH_TOKEN`, захищено отриманий через `claude setup-token`; він не дозволяє API fallback.
- Не надсилати через Matrix, agent prompt, A2A, log, archive, export, source code або deployment image жодний OAuth token, setup-token, refresh state, `auth.json`, reauth URL/code чи інший credential material. Повторна авторизація виконується лише через захищений позачатовий provider browser/device flow.
- Не створювати власний звук повідомлень; продукт використовує лише нативні сповіщення Element та операційної системи.
- Не приймати, не передавати агентам і не включати до повідомлень, незмінного журналу, архіву, експорту або клієнтського коду `Секрет`.
- Не редагувати й не видаляти окрему репліку завершеної сесії. Цілу сесію можна остаточно видалити лише після явної команди та підтвердження Власника.
- Не виконувати повідомлення третім особам, публікації, покупки, подання документів, кадрові рішення, зміни репозиторіїв чи інших зовнішніх систем без окремого явного дозволу на конкретну дію.
- Не заявляти юридичну, податкову, медичну, інвестиційну чи іншу високоризикову гарантію та не підміняти профільного фахівця.
- Не вигадувати per-session token cost для підписного AI-usage, не подавати оцінку як фактичну суму й не приховувати недоступний usage/limit/reset. Команда `Витрати` показує лише налаштовані щомісячні subscription fees, фактичні infrastructure spend та provider-reported usage/limit/reset, коли ці дані доступні; невідоме лишається невідомим.
- Не визначати в цьому артефакті точне сховище OAuth-станів, моделі, версію A2A, runtime wiring, архів, керування ключами, черги, повторні спроби або інші архітектурні механізми.

## Scope Boundaries

- V1 — приватна одноосібна не-SaaS система з одним Власником, однією `Дозволеною Matrix-парою`, однією `Приватною Matrix-кімнатою` і не більш як однією активною сесією. Жодна третя особа не ініціює роботу, не отримує результат і не користується підписками Власника.
- Підтримувані входи V1: текст, зображення та PDF. Непідтримуваний тип отримує зрозумілу відмову без запуску аналізу.
- Повсякденний консультаційний surface V1 — штатні клієнти Element на Mac, iPhone, Samsung Flip7/Android і Windows PC. Єдиний web-виняток — responsive `Налаштування власника` лише для параметрів майбутніх консультацій; локальний browser-preview може бути тільки evidence-інструментом.
- `Налаштування власника` доступні лише Власнику після локальної перевірки owner password і створення захищеної, обмеженої в часі owner session. Альтернативної identity, реєстрації та recovery/reset flow у V1 немає; Settings auth відокремлена від `Subscription OAuth` Codex/Claude та не дає доступу до AI credentials.
- Settings scope містить рівно `Codex-агенти`, `Claude Code-критик`, `Швидкість консиліуму`: два незалежні typed model+effort controls із provider-specific capability validation/no silent downgrade; orchestration presets `швидко / збалансовано / ретельно`; atomic validate-before-save, defaults/reset і effective-value display.
- Incompatible Settings set блокує нову сесію fail closed. Кожна нова сесія отримує один immutable snapshot `Фактичних налаштувань сесії`; save/reset не змінює вже активну сесію.
- Власник і бот використовують Matrix-акаунти `matrix.org`. Робочі події приймаються лише з точної allowlist-пари `room_id` і `owner_mxid` та з перевіреного, не відкликаного Matrix-пристрою; новий пристрій відновлює доступ через recovery key і після цього проходить перевірку.
- E2EE захищає зміст між перевіреними Element/Matrix-пристроями. Hosted Matrix homeserver бачить зашифрований зміст і службові метадані; E2EE завершується на verified Matrix device бота в GoDaddy Node.js runtime, де розшифрований зміст обробляється й передається OpenAI та Anthropic через TLS.
- У V1 агенти аналізують і рекомендують. Автоматичні зовнішні дії від імені Власника не входять у продуктову межу без окремого дозволу на кожну конкретну дію.
- Архів сесій зашифрований і безстроковий; зміст і порядок завершеної сесії незмінні до підтвердженого видалення цілої сесії.
- Єдиний дозволений AI auth mode — `Subscription OAuth`: один авторитетний захищений Codex OAuth-стан для окремих реальних Codex-сесій/тредів та окремий Claude Code OAuth token для критика. API key, PAYG і автоматичні usage credits не є резервним режимом навіть після вичерпання квоти.
- `Облік витрат` охоплює налаштовані місячні платежі ChatGPT/Codex і Claude, фактичні витрати GoDaddy Node.js/MySQL та іншої чинної інфраструктури, а також поточний статус `matrix.org` (`0` лише доки доступний його безкоштовний план) і доступний provider usage/limit/reset; для підписного AI-usage не створюється per-session charge.

## Design Authority Rules

- До появи затвердженого цілісного прототипу продуктову поверхню, поведінку й термінологію визначають джерела у встановленому порядку. Оборотні design-пропозиції не стають новою продуктовою вимогою.
- Candidate B «Дослівний консиліум» є підтвердженим змістовим і UX-напрямом: усі фактично надіслані агентські ділові репліки видно в Element наживо, повністю та без пакетування до фіналу. Попередні WhatsApp/browser mockups є superseded evidence і не стають Approved Visual Baseline для Matrix V1.
- Після одного цілісного design-затвердження Approved Visual Baseline може визначати композицію, interaction detail і presentation, але не може змінити Element/Matrix як повсякденний консультаційний канал, єдиний вузький web-виняток Settings, Candidate B, room/access security invariants, межі V1, приватність, дозволи, доступність, доказовість або інші guardrails.
- Mockup браузерного чату, dashboard або live-preview не може бути кандидатом на користувацьку поверхню V1 без явної зміни продуктового наміру. Settings mockup не доводить локальну owner-password auth, capability validation, atomic MySQL save чи session snapshot.
- Нативні можливості та обмеження Element/Matrix і операційної системи мають перевагу над неперевіреною visual-імітацією. Продукт не додає власного звуку поверх нативних сповіщень.

## Conflict Resolution

- Не узгоджувати конфлікт мовчки. Зафіксувати твердження, джерела, їхній рівень у `Source Of Truth Order` і наслідок для V1.
- Канонічний термін береться з `docs/canonical-terms.md`, але словник не може переписати поведінку PRD. Якщо нормалізація терміна змінює поведінку або стан, потрібне рішення Власника.
- Актуальні Element/Matrix-рішення з `docs/product-idea.md` і `docs/prd.md` мають перевагу над історичними WhatsApp-рішеннями, browser-preview у `README.md` та локальним evidence-кодом.
- Downstream-архітектура, дизайн, DoD/evals, QA або реалізація деталізують тільки свою сферу. Виявлений конфлікт повертається власнику відповідного upstream-артефакту; downstream-файл не переписує upstream-рішення.

## When To Ask

- Перед першою звичайною обробкою бізнес-даних — одноразову `Згоду на обробку даних` через `matrix.org`, GoDaddy hosting, OpenAI та Anthropic із чесним поясненням межі Matrix E2EE.
- Перед обробкою `Особливо чутливого документа` — окреме явне підтвердження. Якщо класифікація документа невизначена, застосувати безпечну межу й спочатку попросити підтвердження.
- Перед конкретною зовнішньою або високоризиковою дією — окремий явний дозвіл із назвою дії, цілі, отримувача або системи та істотного наслідку. Загальна згода, мовчання чи дозвіл на іншу дію не переносяться.
- Перед особистими коучинговими запитаннями про страхи, переконання або внутрішні конфлікти — згоду Власника.
- До спливу 10 хвилин стандартного консиліуму, якщо потрібен довший аналіз, — пояснення причини й дозвіл продовжити.
- Перед остаточним видаленням цілої сесії — повторне явне підтвердження.
- Перед додаванням третього учасника, bridge або widget, зміною guest access, history visibility, E2EE, device-trust policy чи іншого кімнатного security invariant — окреме явне рішення Власника як матеріальну зміну V1.
- Перед production-запуском — підтвердження поточного безкоштовного плану `matrix.org` і живий E2EE room/device/invariant test; зміна цього рішення на інший provider або server topology потребує нового явного рішення Власника.
- Якщо subscription OAuth потребує повторного входу, попросити Власника завершити provider-managed reauth лише поза Matrix через захищений browser/device flow. Не просити й не приймати в чаті token, setup-token, `auth.json`, refresh state, URL/code повторної авторизації або скріншот із credential material.
- Якщо поточні правила або eligibility платної підписки більше не підтверджують приватну single-owner автоматизацію, попросити окреме рішення лише після перевірки актуальних правил; мовчки розширювати ліцензійну або білінгову модель заборонено.
- Перед заміною owner password, додаванням іншого login method/identity, registration/recovery flow, четвертої Settings group або settings control для обов'язкового інваріанта — окреме явне продуктове рішення Власника. Звичайний validated save у межах трьох груп окремого дозволу не потребує.
- Перед матеріальною зміною V1, відступом від підтвердженої платформи, розширенням доступу або вирішенням конфлікту джерел, який впливає на продуктову чи високоризикову межу.

## When To Stop

- Owner password не підтверджено або owner session відсутня, malformed, invalid чи expired: fail closed не відкривати й не змінювати Settings. Самої наявності cookie/header недостатньо; не розкривати пароль, його hash, session secret або деталі порівняння у відмові.
- Локальна Settings auth намагається прочитати, змінити чи замінити `Subscription OAuth`, або AI credential потрапив у Settings browser/session/log/data path: зупинити Settings і залежний AI path, не повторювати credential, ізолювати content-free evidence та вимагати безпечне відкликання/відновлення відповідної credential boundary.
- Typed allowlist або capability map відсутні, stale, неавторитетні чи не підтверджують обрану модель і `Глибину міркування`: не робити silent downgrade й не запускати нову сесію до свіжої сумісної validation. Активна сесія лишається на своєму immutable snapshot.
- Повний Settings set не пройшов validation або атомарне збереження не підтверджене: не записувати жодного поля й не показувати новий set як effective; зберегти попередню підтверджену версію та назвати конкретну категорію помилки без секретів.
- `Пресет швидкості` або інше Settings value намагається ввімкнути Claude Fast Mode, API/PAYG, extra usage/credits чи послабити critic/A2A/E2EE/verbatim/research/safety/privacy/permission invariant: відхилити set і не запускати нову сесію.
- Matrix-подію, точну `Дозволену Matrix-пару` або статус перевіреного й не відкликаного Matrix-пристрою не підтверджено: не запускати агентів і не повертати захищені дані.
- E2EE вимкнено або його стан не підтверджено; кімната не invite-only; joined-membership відрізняється від одного акаунта Власника й одного акаунта бота на `matrix.org`; є інший pending invite; history visibility не `joined`; кімната має public address/listing; дозволено guests; присутній bridge або widget: не обробляти робочі запити до відновлення інваріантів.
- Поточний безкоштовний план `matrix.org` недоступний або живий E2EE room/device/invariant test не пройдено: не називати production-канал готовим.
- Matrix E2EE-ключі, verified device state або безпечне recovery/revocation не працюють: не розшифровувати й не обробляти нові робочі повідомлення та прямо назвати збій без розкриття секретних ключів.
- Перед запуском залежного агента не підтверджено `Subscription OAuth`, managed refresh не вдався, OAuth прострочений/відкликаний, setup-token недійсний або квота вичерпана: не запускати новий модельний виклик, зупинити залежну роботу, не публікувати вигадану agent reply і показати відому причину, provider-reported reset time та безпечний позачатовий наступний крок. Не переходити на API/PAYG/usage credits.
- Виявлено `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` або іншу alternative-provider/API/PAYG auth variable, здатну обійти subscription OAuth: не запускати agent runtime до її видалення та повторної перевірки auth mode. Наявність забороненої credential є blocker, а не fallback.
- OAuth token, setup-token, refresh state, `auth.json`, reauth URL/code або інший credential material надіслано в Matrix, A2A чи agent context або виявлено в журналі, архіві, експорті, репозиторії чи image: припинити залежну обробку, не повторювати значення, ізолювати evidence без секрету й вимагати відкликання/безпечної повторної авторизації поза Matrix перед відновленням.
- Запит ініціює не Власник або результат/підписку пропонують клієнту, працівнику чи іншій третій особі, чи актуальні правила провайдера не дозволяють підтверджений private non-SaaS сценарій: не запускати залежну agent work до нового продуктового й правового рішення.
- Потрібної згоди на дані, окремого підтвердження для чутливого документа або дозволу на зовнішню/високоризикову дію немає: перейти в `Очікування дозволу` лише для відповідної дії.
- Виявлено `Секрет`: зупинити його перед передаванням агентам і до реєстрації; не повторювати секрет у відповіді, журналі чи архіві.
- Отримано команду `Стоп`: не запускати нові модельні виклики, скасувати виконуване там, де це підтримує провайдер, і не публікувати пізні відповіді як продовження зупиненої роботи.
- Спливає 10 хвилин стандартного консиліуму без готової фінальної рекомендації: назвати причину й не продовжувати без дозволу.
- Окремого агента або справжній консиліум неможливо запустити: не імітувати його; прямо показати `Збій або неповний результат` і доступну наступну дію.
- Доказів недостатньо або потрібна зовнішня перевірка: припинити впевнене твердження, позначити невідоме й назвати перевірку, що може змінити рішення.
- Недоступне назване джерело, без якого неможливо підтвердити продуктову межу, compliance-твердження або високоризикову дію: не продовжувати відповідну частину.
- Порядок, повноту, недублювання або незмінність підтверджених реплік не можна довести: не називати сесію успішно завершеною чи коректно заархівованою.

## Artifact Separation Rules

- Цей файл визначає джерела істини, автономність, заборони, дозволи, умови зупинки та політику доказів. Він не визначає user journey, screen inventory, wireframes, visual direction, архітектуру, конкретний механізм безпеки, implementation tasks або порядок розробки.
- `docs/product-idea.md` і `docs/prd.md` володіють продуктовим наміром, обсягом і поведінкою; `docs/project-context.md` — підтвердженим контекстом; `docs/canonical-terms.md` — мовою.
- `docs/architecture.md` володіє технічними механізмами. `docs/dod-evals.md` володіє повторюваним контрактом Done та eval-гейтами. `docs/qa-checklist.md` володіє конкретними per-release і per-scenario перевірками та evidence-артефактами. Цей owner invocation не читає й не змінює downstream docs.
- Journey, screen-map, wireframes, design brief, mockups і Approved Visual Baseline можуть посилатися на guardrails, але не дублюють і не переписують їх.
- Пізніший артефакт, тест, mockup або код не стає джерелом нової продуктової вимоги лише тому, що його створено або що він проходить локальну перевірку.

## Verification Rules

- Перед твердженням про успіх визначити доказ, запустити перевірку свіжо, прочитати повний результат і лише тоді назвати статус. Без цієї послідовності не заявляти готовність, якість, безпеку, відповідність або завершення.
- У суттєвому аналізі окремо позначати підтверджені факти, інформацію Власника, робочі припущення, професійне судження та невідоме. Згода ШІ-агентів сама по собі не є незалежним доказом.
- Актуальні, нестабільні й високоризикові твердження перевіряти за актуальними першоджерелами. Якщо перевірка неможлива, знижувати впевненість і називати обмеження.
- Найвищий доказ готовності V1 — свіжий поєднаний evidence bundle: наскрізна консультація через реальну приватну E2EE Matrix-кімнату з фактичними агентами/A2A та наскрізний Settings path через реальну responsive web surface у GoDaddy Node.js application з позитивною й негативними owner-password/session, save/capability/MySQL/snapshot перевірками. Жодна поверхня не замінює evidence іншої.
- Перевірка локальної owner-password auth має окремо відтворити правильний password, wrong/missing password, missing/malformed/invalid/expired session, replay/forged cookie, direct protected-route/API access без login, а також відсутність registration, recovery/reset та іншої identity. Кожна негативна спроба fail closed; password value, hash і session secret не потрапляють до response, browser storage, logs чи MySQL Settings rows.
- Перевірка auth separation має довести, що owner password/session не читає, не змінює й не замінює Codex/Claude `Subscription OAuth`, а AI credentials не потрапляють у Settings client, browser storage, request/response body, logs або persisted settings.
- Перевірка Settings contract має довести рівно три groups, окремі typed Codex/Claude allowlists без arbitrary slug, спільні `low / medium / high / xhigh`, авторитетну capability-map version, правильне provider-specific mapping і fail-closed behavior без silent downgrade для unsupported/unknown/stale state.
- Перевірка `Пресету швидкості` має довести лише orchestration effect для `швидко / збалансовано / ретельно` та відсутність Claude Fast Mode, API/PAYG, extra usage/credits і controls/effects, що послаблюють critic/A2A/E2EE/verbatim/research/safety/privacy/permission invariants.
- Перевірка save/reset/snapshot має довести validate-before-save, all-or-nothing persistence, незмінність попереднього set після будь-якої validation/write failure, source-backed defaults/reset, truthful effective-value display, один immutable snapshot для нової сесії та відсутність мутації активної сесії після save/reset.
- Settings accessibility evidence має охопити representative mobile/desktop widths, keyboard path, assistive-technology labels/relationships, focus, validation announcements і відсутність color-only meaning; це не дозволяє додавати іншу web surface.
- Перевірка Codex auth/runtime має довести один авторитетний захищений ChatGPT OAuth-стан зі штатним managed refresh, відсутність клонованих `auth.json`/OAuth-cache/refresh state і водночас окремі реальні сесії/треди головного консультанта та кожного спеціаліста.
- Перевірка Claude Code auth/runtime має довести окремий critic process через subscription `CLAUDE_CODE_OAUTH_TOKEN` від `claude setup-token`, а також відсутність `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` і всіх alternative-provider/API/PAYG variables, здатних увімкнути fallback.
- Негативна auth/quota-перевірка має окремо відтворити unknown auth mode, refresh failure, expiry, revocation, invalid setup-token і quota exhaustion. У кожному випадку система fail closed, не робить новий model call, не купує credits, не змінює provider і не приймає credential через Matrix; відновлення доводиться лише після позачатової reauth і свіжої перевірки дозволеного auth mode.
- Перевірка containment має підтвердити відсутність OAuth/setup-token/refresh state/`auth.json`/reauth codes у Matrix, A2A, prompts, logs, telemetry, archive, export, repository, images і agent workspaces, а перевірка revocation — що відкликаний credential більше не запускає залежного агента. Конкретне сховище й ротаційний механізм визначає архітектура.
- Перевірка private non-SaaS межі має підтвердити, що запити ініціює і результати отримує лише Власник, підписки не обслуговують третіх осіб, а актуальні plan/terms допускають заявлений private usage. Це не є універсальною юридичною гарантією й потребує повторної перевірки після зміни правил провайдера або продуктового доступу.
- Вимірювати всі чотири межі швидкості окремо: підтвердження запиту не пізніше 5 секунд; перша видима репліка агента не пізніше 30 секунд; під час активної роботи не більше 60 секунд без видимого змістовного оновлення або пояснення очікування; фінальна рекомендація стандартного консиліуму не пізніше 10 хвилин або перехід в `Очікування дозволу` на продовження.
- Перевірка приватності має охоплювати інший `owner_mxid`, інший `room_id`, неперевірений і відкликаний пристрої, підроблену та повторно доставлену Matrix-подію, `Секрет` у повідомленні й особливо чутливий документ без підтвердження. Новий пристрій має відновити доступ через recovery key, пройти перевірку, а втрачений — бути відкликаним.
- Перевірка кімнатних інваріантів має свіжо підтвердити `matrix.org`, E2EE, invite-only, joined-membership рівно Власник + бот без інших pending invites, history visibility `joined`, відсутність public address/listing, guest access, bridges і widgets, а також verified devices.
- Перевірка довірчої межі має окремо довести шифрування подій між перевіреними Element/Matrix-пристроями й зафіксувати, що `matrix.org` бачить метадані, а розшифрований у GoDaddy Node.js runtime зміст передається OpenAI та Anthropic через TLS. Не подавати це як E2EE до AI-провайдерів.
- Перевірка цілісності має зіставити повне незмінне тіло, канонічний порядок і відсутність дублів в Element-відображенні, експорті та архіві. Усі фактичні агентські доручення, проміжні репліки, критика й виправлення мають з'являтися одразу після реєстрації, без пакетування до фіналу.
- Перевірка failure-path має довести, що збій агента, неповний консиліум, брак доказів, заміна агента й перевищення часу відображаються правдиво та не маскуються успішним статусом.
- Перевірка `Обліку витрат` має зіставити кожний показаний місячний subscription fee з налаштованою сумою, infrastructure spend — з фактичним рахунком/usage, а usage/limit/reset — з доступною відповіддю провайдера. Недоступне позначається невідомим; жодної розрахованої або оціненої per-session token cost для included subscription usage бути не може.
- Основний сценарій перевіряється у штатних клієнтах Element на Mac, iPhone, Samsung Flip7/Android і Windows PC; клієнтські відмінності E2EE, форматування, recovery, revocation і нативних сповіщень фіксуються як platform variance. Окремий продуктовий звук не є вимогою й не може бути підставою для позитивного статусу.

## Evidence Requirements

- Unit- та integration-тести є допоміжним доказом окремих механік, але не замінюють ні реального Element/Matrix end-to-end сценарію, ні реального Settings access/save/session handoff.
- Скріншот, статична документація, mockup, prototype, згенерований HTML, синтетична Matrix-подія, попередній WhatsApp prototype або локальний browser-preview окремо доводять лише відповідну статичну, історичну чи локальну властивість. Вони не доводять готовність Matrix E2EE, `matrix.org`, GoDaddy runtime/MySQL, A2A, агентського циклу, архіву або повного V1.
- Видима роль без окремо запущеного агента та фактичного адресованого повідомлення не є доказом консиліуму. Кожна показана репліка має відповідати фактично надісланій і підтверджено зареєстрованій репліці.
- Видимий OAuth-success, наявність credential-файла або успішна одна model reply окремо не доводять дозволений auth mode, managed refresh, відсутність fallback, separate agent sessions, revocation, quota behavior чи secret containment. Потрібне свіже позитивне й негативне runtime/config evidence без розкриття секретних значень.
- Видима login form, наявність cookie/header, HTTP 200, screenshot Settings або прихований client control окремо не доводять правильну server-side password verification, session integrity/expiry, захист усіх Settings routes/API чи auth separation. Evidence має містити content-free request/result correlation для кожного позитивного й негативного випадку без password/hash/session-secret disclosure.
- Static form, локальний state change або успішний один save не доводять exact-three schema, typed allowlists, capability correctness, atomic rollback, defaults/reset, truthful effective values чи immutable session snapshot. Потрібні state/version evidence та failure injection на відповідних межах.
- `DAS Forge 4` може підтвердити лише bounded reusable patterns. Його UI, сім груп, sound/motion, free-text models, per-agent/per-unit overrides, architecture або test pass не доводять і не розширюють `Personal Consultant`.
- Cost estimate, list price або локальний token count не є фактичними витратами. Evidence для `Витрати` зберігає джерело, період, timestamp і статус `configured`, `actual`, `provider-reported` або `unavailable`, не зберігаючи credentials.
- Доказ зовнішньої дії має включати конкретний дозвіл Власника й фактичний результат; підготовлений draft або рекомендація не доводять виконання.
- За часткового проходження повідомляти частковий статус із переліком підтвердженого, непідтвердженого та наступної перевірки. Не підвищувати статус за непрямим або застарілим evidence.

## Source Access Failures

- Недоступність джерела завжди фіксувати, класифікувати його матеріальність і називати застосований fallback або blocker; не ігнорувати файл, посилання, вкладення, token чи brand-матеріал мовчки.
- Якщо недоступне джерело визначає product scope, доступ, приватність, compliance-твердження, дозвіл або іншу високоризикову межу, зупинити відповідну роботу до відновлення доступу або явного рішення Власника.
- Якщо не можна підтвердити owner password verifier, session signing/expiry або protection усіх Settings routes/API, не відкривати Settings; якщо недоступні актуальні typed allowlists/capability map/provider mapping/defaults або MySQL atomic persistence, не зберігати неперевірений set і не запускати нову сесію. Попередня підтверджена конфігурація та active-session snapshot не мутують.
- Якщо недоступне лише естетичне посилання, це не створює окремого pre-prototype approval gate: можна продовжити з оборотними source-grounded варіантами, явно повідомивши про fallback. Це не дозволяє вводити web surface поза вузькими Settings, відступати від Candidate B або змінювати нативний Element/Matrix consultation channel.
- Невизначені архітектурні механізми не заповнювати припущеннями в guardrails; передати їх власнику `docs/architecture.md`.

## Open Questions

Матеріальних відкритих питань, що блокують ці guardrails, немає. Downstream-рішення не можуть мовчки змінити підтверджені межі V1:

- точні typed allowlist values Codex/Claude, capability-map source/version, provider-specific mapping `low / medium / high / xhigh`, source-backed defaults і версія/профіль A2A; unknown або drift не дозволяє silent fallback;
- точний password hashing/verifier, session signing/expiry/rotation і MySQL transaction/schema mechanism; вони не можуть додати іншу identity/login/recovery path, покладатися лише на cookie/header presence, змішати Settings auth із Subscription OAuth або порушити atomic save/snapshot rules;
- конкретне захищене сховище одного Codex OAuth-стану й Claude Code OAuth token, managed-refresh coordination, revocation та out-of-band reauth wiring; ці архітектурні рішення не можуть дозволити клони credential store, Matrix reauth або alternative-provider fallback;
- перевірка поточного статусу безкоштовного плану `matrix.org`, його лімітів та живого E2EE room/device/invariant evidence перед release;
- сховище та формат архіву, керування ключами, черги, повторні спроби й відновлення після збою;
- точна policy-класифікація `Особливо чутливого документа`; до її затвердження невизначений випадок потребує окремого підтвердження;
- канонічний lifecycle-термін для попередньої сесії після `Нова задача`; до рішення повідомляти буквально, що поточну сесію закрито, а нову створено;
- фактичні грошові ліміти після накопичення статистики `Витрати`; V1 лише відстежує витрати й не вводить непідтверджений ліміт.
