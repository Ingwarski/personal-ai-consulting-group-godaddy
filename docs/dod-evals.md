# DoD And Evals

- Продукт: `Personal Consultant`
- Версія контракту: V1, reconciled GoDaddy/Rust-sidecar target after approved visual baseline
- Дата: 05.09.2026
- owner_invocation_id: `038d1e3c-3aaf-465c-af48-cf0cd9e7f6f4`
- Definition Status: `prepared`
- Execution Status: `not_run`
- Release Readiness: `not_evaluated`

## Source References

Порядок істини успадковано з `docs/guardrails.md`. `docs/product-idea.md` використано, тому що `docs/prd.md` прямо називає його основним джерелом продуктового наміру. Поточна pipeline-фаза має approved visual baseline `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`; усі user-visible implementation units перевіряються проти його immutable target та approval receipt.

| Джерело | SHA-256 / evidence | Спожиті фрагменти |
|---|---|---|
| `README.md` (історична згадка) | Не спожито заново | Початкове позиціонування вже визначене PRD; browser-preview не є продуктовим доказом |
| `docs/product-idea.md` | `852758d725831ebb435da8ffd9a548a6ea1ad70fbab13261885a4793a12ad14e` | Element/Matrix V1; GoDaddy Node/MySQL; реальний Консиліум; Google-only Settings; private single-owner subscription OAuth; дані, час, архів, команди й витрати |
| `docs/prd.md` | `a45aa866bd0591ba778b8ddf1528f9789fd954eef86dd2d8109c8db3f0ed23cc` | `US-001`–`US-029`; `FR-001`–`FR-046`; `NFR-001`–`NFR-019`; `AC-001`–`AC-016`; Security Requirements з 11 IDs; Settings, OAuth-only і fail-closed contracts |
| `docs/project-context.md` | `458da1092f8ac6b10fca6aadc33fab6b9b56aef650fff23e814fe84cb15735a4` | Outcomes; two surfaces; GoDaddy Node/MySQL; Google/local-session; private/non-SaaS boundary; constraints; risks |
| `docs/canonical-terms.md` | `dd4a7ef9ee403f941b649247b14eafff044af717d54fb8731b0d2d26665848d3` | Ролі; об'єкти; команди; Settings groups/states; Google/local-session; OAuth; A2A; Реєстратор; Канонічний порядок; Облік витрат |
| `docs/guardrails.md` | `6b88dcd634b03203f9f8dde93bd4e4abdba3fe57205b5f3bb776106b39bd999b` | Source order; GoDaddy/MySQL; Google/local-session; exact-three/atomic/snapshot rules; private-use and OAuth boundaries; stop rules; evidence; design authority |
| `docs/user-journey.md` | `ef058d468fde194ff38efe5d209edbdc3f061d90e4f9602671071c1cc28b2c39` | Element Stages 1–10; Settings S1–S5; local auth recovery; failures; costs; success |
| `docs/screen-map.md` | `fe25f595f954cb7b04e369aec65066ec31d7a66a3359953c968343713d41039d` | `SUR-01`–`SUR-02`; `MG-01`–`MG-13`; `SG-01`–`SG-05`; `SS-01`–`SS-46`; GoDaddy owner-login transitions; edge paths |
| `docs/wireframes.md` | `e065b36af6ba851cb79a2028227b4599129da9c3656dc4be1a913d08cba62ed5` | Native Element patterns; Google-транзакція і authenticated responsive Settings structure; all state/group coverage; accessibility |
| `docs/design-brief.md` | `a5feac6981acefb15cc84e827080d72b4b7b3734a1e6487cf4046f611095396e` | Approved `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`; `DB-D18`/`DB-D19`; both surfaces; `P-01`–`P-15`; H1–H10; representative task plan; HappyPro palette for `SUR-02` |
| `docs/architecture.md` | `4f89d993e0029b3dd5b34231ae4177ae315faa860d6e15212c689b8d67ff05d6` | GoDaddy Node 22 host/supervisor; Rust `matrix-sdk` 0.18.0 sidecar; bounded NDJSON/media spool; encrypted SQLite crypto store; MySQL state/outbox/archive; Google/local-session; product-security mapping |
| Поточний репозиторій | 05.09.2026: `package.json`, `.github/workflows/matrix-sidecar.yml`, `native/matrix-sidecar/Cargo.toml`, `native/matrix-sidecar/Cargo.lock`; точні SHA-256 у source-usage записі | Node 22 scripts, Rust workspace/lockfile і CI існують. Наявність файлів і попередні локальні результати не доводять актуального Linux artifact, GoDaddy deployment, live E2EE чи release; code observations решти модулів успадковано з §1/§8.3 архітектури |
| Явне рішення Власника | 16.08.2026 | Candidate B v2 цілісно затверджено фразою «ОК. Закрий хром і продовжуй розробку»; тільки цей baseline є visual source для наступних user-visible units |

Канонічне покриття: `JOB=5`, `UC=6`, `US=29`, `FR=46`, `NFR=19`, додатково вісім незалежних пунктів `NFR-016.a`–`NFR-016.h`, `AC=16`, `SUR=2`, `MG=13`, `SG=5`, `SS=46`, `SECURITY_REQUIREMENTS=11`. Підпункти `FR-038(a–d)` та `FR-039(a–c)` перевіряються окремо в G-18, а обидві частини NFR-019 — у G-14/G-19/G-23. Жоден parent ID не замінює всіх своїх обов'язків.

## Definition Of Done Model

Done — це підтверджений стан, а не самооцінка агента, наявність документа, зелений локальний тест або прийняття повідомлення зовнішнім API. Стан визначається для конкретного scope та environment свіжими результатами всіх застосовних гейтів.

Рівні Done:

1. **Product V1 Done:** усі `AC-001`–`AC-016` пройдено в одному evidence lineage: реальна приватна E2EE Matrix-кімната з перевіреними пристроями; production Rust sidecar з encrypted SQLite crypto store; реальна protected responsive `SUR-02` у GoDaddy Node app через Google-вхід та окрему локальну сесію; MySQL state/outbox/encrypted archive; один fenced authoritative Codex subscription-OAuth lineage; окремі реальні Codex threads/workspaces; окремий Claude Code subscription-OAuth process; фактичні provider/runtime integrations; усі застосовні hard gates пройдено.
2. **Feature unit Done:** усі пов'язані `FR`/`NFR` мають unit та integration evidence; user-visible scope також має потрібний Element/Matrix/design evidence; жодного blocking finding не залишилося.
3. **Change Done:** зміна має визначений scope, трасування до вимог, свіжий evidence після останньої зміни й не порушує неохоплені інваріанти.
4. **Evidence-limited result:** якщо runtime або provider evidence недоступний, результат може бути лише `blocked` або чесно частковим; він не підвищується до Done.

## Acceptance Criteria Vs Definition Of Done

Acceptance criteria відповідають на питання, чи реалізовано потрібну поведінку конкретного сценарію. Для V1 це `AC-001`–`AC-016`.

Definition of Done відповідає на питання, чи завершено scope до повторюваного стандарту: вимога реалізована, інтегрована, безпечно обмежена, перевірена на потрібному рівні, має свіжі докази, не містить blocking findings і готова до заявленого середовища. Проходження одного acceptance-сценарію не замінює standing DoD.

## Global Definition Of Done

Scope є Done лише коли одночасно:

- його вимоги й acceptance-сценарії трасуються до конкретних гейтів;
- кожний застосовний hard gate має статус `passed` на поточній версії коду, конфігурації, runtime і design source;
- unit evidence доводить локальні інваріанти, integration evidence — контракти між реальними модулями, а end-to-end evidence — фактичний користувацький результат;
- немає відкритих P0, P1 або P2 із `Release Effect: blocking`;
- статика, mockup, prototype, згенерований HTML чи локальний browser-preview не використані як доказ Element/Matrix, GoDaddy runtime, Rust sidecar, MySQL, A2A, реальних процесів, архіву, вартості або доставки;
- твердження про успіх не перевищує evidence: provider acceptance не називається delivery, кілька labels не називаються реальним Консиліумом, а оцінка вартості не називається фактичною сумою;
- user-visible content відповідає approved visual baseline `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`;
- кожний user-visible implementation scope проходить активний `approved_visual_baseline_fidelity`;
- кожний застосовний user-visible scope окремо проходить `heuristic_usability_review` і `representative_user_task_validation`; visual fidelity не підміняє usability або observed owner-task evidence;
- усі 11 PRD Security Requirements проходять один обов'язковий активний `product_security_requirements`; mockup, document validation або advisory result не може його задовольнити;
- evidence bundle містить owner, час, environment/config fingerprint, source revision, фактичний результат і незмінні посилання або hashes.
- один-owner/non-SaaS eligibility, auth mode, quota, credential-writer fence і відсутність API/PAYG/cloud-provider fallback перевірені до кожного залежного model call; unknown або failure веде до `SS-29`, а не до часткового прихованого запуску.
- `SUR-02` допускає лише перевірену дозволену Google-ідентичність через одноразову браузерну транзакцію та окрему чинну локальну сесію (G-18, NFR-016.a–h). Вхід не залежить від каталогу/AI readiness. Атомарність Settings і незмінність snapshot окремо перевіряє G-19.

## Feature Unit Definition Of Done

Feature unit є Done, коли:

- названо пов'язані `FR`, `NFR`, `AC`, architecture interfaces, message groups/states і guardrails;
- позитивні, негативні, duplicate/retry та recovery paths мають застосовний unit/integration evidence;
- external-effect unit використовує durable intent до effect, а user-visible agent unit — registrar confirmation до route/publication;
- state або generation change не допускає late output, stale lease чи змішування context;
- user-visible output має design/content evidence на реальних client constraints, якщо це можливо на цьому етапі;
- невизначена product/policy межа не реалізована припущенням: вона або використовує підтверджений conservative fallback, або блокує відповідний гейт;
- після виправлення blocking finding усі безпосередньо уражені гейти та їхні залежності перезапущено.

## Verification Profile

### Hard Gates

| Gate | Blocking scope |
|---|---|
| `G-01 source_contract_integrity` | Будь-який completion claim |
| `G-02 ingress_authorization` | Будь-яке protected processing або release |
| `G-03 consent_and_data_safety` | Будь-який input/data flow або release |
| `G-04 session_idempotency_and_generation` | Session/command scope та release |
| `G-05 real_consilium_runtime` | Консиліум і Product V1 |
| `G-06 canonical_a2a_verbatim_order` | Agent message, transcript, archive та release |
| `G-07 timing_and_visible_progress` | Timing claim і Product V1 |
| `G-08 cancellation_and_late_output_suppression` | `Стоп`, `Нова задача` та release |
| `G-09 truthful_result_and_action_contract` | Direct/consilium result та release |
| `G-10 encrypted_archive_export_delete` | Archive/data-control claim та release |
| `G-11 confirmed_cost_accounting` | `Витрати` та Product V1 |
| `G-12 native_element_matrix_client_behavior` | Element/Matrix/client claim та release |
| `G-13 proposed_design_contract_fidelity` | Historical/proposed prototype evidence only; не є production gate для нового user-visible implementation |
| `G-14 matrix_e2ee_room_and_platform_isolation` | Deployed integration та release |
| `G-15 v1_real_matrix_e2e` | Product V1 release |
| `G-16 approved_visual_baseline_fidelity` | Active hard gate для кожного user-visible frontend/full-stack/integration scope |
| `G-17 subscription_oauth_private_runtime` | Будь-який model call, agent launch, `SS-28`/`SS-29` або Product V1 release |
| `G-18 owner_settings_access_security` | Кожний `SUR-02` request, protected asset/API access або Product V1 release |
| `G-19 owner_settings_atomic_configuration` | Settings read/save/reset, capability/catalog change, session start або Product V1 release |
| `G-20 owner_settings_runtime_ux` | Кожний user-visible `SUR-02` change і Product V1 release |
| `G-21 heuristic_usability_review` | Кожний застосовний user-visible journey/state/route/viewport і Product V1 release |
| `G-22 representative_user_task_validation` | Критичні, consequential, нові або змінені owner tasks і Product V1 release |
| `G-23 product_security_requirements` | Усі 11 чинних PRD Security Requirements; кожний implementation/release scope, що їх зачіпає |

### Unit Checks

Unit evidence перевіряє детерміновані локальні інваріанти без твердження про інтеграцію:

- signature/identity normalization, type/size disposition, consent and permission state transitions;
- secret detection, no-echo response, redaction and minimum-context projection;
- provider event, A2A envelope та outbox dedupe;
- monotonically assigned sequence, body hash/integrity chain, immutable correction-as-new-envelope;
- Session/generation transitions, `Стоп` publication gate, stale lease rejection and `Нова задача` isolation;
- timer/deadline classification for 5/30/60 seconds and 10 minutes;
- OAuth state-machine cases for writer fencing, checkpoint CAS, refresh, reauth and revocation; auth/quota/private-eligibility disposition before every dependent call;
- forbidden-environment detection for API keys, PAYG, cloud-provider routes and automatic credits;
- Google token/identity/transaction, session/request/security negatives за кожним NFR-016.a–h і G-18; deterministic doubles відтворюють підміну, replay, concurrent claim, expiry/revocation/restart, відмову ключів/DB/мережі без доступу або витоку.
- Точна схема трьох груп; незалежні каталоги моделей/версій і власних рівнів Codex та Claude; Claude Opus→Sonnet→Haiku, новіші підтверджені версії першими; model-default без explicit effort; жодної спільної шкали, приховування runtime-confirmed Sol або мовчазної заміни.
- whole-object Settings validation, revision/CAS and idempotency-ledger cases for success, conflict, exact retry, reused-key/different-body, reset, offline and failed write;
- deterministic speed-policy mapping for all three presets plus invariant checks that forbid Fast/priority/PAYG/extra usage and preserve critic/A2A/E2EE/verbatim/research/safety/privacy/permission rules;
- immutable session-snapshot creation and rejection of later mutation, including concurrent save/start ordering and capability drift;
- cost aggregation that separates configured subscription fees, actual infrastructure spend and provider usage/limit/reset, while excluding estimates from actual totals;
- archive manifest/hash verification, confirmed-delete state transition and failure classification;
- content-contract validators that can inspect role/`HH:MM`, forbidden metadata and final-series structure.

Поточний репозиторій містить Node 22 package, `npm run check`, GoDaddy runtime/MySQL/owner-auth adapters і локальні unit/integration-oriented tests. Вони є доступними deterministic verification surfaces, але не доводять production Rust sidecar, real `matrix.org` E2EE, deployed GoDaddy runtime або Product V1; gate execution у цьому definition pass не виконувалося.

### Integration Checks

Integration evidence використовує реальні contract boundaries, а не лише mocks:

- verified bot-device у Rust `matrix-sdk` sidecar → room/device invariant gate → bounded private NDJSON → Node registrar + MySQL exact room/mxid/idempotency transaction;
- Node registrar → durable MySQL ordered outbox → Rust sidecar з deterministic transaction ID → Matrix event receipt;
- Node registrar → agent process adapters → окремий process lease/heartbeat/cancel/usage → transactional registrar callback;
- Node supervisor/runtime vault → one fenced Codex credential lineage → sealed checkpoint restore/managed refresh/CAS checkpoint → teardown or revocation, including concurrent-writer denial and crash recovery;
- one fenced Codex subscription process/credential lineage → distinct head/specialist thread IDs and isolated workspaces without cloned `auth.json`/OAuth caches; separate Claude critic process → subscription setup-token/auth-status path;
- scrubbed runtime environment and outbound handlers → OpenAI/Anthropic subscription endpoints only; negative proof that API/PAYG, automatic credits, Bedrock, Vertex, Foundry, custom endpoint and higher-precedence provider credentials cannot activate;
- GoDaddy Node → явний POST start → Google code/PKCE → callback із одноразовим atomic claim → повна перевірка токена/owner/nonce → окрема durable session; дозволені й заборонені результати кожного NFR-016.a–h, включно після рестарту, до готовності AI/catalog і без password fallback.
- deployed GoDaddy Node Settings routes → same-origin/CSRF/CSP/no-store/header enforcement → MySQL full-object Settings transaction; cross-origin, cache, content-type, body-size, method and clickjacking/XSS policy negatives;
- Settings runtime → MySQL revision/CAS/idempotency/audit transaction → capability catalog/provider reconciliation → truthful current/default/effective response;
- MySQL Settings version → session resolver → Node registrar session-start snapshot, including compatible, drift, concurrent-save, auth/quota failure and next-session-only cases;
- A2A draft → atomic registration/order/hash → target route і visible outbox;
- Node archive service → application-layer encryption/key boundary → MySQL ciphertext/nonce/authenticated manifest/tombstone → read-back/hash verification;
- archive export і confirmed whole-session deletion з provider-retention disclosure;
- failure injection для duplicate event, runtime loss, late callback, MySQL outbox retry/transaction rollback, ciphertext/manifest mismatch, key-provider unavailability й incomplete usage.

Contract-test doubles можуть допомагати відтворюваності, але release evidence має включати фактичні configured integrations для claims, які залежать від них.

### System Checks

System/end-to-end evidence запускає `AC-001`–`AC-016` через реальну приватну E2EE Matrix-кімнату та реальну protected `SUR-02`: точні room/mxid, перевірені Element/bot devices, production Rust `matrix-sdk` sidecar з exact encrypted store/device binding, bounded private NDJSON, deployed GoDaddy Node 22 server side, Google OIDC і перевірка окремої локальної підписаної сесії, MySQL registrar/outbox/settings/encrypted archive, one fenced Codex OAuth lineage/writer, distinct real Codex threads/workspaces, real separate Claude Code subscription-OAuth critic, configured A2A adapter and actual cost records.

Окремо фіксуються:

- received, provider-accepted, delivered/read/failed statuses, не змішуючи їх;
- timestamps для 5/30/60 секунд і 10 хвилин;
- process lease identities та generation;
- Codex credential lineage/checkpoint/writer-fence metadata, distinct thread/workspace identities, Claude process/auth-mode status and credential-free environment inspection without secret values;
- positive `SS-28` preflight and injected unknown/expired/revoked/refresh-failed/invalid-setup-token/quota-exhausted/ineligible/forbidden-credential cases that reach `SS-29` before a dependent call and resume only after provider-managed out-of-band recovery plus fresh preflight;
- Повна allowed/denied/recovery матриця G-18 і AC-012(a–f), а не один успішний вхід; кожен NFR-016.a–h має окремий результат і очищений доказ. Старі password/challenge unit tests не засвідчують Google OIDC.
- `SUR-02` current/default/effective load, exact-three schema, typed selector/capability evidence from both current subscription runtimes, supported/unsupported/unknown/stale effort mappings, all speed presets, atomic save/reset/CAS/idempotent retry/conflict/offline paths and immutable current-vs-active snapshot comparison;
- Перевірка конфігурації GoDaddy Google/local-session, fixed HTTPS origin, response headers і відмов без значень секретів; у доказі немає code, JWT, nonce/verifier, session cookie, CSRF token, точної owner identity, Settings body або AI credential.
- canonical body/order comparison між registrar, Element/Matrix-visible stream, export і archive;
- actual client/app/OS versions у device evidence matrix;
- injected failure, partial status, recovery result and rerun.

### UX/UI Checks

- Для historical proposed artifacts перевіряється `G-13 proposed_design_contract_fidelity`. Нові user-visible implementation units перевіряються активним `G-16 approved_visual_baseline_fidelity` проти `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`: рівно дві поверхні `SUR-01`–`SUR-02`, `MG-01`–`MG-13` (13), `SG-01`–`SG-05` (5), `SS-01`–`SS-46` (46), `P-01`–`P-15`, native Element/Matrix chat, one-page Settings hierarchy, HappyPro palette для `SUR-02`, plain-text meaning та accessibility floor.
- Representative evidence охоплює 390, 430, 768, 1280 і 1440 px як design stress viewports, але browser rendering не підміняє current-client evidence.
- Реальні Element/Matrix clients перевіряються на Mac, iPhone, Samsung Flip7/Android і Windows PC щодо order, formatting, long body, role/`HH:MM`, text scaling/screen-reader path і disclosed variance.
- Реальна deployed `SUR-02` перевіряється на representative mobile/desktop widths щодо keyboard-only navigation, programmatic labels/relationships, visible focus, 24×24 minimum targets і 44×44 primary touch target where applicable, error/status announcements, zoom/reflow, long model/mapping text, no horizontal loss of critical action and no color-only meaning.
- `G-16 approved_visual_baseline_fidelity` застосовується з Baseline ID, immutable target hash, coverage, concrete QA check IDs and `VisualQAEvidence`.
- `G-21 heuristic_usability_review` окремо охоплює всі застосовні H1–H10, primary journeys, error/recovery, accessible critical actions і supported desktop/mobile scope; `covered` у brief не є pass.
- `G-22 representative_user_task_validation` окремо вимагає observed completion критичних/нових/змінених tasks єдиним representative user group — Власником; agent walkthrough або screenshot не є user research.

### Release Checks

Release-ready вимагає:

- усі hard gates, застосовні до V1, `passed` зі свіжим evidence;
- `G-15` пройдений у production-like або production environment, що використовує реальних providers/processes; середовище названо точно;
- configured model/runtime/A2A/key/retry/export choices зафіксовано у evidence fingerprint;
- `G-17` підтверджує актуальну private single-owner plan eligibility, subscription OAuth-only mode, один authoritative Codex writer/checkpoint lineage, окремі реальні agent contexts, Claude setup-token process, quota/fail-closed behavior і відсутність paid fallback;
- `G-18` підтверджує розгорнутий Google-вхід і незалежну локальну сесію за всіма NFR-016.a–h, захист запитів/відмов і відокремлення AI OAuth.
- `G-19` підтверджує live provider-backed capability catalog, exact-three contract, all-or-nothing persistence/reset/retry і immutable next-session snapshot без Fast/PAYG або weakened invariant;
- `G-20` підтверджує, що deployed `SUR-02` реально usable й accessible на required responsive paths, а не лише відповідає статичному design source;
- `G-21` і `G-22` мають окремі fresh passing results; visual fidelity, heuristic review та representative-user validation не підміняють одне одного;
- `G-23` потребує implementation evidence для рівно 11 Security Requirements NFR-005, NFR-006, NFR-007, NFR-008, NFR-009, NFR-010, NFR-011, NFR-012, NFR-016, NFR-017, NFR-019. Визначений PRD виняток щодо власної MFA не є невирішеним питанням і не скасовує компенсувальних контролів або доводить повну ASVS-відповідність.
- deployment and rollback evidence доводить dark auth health check, safe checkpoint restore, credential-writer fencing, out-of-band reauth/revocation and `SS-29` retention when safe restore is unproven;
- жодного plaintext archive object, secret/body у telemetry або generic external-action connector;
- немає P0, P1 чи blocking P2;
- відомі client/provider limitations описані як limitations, а не приховані;
- Наявні `npm run check` і GoDaddy tests не подаються як production/deployed/real-Matrix evidence; Rust build/package/deployment automation не заявляється наявною до появи workspace, committed lockfile і artifact workflow.

## Gate Matrix

Якщо окремий gate record нижче не каже інакше, його Definition Status — `prepared`, Execution Status — `not_run`; жодний gate у цьому authoring pass не виконувався. `G-13` є inactive historical-integrity definition і не може бути load-bearing для current implementation або release.

| Gate | Primary evidence levels | Requirement coverage |
|---|---|---|
| `G-01 source_contract_integrity` | Static source inspection | Усі `FR`/`NFR`/`AC` |
| `G-02 ingress_authorization` | Unit, integration, E2E | `FR-001`; `NFR-007`; `AC-006` |
| `G-03 consent_and_data_safety` | Unit, integration, E2E | `FR-002`–`FR-006`, `FR-024`, `FR-035`; `NFR-006`, `NFR-008`; `AC-005`, `AC-007`, `AC-011` |
| `G-04 session_idempotency_and_generation` | Unit, integration, E2E | `FR-007`, `FR-020`, `FR-022`; `NFR-009`; `AC-004` |
| `G-05 real_consilium_runtime` | Integration, E2E | `FR-008`–`FR-012`, `FR-023`; `AC-001`, `AC-002`, `AC-007` |
| `G-06 canonical_a2a_verbatim_order` | Unit, integration, E2E | `FR-011`–`FR-019`; `NFR-009`–`NFR-011`; `AC-002`, `AC-003` |
| `G-07 timing_and_visible_progress` | Unit, integration, E2E | `FR-007`, `FR-015`, `FR-023`, `FR-024`; `NFR-001`–`NFR-004`; `AC-001`, `AC-002`, `AC-007` |
| `G-08 cancellation_and_late_output_suppression` | Unit, integration, E2E | `FR-020`–`FR-022`; `AC-004` |
| `G-09 truthful_result_and_action_contract` | Unit/manual eval, integration, E2E | `FR-025`–`FR-030`, `FR-035`, `FR-036`; `NFR-012`, `NFR-014`; `AC-001`, `AC-002`, `AC-007`, `AC-011` |
| `G-10 encrypted_archive_export_delete` | Unit, integration, E2E | `FR-031`, `FR-032`; `NFR-005`, `NFR-010`, `NFR-011`; `AC-003`, `AC-008` |
| `G-11 confirmed_cost_accounting` | Unit, integration, E2E | `FR-033`; `NFR-009`, `NFR-012`; `AC-009` |
| `G-12 native_element_matrix_client_behavior` | Integration, device E2E, manual | `FR-003`, `FR-015`, `FR-017`–`FR-019`, `FR-034`; `NFR-013`, `NFR-015`; `AC-003`, `AC-010` |
| `G-13 proposed_design_contract_fidelity` | Static/design inspection, prototype/device evidence | `FR-017`–`FR-019`, `FR-026`, `FR-036`–`FR-046`; `NFR-013`–`NFR-019`; `AC-003`, `AC-010`–`AC-016` |
| `G-14 matrix_e2ee_room_and_platform_isolation` | Static config, Rust/Node/MySQL integration, deployed evidence | `FR-001`, `FR-004`, `FR-005`, `FR-031`; `NFR-005`–`NFR-008`, `NFR-019`; `AC-005`, `AC-006` |
| `G-15 v1_real_matrix_e2e` | Real end-to-end across both product surfaces | `AC-001`–`AC-016` and all supporting `FR`/`NFR` |
| `G-16 approved_visual_baseline_fidelity` | Post-approval visual/device evidence | Post-approval integrated `SUR-01` + `SUR-02` user-visible frontend/full-stack/integration scope |
| `G-17 subscription_oauth_private_runtime` | Unit, integration, security, deployed E2E | `FR-009`, `FR-010`, `FR-030`, `FR-033`; `NFR-006`, `NFR-012`; `AC-002`, `AC-007`, `AC-009` |
| `G-18 owner_settings_access_security` | Unit, GoDaddy Node auth/session config, security integration, deployed E2E | `FR-037`–`FR-039`; `NFR-006`, `NFR-016`; `AC-012` |
| `G-19 owner_settings_atomic_configuration` | Unit, integration, provider/runtime, deployed E2E | `FR-040`–`FR-046`; `NFR-017`, `NFR-019`; `AC-013`–`AC-015` |
| `G-20 owner_settings_runtime_ux` | Deployed browser/device, accessibility, manual/hybrid | `FR-037`, `FR-040`–`FR-045`; `NFR-018`; `AC-016` |
| `G-21 heuristic_usability_review` | Expert manual review with route/state/viewport evidence | Applicable H1–H10 across primary Element and Settings journeys, error/recovery and accessible critical actions |
| `G-22 representative_user_task_validation` | Observed representative-owner task sessions | Critical, consequential, new or changed flows; `UV-01`–`UV-05`; applicable `AC-001`–`AC-016` |
| `G-23 product_security_requirements` | Implementation, security, integration and deployed E2E | Exactly `NFR-005`, `NFR-006`, `NFR-007`, `NFR-008`, `NFR-009`, `NFR-010`, `NFR-011`, `NFR-012`, `NFR-016`, `NFR-017`, `NFR-019` |

### `G-01 source_contract_integrity`

- **Gate:** `source_contract_integrity`
- **Purpose:** не дозволити stale або суперечливому source chain визначати Done.
- **Source References:** усі записи `Source References`; `docs/guardrails.md: Source Of Truth Order`.
- **Applies To:** кожний change, feature unit, PR/completion і release claim.
- **Required Evidence:** hashes актуальних source artifacts; diff/source review; exact coverage scan for `US=29`, `FR=46`, `NFR=19`, `AC=16`, `SUR=2`, `MG=13`, `SG=5`, `SS=46`, `SECURITY_REQUIREMENTS=11`; exact presence of the four mandatory gate headings; requirement-to-gate trace; explicit record of any superseded source.
- **Pass Condition:** hashes відповідають фактично прочитаним files; усі дев'ять coverage counts/ID ranges точні й без прогалин; mandatory visual/heuristic/representative-user/security definitions active where applicable; dependencies validated; конфліктів scope/term/authority немає або вони явно вирішені upstream.
- **Fail Or Block Condition:** source missing/stale, hash mismatch, silent conflict, untraced requirement або downstream rule змінює upstream scope.
- **Rerun Rule:** після кожної зміни будь-якого source artifact, approval receipt або architecture/config contract.
- **Automation Status:** `manual`; hash/coverage scan може бути automated після появи project tooling.

### `G-02 ingress_authorization`

- **Gate:** `ingress_authorization`
- **Purpose:** допустити protected processing лише для exact private room, exact owner mxid і verified/non-revoked devices після успішного E2EE decrypt.
- **Source References:** PRD `FR-001`, `NFR-007`, `AC-006`; guardrails `When To Stop`; architecture §§4–7, Rust sidecar, Node registrar/MySQL ingress receipts, room invariants and `AD-01`, `AD-14`, `AD-16`–`AD-20`.
- **Applies To:** кожний inbound Element/Matrix event та archive request.
- **Required Evidence:** unit cases для room/mxid/device normalization; integration receipts for wrong room, other mxid, unverified/revoked device, missing key and failed room invariant; E2E proof that denied input launches no agent lease, returns no protected data and changes no Active Session.
- **Pass Condition:** E2EE decrypt and all room/device invariants pass before protected processing; identity is rechecked at registrar; denied attempts produce no agent/runtime/archive effect.
- **Fail Or Block Condition:** plaintext fallback, room/device bypass, inconsistent identity, protected response, runtime launch, archive access or state mutation for unauthorized input.
- **Rerun Rule:** після bridge, crypto store, homeserver, room/device membership, identity normalization, routing or secret changes.
- **Automation Status:** `not available yet`.

### `G-03 consent_and_data_safety`

- **Gate:** `consent_and_data_safety`
- **Purpose:** enforce ordinary consent, independent permissions, safe input types, minimum context, secret rejection and conservative sensitive-document handling.
- **Source References:** PRD `FR-002`–`FR-006`, `FR-024`, `FR-035`, `NFR-006`, `NFR-008`, `AC-005`; guardrails `When To Ask`, `When To Stop`; architecture §§3–7, 9, 13–16 and Node registrar policy/secret boundaries.
- **Applies To:** text/image/PDF intake, sensitive document, >10-minute continuation, personal coaching boundary, external/high-risk action and deletion permission.
- **Required Evidence:** unit policy/state cases; integration proof that Secret is stopped before immutable storage/dispatch and not echoed; context-diff evidence per lease; E2E ordinary consent, supported attachments, unsupported type, secret, sensitive/uncertain document and separate permissions.
- **Pass Condition:** every permission is explicit and scope-bound; uncertain sensitive document waits for permission; Secret reaches no agent, canonical log, telemetry, archive or export; agents receive only bounded redacted context.
- **Fail Or Block Condition:** implicit/inherited permission, plaintext secret exposure, unsupported input analysis, unconfirmed sensitive processing, excess context or external/high-risk effect without named permission.
- **Rerun Rule:** після policy/classifier, prompt/context projection, attachment, permission or external-effect changes.
- **Automation Status:** `not available yet`; manual policy evidence remains required for classification boundaries.

### `G-04 session_idempotency_and_generation`

- **Gate:** `session_idempotency_and_generation`
- **Purpose:** preserve one Active Session, dedupe provider events and isolate generations/contexts.
- **Source References:** PRD `FR-007`, `FR-020`, `FR-022`, `NFR-009`, `AC-004`; architecture §§5–6, 9, 14–16, Node registrar, MySQL session/generation/outbox state and `AD-09`–`AD-10`, `AD-19`.
- **Applies To:** session creation/resume, clarification, duplicate Matrix event, `Нова задача` and recovery.
- **Required Evidence:** unit state-machine/dedupe cases; integration replay/concurrency evidence; E2E clarification remains in current Session and `Нова задача` creates a new generation without prior active context.
- **Pass Condition:** at most one Active Session; same provider event creates no duplicate session/work/message/cost; new generation rejects stale leases and context.
- **Fail Or Block Condition:** parallel Active Sessions, duplicate effects, context bleed, stale callback acceptance or ambiguous canonical generation.
- **Rerun Rule:** після session state, dedupe key, event routing, concurrency or recovery changes.
- **Automation Status:** `not available yet`.

### `G-05 real_consilium_runtime`

- **Gate:** `real_consilium_runtime`
- **Purpose:** distinguish a real separately executed Консиліум from role labels or one synthetic monologue.
- **Source References:** PRD `FR-008`–`FR-012`, `FR-023`, `AC-001`, `AC-002`, `AC-007`; architecture §§3–4, 9–10, Node registrar, isolated Codex/Claude processes and `AD-06`, `AD-10`–`AD-12`.
- **Applies To:** routing between Пряма відповідь and Консиліум and every claimed participant.
- **Required Evidence:** integration lease/start/heartbeat/end records for one head and 2–5 separate Codex thread/workspace identities inside one account runtime, plus one separate Claude Code process/workspace; bounded objectives; independent first-pass evidence; E2E visible concrete roles, critic contribution, addressed discussion and truthful unavailable/replacement path. OAuth values are excluded from evidence.
- **Pass Condition:** simple request avoids needless roster; every visible Codex role maps to a distinct current thread/workspace/lease, critic maps to a distinct Claude process, and full Консиліум has the required roster and independent-first-pass behavior. A shared OAuth account does not collapse agent identity, and separate agents do not require cloned credential stores.
- **Fail Or Block Condition:** fabricated role, shared impersonating process, missing critic, direct unleased message, false successful Консиліум or concealed replacement/failure.
- **Rerun Rule:** після routing, roster, runtime adapter, process image/config, lease or critic changes.
- **Automation Status:** `not available yet`; real-process evidence cannot be replaced by unit mocks.

### `G-06 canonical_a2a_verbatim_order`

- **Gate:** `canonical_a2a_verbatim_order`
- **Purpose:** prove registrar-mediated addressed A2A, exact immutable body, canonical order and dedupe.
- **Source References:** PRD `FR-011`–`FR-019`, `NFR-009`–`NFR-011`, `AC-002`, `AC-003`; architecture §§5–6, 9, 14–16, Node registrar, MySQL confirmed-message/ordered-outbox state and `AD-10`–`AD-11`, `AD-19`.
- **Applies To:** every agent envelope, target route, visible reply, correction, archive and export.
- **Required Evidence:** unit envelope/sequence/hash/dedupe cases; integration proof that every draft passes registrar before target/outbox; bypass rejection; E2E byte- or canonical-text comparison of role/body/order across registered envelope, visible Element/Matrix content, archive and export, accounting for documented transport segmentation.
- **Pass Condition:** unique current-lease draft is atomically confirmed, sequenced and integrity-linked before routing; body is unchanged; correction is new envelope; duplicates/bypass/stale generation are rejected.
- **Fail Or Block Condition:** direct A2A, edited/truncated/hidden body, reordered/duplicated envelope, post-hoc transcript, unexplained segmentation drift or unverifiable integrity head.
- **Rerun Rule:** після envelope schema, registrar transaction, formatter, outbox, segmentation, archive or export changes.
- **Automation Status:** `not available yet`.

### `G-07 timing_and_visible_progress`

- **Gate:** `timing_and_visible_progress`
- **Purpose:** enforce and separately measure 5-second acknowledgement, 30-second first agent reply, 60-second visible-progress interval and 10-minute standard-session boundary.
- **Source References:** PRD `FR-007`, `FR-015`, `FR-023`, `FR-024`, `NFR-001`–`NFR-004`, `AC-001`, `AC-002`, `AC-007`; architecture timers/alarms and observability hooks.
- **Applies To:** accepted direct request, accepted consilium request, active progress loop and continuation permission.
- **Required Evidence:** unit timer boundary cases; integration monotonic timestamps from ingress/registrar/outbox/runtime; E2E timeline from accepted request to visible events, including missed-boundary failure/permission behavior.
- **Pass Condition:** acknowledgement ≤5s; first visible confirmed agent reply ≤30s; no active interval >60s without confirmed reply or truthful explanation; by 10m final result exists or reason plus explicit continuation permission state is visible.
- **Fail Or Block Condition:** threshold breach, synthetic progress, missing timestamp correlation, silent wait, continued work beyond 10m without permission or provider acceptance misreported as visible delivery.
- **Rerun Rule:** після timing, queue, runtime, outbox, retry, provider or progress-copy changes; repeat under representative load.
- **Automation Status:** `not available yet`; device-visible E2E remains required.

### `G-08 cancellation_and_late_output_suppression`

- **Gate:** `cancellation_and_late_output_suppression`
- **Purpose:** make `Стоп` authoritative for publication/cost control and `Нова задача` authoritative for generation isolation.
- **Source References:** PRD `FR-020`–`FR-022`, `AC-004`; guardrails `When To Stop`; architecture §§5–6, 9, 12–13, Node registrar/MySQL generation fencing and recovery rules.
- **Applies To:** active runtime leases, queued commands, callbacks, visible outbox and session generation.
- **Required Evidence:** unit priority/state cases; integration cancel command, lease revocation, closed publication gate and injected late callback; E2E `Стоп` and `Нова задача` with no late visible tail or context mix.
- **Pass Condition:** no new model call after accepted `Стоп`; supported cancellation attempted; all late outputs suppressed from canonical/visible log; new task has fresh generation/leases/context.
- **Fail Or Block Condition:** post-stop call/publication, stale cost counted as continued work without classification, old context/lease accepted or ambiguous command result.
- **Rerun Rule:** після command parser, state priority, runtime cancel, outbox, generation or retry changes.
- **Automation Status:** `not available yet`.

### `G-09 truthful_result_and_action_contract`

- **Gate:** `truthful_result_and_action_contract`
- **Purpose:** ensure evidence-calibrated direct/final results, visible failures and practical action contract.
- **Source References:** PRD `FR-025`–`FR-030`, `FR-035`, `FR-036`, `NFR-012`, `NFR-014`, `AC-001`, `AC-002`, `AC-007`, `AC-011`; AGENTS truth/action rules normalized by PRD.
- **Applies To:** direct response, progress/failure messages and Фінальна рекомендація.
- **Required Evidence:** unit/content-schema checks where deterministic; manual eval against representative direct, consilium, insufficient-evidence, runtime-failure and high-risk cases; integration failure injection; E2E final sequence and permission boundary.
- **Pass Condition:** facts/user information/assumptions/judgment/unknown are separated when material; AI agreement is not independent evidence; failure and limits are explicit; final has one result, ≤3 actions, risk/condition, and self-contained Technical part only when needed; external effect remains gated.
- **Fail Or Block Condition:** invented source/result/reply, hidden partial state, unsupported certainty, raw unsynthesized monologues, >3 active priorities, missing material action fields or external action without permission.
- **Rerun Rule:** після prompt/policy, synthesis, failure handling, source tool or final-format changes; rerun affected scenario set.
- **Automation Status:** `manual` with future deterministic schema automation where applicable.

### `G-10 encrypted_archive_export_delete`

- **Gate:** `encrypted_archive_export_delete`
- **Purpose:** prove encrypted immutable archive, verified full export and confirmed whole-session deletion without false provider-retention claims.
- **Source References:** PRD `FR-031`, `FR-032`, `NFR-005`, `NFR-010`, `NFR-011`, `AC-003`, `AC-008`; architecture §§5.1, 9–10, 12–14 and `AD-11`–`AD-13`.
- **Applies To:** input blobs, normal completion, archive/read/export/delete and recovery.
- **Required Evidence:** unit manifest/hash/delete transitions; integration application-layer encryption before MySQL persistence, archive-key separation, ciphertext/nonce/authenticated-manifest inspection, transaction/read-back hash verification, tamper/wrong-key/key-outage, tombstone/export/delete verification; E2E body/order comparison and double-confirmed whole-session deletion.
- **Pass Condition:** only verified archive transition marks Session completed; stored objects are ciphertext; sequence/count/integrity head recompute; export is complete/order-preserving; individual reply remains immutable; whole-session deletion occurs only after explicit confirmation and verified removal with honest retention disclosure.
- **Fail Or Block Condition:** plaintext object/key, unverified success, missing/reordered body, editable reply, deletion without confirmation, unverifiable removal or claim that provider-held copies were deleted without evidence.
- **Rerun Rule:** після crypto/key, MySQL archive schema/transaction, manifest/tombstone, archive state, export, deletion or retention-policy changes.
- **Automation Status:** `not available yet`; security claims require config inspection plus runtime evidence.

### `G-11 confirmed_cost_accounting`

- **Gate:** `confirmed_cost_accounting`
- **Purpose:** show truthful subscription, infrastructure and provider-limit status without inventing a per-session model charge.
- **Source References:** PRD `FR-033`, `NFR-009`, `NFR-012`, `AC-009`; guardrails `Scope Boundaries`, `Evidence Requirements`; architecture §§9, 13–14.
- **Applies To:** configured subscription-fee records, infrastructure invoices/usage, provider-reported usage/limit/reset and every `Витрати` response (`MG-09`, `SS-14`).
- **Required Evidence:** unit currency/period/dedupe/unavailable-state cases; integration reconciliation of configured ChatGPT/Codex and Claude monthly fees, actual `matrix.org`, GoDaddy Node/MySQL and other current infrastructure spend, plus exposed provider usage/limit/reset; E2E `Витрати` response for complete and unavailable/partial feeds.
- **Pass Condition:** configured monthly subscription fees and actual infrastructure spend are separately labeled, deduplicated and period-correct; provider usage/limit/reset is shown only when exposed; session AI use is `входить у підписку; окремо не атрибутується`; missing data is `невідомо`.
- **Fail Or Block Condition:** estimate shown as actual, invented per-session token charge, API/PAYG/credit amount, duplicate spend, missing currency/period, untraceable total, concealed incompleteness, invented reset or hard budget claim.
- **Rerun Rule:** після subscription configuration, infrastructure billing feed, provider usage/limit/reset adapter, currency, period or aggregation changes.
- **Automation Status:** `not available yet`.

### `G-12 native_element_matrix_client_behavior`

- **Gate:** `native_element_matrix_client_behavior`
- **Purpose:** prove V1 works in native Element/Matrix clients and describe platform variance honestly.
- **Source References:** PRD `FR-003`, `FR-015`, `FR-017`–`FR-019`, `FR-034`, `NFR-013`, `NFR-015`, `AC-003`, `AC-010`; design brief Responsive/Platform Behavior.
- **Applies To:** Mac, iPhone, Samsung Flip7/Android and Windows PC clients; text/image/PDF, long replies and native formatting.
- **Required Evidence:** real room/event/reply receipts; device matrix with Element/OS versions, screenshots or recordings plus transcript comparison; role/`HH:MM`, native reply, long body, attachments, formatting, recovery and offline/reconnect behavior.
- **Pass Condition:** one private E2EE room supports the required flow on all four client families; full body/order and plain-text meaning persist; Element/OS alone owns delivery and notification sounds.
- **Fail Or Block Condition:** browser UI required, body lost/changed, reply relation wrong, critical meaning depends only on formatting, custom product sound exists or an unreported client limitation breaks the primary flow.
- **Rerun Rule:** після Matrix event/formatter/reply changes and when a target Element/OS version materially changes.
- **Automation Status:** `manual`; some payload comparison may later be automated.

### `G-13 proposed_design_contract_fidelity`

- **Gate:** `proposed_design_contract_fidelity`
- **Purpose:** preserve historical integrity of proposed candidates without redefining the approved visual baseline.
- **Source References:** historical `docs/wireframes.md` / `docs/design-brief.md` proposed-contract lineage.
- **Applies To:** historical pre-approval Candidate Mockup artifacts only; never substitutes `G-16` for implementation/release scope.
- **Required Evidence:** original historical candidate coverage and `proposed` metadata.
- **Pass Condition:** the historical artifact is not rewritten as if it were the active baseline.
- **Fail Or Block Condition:** a historical candidate is relabeled as the active baseline or used as visual evidence for a new implementation unit.
- **Rerun Rule:** only if historical evidence integrity is challenged.
- **Automation Status:** `manual`.

### `G-14 matrix_e2ee_room_and_platform_isolation`

- **Gate:** `matrix_e2ee_room_and_platform_isolation`
- **Purpose:** verify Matrix E2EE, exact room/device invariants, persistent bot crypto state and strict Rust-sidecar/Node/MySQL isolation without claiming an external audit or hiding the bot-decryption boundary.
- **Source References:** PRD `FR-001`, `FR-004`, `FR-005`, `FR-031`, `NFR-005`–`NFR-008`, `NFR-019`, `AC-005`, `AC-006`; architecture §§3–7, 9–14, `AD-01`, `AD-10`, `AD-13`–`AD-21`.
- **Applies To:** `matrix.org` room, Element and bot devices, Rust sidecar/bounded NDJSON/media spool, encrypted SQLite store, Node supervisor/registrar, MySQL ingress/outbox/archive state, agent workspaces, fixed outbound handlers, telemetry and archive-key boundary.
- **Required Evidence:** real E2EE and ciphertext homeserver evidence; exact room/membership/invite/history/public-alias/guest/bridge/widget/device checks on ingress and immediately before send; production Rust binary checksum/protocol handshake/exclusive store lock; fresh-device+empty-store and exact device+encrypted-store restore cases; corrupt/wrong-passphrase/mismatch/quarantine negatives without automatic reset; private-path non-retrievability; bounded NDJSON/media spool size/hash/MIME/TTL/symlink cases; fixed HTTPS origin/no-downgrade/no-caller-discovery egress tests; Node durable ACK/MySQL replay and deterministic transaction-ID evidence; application-encrypted MySQL archive and content-free telemetry; secret scan covering Matrix/OAuth tokens, crypto-store passphrase, Google/local-session material, `auth.json`, setup-token, reauth URL/code, prompts, A2A, logs, archives, exports and repository artifacts.
- **Pass Condition:** only exact trusted cross-signed non-revoked devices decrypt; homeserver sees ciphertext; room invariants pass twice; exactly one sidecar process owns the matching encrypted store; lost/mismatched state blocks readiness without reset; private IPC/spool bounds and fixed egress hold; Node/MySQL receive only bounded authorized events and preserve durable order/idempotency; agents have scoped leases and no Matrix/archive/OAuth checkpoint credentials; MySQL archive is application-encrypted; telemetry is content-free; OAuth plaintext exists only inside its authorized process boundary.
- **Fail Or Block Condition:** unknown member/invite, public alias/guest/bridge/widget, missing/revoked device accepted, lost keys bypassed, second store owner, token/device restored without exact store, public/retrievable private path, unbounded/malformed IPC or media, caller-controlled Matrix target/redirect, credential leakage, arbitrary egress, body in telemetry, plaintext MySQL archive, OAuth material in Matrix/agent context/evidence or unapproved external effect.
- **Rerun Rule:** після homeserver/room/device, Rust SDK/binary/protocol/store/lock/spool, Node supervisor/registrar, MySQL receipt/outbox/archive, deployment/private path, permission, egress, telemetry, archive crypto/key, backup/restore or rollback changes.
- **Automation Status:** `not available yet`; наявні Rust/Node tests можуть перевіряти частину protocol/store/path/egress і MySQL обов'язків, while real room/device/E2EE/restore evidence remains controlled manual or hybrid.
- **Definition Status:** `prepared`.
- **Execution Status:** `not_run`.

### `G-15 v1_real_matrix_e2e`

- **Gate:** `v1_real_matrix_e2e`
- **Purpose:** provide the highest accepted evidence that V1 works as the intended product.
- **Source References:** PRD §9 and `AC-001`–`AC-016`; guardrails `Verification Rules/Evidence Requirements`; architecture full two-surface runtime topology.
- **Applies To:** Product V1 release claim.
- **Required Evidence:** one versioned E2E evidence bundle covering every `AC-001`–`AC-016`: real private E2EE Matrix room and native Element paths; exact owner/bot identities and verified devices; production Rust sidecar with matching encrypted store and bounded private protocol; deployed GoDaddy Node 22 supervisor/registrar/settings runtime; real local Google OIDC/локальна підписана сесія `SUR-02`; MySQL settings/session/order/outbox/application-encrypted archive; one fenced Codex OAuth lineage with distinct real Codex threads/workspaces; separate Claude setup-token process; configured A2A adapter; truthful subscription/infrastructure/quota evidence; `G-18`–`G-23` results on the same deployment lineage.
- **Pass Condition:** all sixteen scenarios pass; related lower-level hard gates pass on the same source/config lineage; no blocking finding remains; limitations are explicit.
- **Fail Or Block Condition:** any AC missing/failed; mock-only homeserver/sidecar/GoDaddy/MySQL/provider/runtime; local/static Settings substituted for deployed protected `SUR-02`; browser-preview substituted for Element; missing room/device/owner-auth/provider evidence; stale lineage; hidden partial state; unpassed mandatory visual/heuristic/representative-user/security gate; unsupported completion claim.
- **Rerun Rule:** full rerun for release candidate after changes to shared Rust-sidecar protocol/store, Node registrar/state/security, MySQL outbox/archive, agent runtime or cross-surface contract; otherwise rerun impacted AC plus regression set defined by future QA.
- **Automation Status:** `not available yet`; real providers/devices require controlled manual or hybrid execution.
- **Definition Status:** `prepared`.
- **Execution Status:** `not_run`.

### `G-16 approved_visual_baseline_fidelity`

- **Gate:** `approved_visual_baseline_fidelity`
- **Purpose:** bind post-approval user-visible frontend/full-stack/integration units across both product surfaces to the one immutable whole-design baseline.
- **Source References:** guardrails `Design Authority Rules`; design brief `Approved Visual Baseline` (`PC-MATRIX-CANDIDATE-B-V2-20260816-R1`).
- **Applies To:** active hard gate for every user-visible frontend, full-stack or integration unit that affects `SUR-01` or `SUR-02`.
- **Required Evidence:** active Baseline ID; immutable visual target path/hash; frozen source root/tree hash/algorithm; approval receipt; affected routes/states/viewports; permitted variance and `DB-D18`/`DB-D19`; concrete QA IDs after QA authoring; fresh `VisualQAEvidence`; `PrototypePromotionReceipt` only when approved prototype code is reused.
- **Pass Condition:** поточні target/render hashes і покриття узгоджені; DB-D18/DB-D19 виконані без іншого material drift; немає P0/P1/blocking P2. Прототип сам не доводить нову auth/model реалізацію.
- **Fail Or Block Condition:** stale/superseded baseline, відсутній hash/receipt/coverage, необґрунтований drift, повернення скасованих password/Cloudflare/shared-effort сценаріїв або вживання DB-D18/DB-D19 для зміни цілого дизайну.
- **Rerun Rule:** after every affected user-visible change, baseline supersession, approved override or client-variance change.
- **Automation Status:** `not available yet`.
- **Definition Status:** `prepared`.
- **Execution Status:** `not_run`.
- **Binding Status:** `baseline_bound`; concrete QA bindings `pending_qa`.
- **Baseline ID:** `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`.
- **Immutable Visual Target:** `forge/design/candidates/candidate-b/v2/index.html`.
- **Immutable Target SHA-256:** `07e3675265e8cadef1e65c132f32e3cbbf4d6537cbfd316ea16a6bacd56f1bd6`.
- **Frozen Prototype Source Root:** `forge/design/candidates/candidate-b/v2`.
- **Tree Hash Algorithm:** `sdd-render-sha256-v2`.
- **Frozen Source Tree Hash:** `57d103c5ed17bcc9a9d95a58718f83c33b8257229fc825b756367321eaa33199`.
- **Render Dependencies And Binding Receipt:** обидва точні scenario-fixture.js та їхні hashes — у канонічному Approved Visual Baseline; `forge/design/evidence/candidate-b/v2/approval-render-binding-20260905.json`. Поточна прив'язка не доводить безперервної тотожності кореня від 16.08.2026; невідтворений legacy hash залишається явним історичним обмеженням.
- **Approval Receipt:** `forge/design/evidence/candidate-b/v2/approval-receipt.json`.
- **Affected Routes States And Viewports:** `SUR-01`–`SUR-02`, `MG-01`–`MG-13`, `SG-01`–`SG-05`, `SS-01`–`SS-46` and 390/430/768/1280/1440 px.
- **Permitted Variance And Operator Overrides:** нативні Element/ОС відмінності й responsive reflow; лише DB-D18/DB-D19 замінюють access/provider частини frozen demo на чинні Google/local-session та незалежні model/effort contracts. Палітра, one-page utility, Matrix-подача й original approval збережені.
- **QA Check IDs:** `pending_qa`; no IDs invented during DoD authoring.
- **Historical VisualQAEvidence References:** `forge/design/evidence/candidate-b/v2/visual-qa.json` and its four listed screenshots prove the approved frozen candidate only; because they retain superseded auth-copy, fresh implementation evidence must demonstrate `DB-D18`/`DB-D19`.
- **PrototypePromotionReceipt:** not applicable until approved prototype code is reused.

### `G-17 subscription_oauth_private_runtime`

- **Gate:** `subscription_oauth_private_runtime`
- **Purpose:** prove that all Codex and Claude Code work uses only the Власник's eligible paid subscriptions through the authorized private single-owner runtime, with safe credential lifecycle and no API/PAYG/cloud-provider fallback.
- **Source References:** PRD §3.1/§3.5, `FR-009`, `FR-010`, `FR-030`, `FR-033`, `NFR-006`, `NFR-012`, `AC-002`, `AC-007`, `AC-009`; guardrails `Forbidden Changes`, `When To Stop`, `Verification Rules`, `Evidence Requirements`; architecture §§3–4, 9–10, 12–14, isolated Codex/Claude process boundaries and `AD-06`–`AD-08`, `AD-12`; wireframes `SS-28`, `SS-29`, `MG-09`, `MG-11`.
- **Applies To:** bootstrap, deployment, rollback, every dependent model call/agent launch, OAuth refresh/checkpoint/reauth/revocation, quota/plan check, `Витрати`, and any Product V1 release claim.
- **Required Evidence:** current plan/terms eligibility evidence for exact one-owner private non-SaaS use; one content-free Codex lineage ID with sealed checkpoint version/hash, exactly one fenced writer lease, managed refresh/CAS/checkpoint/restore lifecycle, concurrent-writer denial, crash recovery and revocation tests; distinct real head/specialist Codex thread IDs, workspaces and leases sharing that lineage without cloned `auth.json`/OAuth caches; separate Claude Code process/workspace with `claude auth status` confirming subscription OAuth from out-of-band setup-token; environment/config inspection and negative launch cases proving `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, Bedrock, Vertex, Foundry, custom endpoint, API/PAYG/credits and other higher-precedence provider auth are absent and blocked; positive `SS-28`; injected unknown auth mode, expiry, revocation, refresh/checkpoint failure, invalid setup-token, quota exhaustion and ineligible/third-party cases; content-free secret scan over Matrix, prompts, A2A, logs, telemetry, archive, export, repository, images and workspaces; safe out-of-band reauth and fresh-preflight recovery; cost evidence required by `G-11`. Evidence records metadata only, never credentials, codes or auth URLs.
- **Pass Condition:** exactly one mutable Codex OAuth lineage and active credential writer exist; all Codex agents have distinct real contexts without credential-store clones; Claude critic is a separate subscription-OAuth process; exact one-owner private eligibility and quota pass immediately before each dependent call; forbidden auth variables/routes are absent and cannot activate; every negative case blocks before a new model call/reply, emits only safe `SS-29`, preserves confirmed messages and resumes only after provider-managed out-of-band recovery plus fresh `SS-28`; revocation makes old versions unusable; no credential material escapes its authorized runtime boundary; costs follow `G-11`.
- **Fail Or Block Condition:** multiple writers or mutable lineages, copied/reused `auth.json`/OAuth cache, shared/fabricated agent context, missing Claude process, API key/PAYG/cloud-provider/credit fallback, unknown or ineligible plan treated as pass, model call after auth/quota failure, credential/reauth material in Matrix or evidence, stale checkpoint accepted, revoked version reusable, third-party/client/employee/shared/SaaS use, invented AI token charge or unverified recovery.
- **Rerun Rule:** after any auth library/app-server/Claude CLI/runtime image, credential vault/checkpoint/fence, environment/egress, plan/terms, quota adapter, thread/workspace lifecycle, cost feed, deployment or rollback change; after auth/quota/revocation failure rerun the negative case, fresh `SS-28`, affected integration gates and `G-15` before release.
- **Automation Status:** `not available yet`; deterministic environment, fencing, state and leak checks may be automated, but current plan eligibility, provider-managed auth status, revocation/reauth and deployed E2E evidence require controlled manual or hybrid verification.

### `G-18 owner_settings_access_security`

- **Gate:** `owner_settings_access_security`
- **Purpose:** підтвердити Google-only доступ лише дозволеного Власника до кожного захищеного ресурсу та запиту через окрему серверну сесію, без зв'язування доступу з готовністю AI/catalog.
- **Source References:** PRD `UC-003`, `FR-037`, `FR-038(a–d)`, `FR-039(a–c)`, `NFR-006`, `NFR-016.a`–`NFR-016.h`, `AC-012(a–f)`; архітектура §8.1–8.4, §10, §14, AD-22/AD-23; design brief DB-D18/DB-D19; SS-30–SS-33/SS-45.
- **Applies To:** start/callback, локальний вихід і відкликання, усі protected runtime/Settings routes/assets/API, durable transaction/session storage, fixed origin, cookies/headers, ліміти, конфігурація та очищені діагностики.
- **Required Evidence:** для кожного рядка нижче — окремі позитивні, негативні й відновлювальні результати на відповідній межі, конфігураційний fingerprint без значень секретів і реальний same-tab браузерний вхід. Усі точні строки/розміри/ліміти беруться з §8 архітектури; цей gate їх не змінює.
- **Pass Condition:** кожен застосовний рядок пройдено; стороння ідентичність, недійсний токен/транзакція/сесія або підроблений запит не відкривають даних і не виконують змін; Google/local/AI lifecycle розділені. Після login перевірено обидва визначені redirects залежно від каталогу.
- **Fail Or Block Condition:** відсутня перевірка пункту, обхід, повторна/конкурентна видача, resurrection після restart/disable/re-enable, витік, кешована захищена відповідь, парольний fallback, залежність входу від AI readiness або автоматична зміна AI OAuth.
- **Rerun Rule:** після auth/identity/transaction/session/storage/configuration/origin/header/route/dependency/deployment/rollback зміни повторити всю матрицю та зачеплені G-15/G-20–G-23.
- **Automation Status:** `not available yet` для всього gate; збережені session regression tests — частковий локальний засіб, Google verifier/protocol та deployed browser cases потребують реалізації й контрольованого виконання.
- **Definition Status:** `prepared`.
- **Execution Status:** `not_run`.

| Пункт | Окремий потрібний доказ |
|---|---|
| NFR-016.a | Підпис/RS256, trusted Google keys/issuer, точні audience/azp і строки; ID Token, не access token; відмова за forged/malformed/невідомим ключем/issuer/jku/x5u, bounded trusted refresh без fail-open |
| NFR-016.b | Exact preauthorized verified email та stable issuer/sub; сторонній перший login, alias/display-name/login_hint або інший sub не прив'язує Власника; жодних raw identity у доказах |
| NFR-016.c | Лише явний same-origin POST start; state/browser/nonce/PKCE, TTL, claim-before-exchange, duplicates/oversize, replay/concurrent callback/crash/timeout/cancel; новий flow для retry, не повторне використання |
| NFR-016.d | Новий random signed reference, server registry на кожному protected request, rotation і припинення старої сесії браузера; відмова forged/expired/revoked reference й усіх password-era sessions |
| NFR-016.e | Idle/absolute expiry, session cap, logout/revoke-all, durable generation, restart/lock-wait, disable з key rotation і re-enable без resurrection; локальний вихід не є Google logout і не змінює AI OAuth |
| NFR-016.f | Host-only Secure/HttpOnly/SameSite=Lax, same-tab cross-site callback, CSRF/Origin/Fetch Metadata для локальних змін, GET read-only, fixed HTTPS origin за GoDaddy proxy, no-store усіх відповідей/redirect/error, CSP/frame/HSTS/nosniff/referrer; URL/log/storage без секретів |
| NFR-016.g | Durable browser/global limits і pending cap, restart/новий браузер не обходять глобальну межу; обмежені network/body/JWKS/DB ресурси, Retry-After й відновлення без permanent lockout; очищені security events |
| NFR-016.h | Відсутність власного MFA/password fallback за PI-AUTH-20260905; мінімальна сила без перевіреного provider evidence, немає заяви про MFA/повну ASVS-відповідність; решта компенсацій пройдена |

FR-038(a), FR-038(b), FR-038(c), FR-038(d) відповідно перевіряються через identity, одноразову транзакцію, protected request/session та незмінні app/hostname/мінімальні scopes/Google-only межі. FR-039(a), FR-039(b), FR-039(c) окремо потребують доказу ізоляції credential domains, відсутності витоку та незмінності AI OAuth після login/deny/logout/relogin. Окремо явна захищена дія налаштування AI-підписки не заборонена і не імітується побічним ефектом входу.

### `G-19 owner_settings_atomic_configuration`

- **Gate:** `owner_settings_atomic_configuration`
- **Purpose:** prove that Owner Settings exposes exactly three allowed groups, validates current provider capabilities without silent downgrade, persists/reset them all-or-nothing and binds only the next new Session to one immutable effective snapshot.
- **Source References:** PRD `FR-040`–`FR-046`, `NFR-017`, обидві частини `NFR-019`, `AC-013`–`AC-015`; guardrails `Forbidden Changes`, `When To Stop`, `Verification Rules`, `Evidence Requirements`; архітектура §5.1, §8.4, §9–10, §12–14, AD-23; screen-map `SG-02`–`SG-05`, `SS-34`–`SS-45`.
- **Applies To:** Settings schema/defaults/read/save/reset/cancel, capability and speed-policy catalogs, provider/runtime reconciliation, revision/CAS/idempotency/audit, offline/retry/recovery, session creation and every model/depth/speed change.
- **Required Evidence:** deployed GET schema/result showing only separate typed Codex and Claude selectors, independent per-model provider-specific effort controls, exact confirmed model versions (Claude Opus→Sonnet→Haiku, newest confirmed first), model-default omitting explicit effort, one `швидко|збалансовано|ретельно` preset and separately labeled current/default/effective/active-snapshot values; signed/versioned release catalog and live content-free Codex app-server plus Claude Code subscription-runtime capability receipts for each allowlisted model/effort mapping, availability/provenance/freshness and unsupported/unknown/deprecated/retired/drift cases; negative arbitrary slug, extra key/fourth group, shared selector, per-agent/per-unit override and every cross-field incompatibility; full-object validate-before-save/reset evidence for success and every invalid field, source-backed defaults, explicit reset, cancel/no-write, version conflict, failed MySQL transaction, timeout-after-commit, offline, exact idempotent retry, reused key/different body and concurrent saves, with before/after version/hash proving one MySQL commit or none; content-free server audit proving actor `owner`, operation, before/after version, catalog version, request hash and result without settings body/password/session/secret; all three speed-policy runtime fingerprints showing only source-backed orchestration changes and no Claude Fast Mode, OpenAI priority/Fast tier, API/PAYG, extra usage/credits or weakening of critic/A2A/E2EE/verbatim/research/safety/privacy/permission/timing guards; session-start evidence pairing one validated settings/catalog version to a complete immutable MySQL snapshot, plus save/reset during active A, next-session B, incompatible C, concurrent save/start and catalog-drift cases.
- **Pass Condition:** response and server schema contain exactly three groups and typed values; both current subscription runtimes confirm the exact mappings at save and again at new-session preflight; unsupported/unknown/stale state blocks save/start with no downgrade; save/reset commits one new full revision or none; CAS and idempotency prevent lost/duplicate/partial writes; cancel/offline never mutate state; shown effective values match the committed revision; Active Session A never changes, the next valid Session receives exactly B, and C/drift starts no Session; every speed preset preserves all mandatory invariants and excluded paid modes remain technically blocked.
- **Fail Or Block Condition:** arbitrary/provider-mismatched value; fourth/hidden/forbidden control; documentation-only capability claim without live provider/runtime evidence; silent effort fallback; stale catalog accepted; partial/per-key write; false success; lost update, duplicate revision or non-idempotent retry; reset bypasses validation; body/email/secret in audit; active snapshot mutation; session start without a complete validated snapshot; any Fast/priority/API/PAYG/extra-usage path or weakened mandatory invariant.
- **Rerun Rule:** after Settings schema/default/catalog/provider mapping/speed policy, runtime/model/entitlement, API/MySQL transaction/CAS/idempotency/audit, offline/client retry, session resolver/Node registrar snapshot, invariant/preflight, deployment or rollback change; rerun impacted `AC-013`–`AC-015`, `G-05`–`G-09`, `G-15`, `G-17`, `G-20`–`G-23` as applicable.
- **Automation Status:** `not available yet`; schema/state/CAS/idempotency/snapshot invariants can become automated, but live subscription-runtime capability reconciliation, deployed atomicity/failure injection and cross-runtime invariant evidence require controlled integration/hybrid execution.
- **Definition Status:** `prepared`.
- **Execution Status:** `not_run`.

### `G-20 owner_settings_runtime_ux`

- **Gate:** `owner_settings_runtime_ux`
- **Purpose:** prove the deployed `SUR-02` is a usable responsive and accessible single-page Owner Settings surface without expanding product scope or treating a static design artifact as runtime evidence.
- **Source References:** PRD `FR-037`, `FR-040`–`FR-045`, `NFR-018`, `AC-016`; wireframes `SUR-02`, `SG-01`–`SG-05`, `SS-30`–`SS-46`; design brief `DB-D18`/`DB-D19`, `P-11`–`P-15`, Accessibility Floor, Responsive And Platform Behavior; architecture §§2–4, 8, 12; guardrails `Verification Rules`, `Evidence Requirements`.
- **Applies To:** every user-visible Settings route/control/status and each `SUR-02` release across 390/430/768/1280/1440 representative viewports, keyboard path and supported assistive-technology/browser combinations recorded by evidence.
- **Required Evidence:** recordings/screenshots plus DOM/accessibility-tree and network/result correlation from the deployed GoDaddy hostname covering same-tab Google start/callback/cancel/retry, grant/deny/session-expiry/revocation, Settings loading, loaded/empty-effective, dirty valid, inline incompatible, provider drift, save progress/success/failure, reset confirmation/result, immutable-active-snapshot notice, offline/reconnect, long model/mapping/error content and mobile reflow; keyboard-only traversal and activation; programmatic names/labels/descriptions/error associations, logical focus and return after confirmation, visible focus ring, live status/error announcements, text zoom/reflow, no color/motion/sound-only meaning, ≥24×24 CSS px targets and 44×44 primary touch target/equivalent on 390/430; semantic order and no horizontal loss of critical action; exact visible inventory of three groups, primary Save, secondary Reset/cancel and current/default/effective values; `G-18`/`G-19` runtime receipts linked so visual success/denial is not inferred from appearance.
- **Pass Condition:** the full `SS-30`–`SS-46` semantic contract is operable and understandable on representative mobile/desktop paths; every control/status has an accessible text/programmatic equivalent; long/zoomed content preserves group/value/error/action relationships; no required action is hover-, color-, motion- or sound-only; only one one-page Settings utility exists, with no sidebar/dashboard/chat/archive/admin surface, agent/provider credential field, alternate login, free-text/Fast/PAYG/safety control; observed UI result matches the corresponding access/atomic/provider evidence.
- **Fail Or Block Condition:** primary Settings path unusable by keyboard/assistive technology; unlabeled or unreachable Google-вхід/control; invisible/lost focus; unannounced verification/validation/save/denial; color-only status; clipped critical action/content; mobile omission; extra group/surface/navigation/forbidden control; alternate login/registration/recovery/identity UI; password/session secret shown after submit; visual success without committed state or protected content visible after failed access.
- **Rerun Rule:** after any Settings HTML/CSS/JS/auth-copy/content/control/validation/status/focus/responsive/accessibility, browser hardening that changes rendering, state-contract, viewport/browser support, design source, deployment or baseline change; rerun affected states/viewports, `G-18`, `G-19`, `G-15`, `G-16`, `G-21`, `G-22` and `G-23` when applicable.
- **Automation Status:** `not available yet`; automated accessibility/browser checks may contribute later, but real deployed keyboard/assistive-tech/device evidence and manual semantic review remain required.
- **Definition Status:** `prepared`.
- **Execution Status:** `not_run`.

### `G-21 heuristic_usability_review`

- **Gate:** `heuristic_usability_review`
- **Purpose:** require an expert, rule-based review of every applicable H1–H10 scope without treating visual fidelity, representative-user research, runtime behavior or accessibility conformance as equivalent evidence.
- **Source References:** design brief `Heuristic Review`; user journey primary Element and Settings journeys; screen map `SUR-01`–`SUR-02`, `SS-01`–`SS-46`; wireframes `Error And Recovery Contract`; shared H1–H10 and verification contracts.
- **Applies To:** every user-visible change and Product V1 release across `SUR-01`/`SUR-02`, primary journey/task, supported desktop/mobile scope, normal/loading/empty/error/success/permission/offline/long-content/recovery states and accessibility-critical actions.
- **Required Evidence:** concrete QA IDs after QA authoring; actual named reviewer/time; implementation revision/environment; each applicable H1–H10; primary journey/task/user group; screen/route/state/viewport/device; expected behavior and applicability rationale; observed evidence; findings/recommendations with severity/release effect. Error scopes additionally record cause → preserved state → next action → retry/undo → successful-completion condition.
- **Pass Condition:** every applicable H1–H10 and required scope has fresh readable review evidence; supported mobile/desktop and critical error/recovery/accessibility paths are covered; no unexplained omission/deferred critical review or blocking finding remains.
- **Fail Or Block Condition:** applicable heuristic/scope omitted; design-plan `covered` treated as executed; visual screenshot substituted for behavior; error recovery lacks a required element without source-backed rationale; missing reviewer/time/evidence; P0/P1 or blocking P2 remains.
- **Rerun Rule:** after affected journey, route, state, copy, control, error/recovery, accessibility behavior, supported client/viewport, design baseline or `DB-D18`/`DB-D19` change; rerun affected H1–H10 scopes and any combined-impact regression set.
- **Automation Status:** `manual`; deterministic scanners may contribute evidence but cannot replace expert review.
- **Definition Status:** `prepared`.
- **Execution Status:** `not_run`.
- **QA Check IDs:** `pending_qa`; no IDs invented during DoD authoring.

### `G-22 representative_user_task_validation`

- **Gate:** `representative_user_task_validation`
- **Purpose:** require observed task completion by the representative V1 user group for critical, consequential, new or changed flows; do not infer usability from agent review, prototype playback or screenshots.
- **Source References:** PRD `AC-001`–`AC-016`; design brief `Usability Validation Plan` (`UV-01`–`UV-05`); user journey Stages 1–10 and Settings S1–S5; shared verification contract.
- **Applies To:** Product V1 release and every critical/consequential/new/changed owner task, including direct answer, real Consilium, permission/commands/costs, Google-only доступ and negative paths, settings save/reset/snapshot, mobile/desktop keyboard and assistive-technology use.
- **Required Evidence:** concrete QA IDs after QA authoring; representative group `Власник`; task, canonical JOB-001–JOB-005 and UC-001–UC-006 references; success criterion; device/client/viewport; implementation revision and deployed environment; observed session record; actual facilitator/participant timing; outcome, errors/recovery, findings, severity and release effect. `DB-D18`/`DB-D19` Google/local-session tasks require post-implementation evidence; frozen Google/Cloudflare prototype playback is historical only.
- **Pass Condition:** each applicable task has observed representative-owner completion against its source-backed success criterion on required device/viewport scope; critical failures are recovered as designed; no P0/P1 or blocking P2 remains; evidence is fresh for the evaluated revision.
- **Fail Or Block Condition:** task unobserved, simulated solely by an agent, performed only on a stale prototype, missing representative group/device/success criterion, facilitator assistance hides a primary-flow failure, applicable critical validation deferred, or blocking finding remains.
- **Rerun Rule:** after affected task flow, access/auth, state, copy, navigation, control, runtime result, supported device/viewport, baseline/override or fix; rerun the affected task and source-backed regression tasks.
- **Automation Status:** `manual`; instrumentation may support observation but cannot replace representative-user completion.
- **Definition Status:** `prepared`.
- **Execution Status:** `not_run`.
- **QA Check IDs:** `pending_qa`; no IDs invented during DoD authoring.

### `G-23 product_security_requirements`

- **Gate:** `product_security_requirements`
- **Purpose:** require implementation-level security evidence for every current PRD Security Requirement; no applicable obligation may be advisory, silently excluded or satisfied by a mockup/document review.
- **Source References:** PRD `Security Requirements` and OWASP ASVS 5.0.0 Level 2 target; guardrails product-security/evidence rules; architecture §14 `Product-security mapping`; shared security traceability and verification contracts.
- **Applies To:** every implementation, integration, deployment, rollback or release scope that affects actors, data, privileges, inputs, integrations, storage, consequential actions or any listed security requirement; required and active for Product V1 release.
- **Security Requirement IDs:** `NFR-005`, `NFR-006`, `NFR-007`, `NFR-008`, `NFR-009`, `NFR-010`, `NFR-011`, `NFR-012`, `NFR-016`, `NFR-017`, `NFR-019` — exactly 11.
- **Required Evidence:** implementation-level QA checks with `phase: implementation | both`, evidence `kind: security`, concrete IDs bound after QA authoring, and fresh results for the exact revision/environment. Their `security_requirement_ids` union must equal the 11 IDs above; each result links the relevant lower gate(s), architecture mechanism, positive/negative/failure/recovery evidence, executor/time and findings. Mockup-only, static-design, unrun, failed, blocked, deferred or silently excluded evidence cannot pass.
- **Pass Condition:** every one of the 11 IDs has complete source-clause coverage and fresh passing implementation/security evidence; all applicable supporting hard gates pass on the same lineage; dependency/config inventory is current; no P0/P1 or blocking P2 security/privacy/data-integrity finding remains; the `v5.0.0-6.3.3` MFA obligation is resolved by an explicit PRD/owner decision and the assurance claim matches that decision.
- **Fail Or Block Condition:** any ID/clause/check missing; QA union differs from the exact set; applicable check inactive/advisory/not-run/deferred; evidence is mockup/static/stale; control weakened to match implementation; secret/plaintext/unauthorized access; неперевірені компенсувальні вимоги визначеного PRD винятку; failed supporting security gate or blocking finding.
- **Rerun Rule:** after any change to actor/data/privilege/input/integration/storage/action boundary, security requirement/ASVS mapping, Rust sidecar/store/protocol, Node auth/runtime, MySQL schema/transaction/archive, OAuth/secret/dependency, route/egress/log/telemetry, deployment/rollback or security fix; rerun affected checks, `G-23` aggregate and dependent release/E2E gates.
- **Automation Status:** `not available yet`; current/future deterministic tests may contribute, but deployed configuration, real Matrix/provider boundaries, specialist review and компенсувальні вимоги чинного винятку потребують фактичних доказів.
- **Definition Status:** `prepared`.
- **Execution Status:** `not_run`.
- **QA Check IDs:** `pending_qa`; no IDs invented during DoD authoring.
- **PRD Exception:** PI-AUTH-20260905 уже визначає відсутність власного другого фактора й документований ризик v5.0.0-6.3.3. Повторного продуктового рішення не потрібно; release потребує всіх NFR-016.a–h і не може заявляти повну ASVS-відповідність.

#### Security coverage NFR-005

Gate consequence: `G-10`, `G-14`, `G-15` and `G-23` must prove Matrix E2EE with verified devices, TLS provider transport, vetted cryptography, separate key lifecycle and application-encrypted MySQL archive/restore without plaintext fallback.

#### Security coverage NFR-006

Gate consequence: `G-03`, `G-14`, `G-17` and `G-23` must prove secret-store/process isolation, bound OAuth flow, trusted pinned dependency inventory/remediation and technical absence of API/PAYG/provider-auth fallback or credential leakage.

#### Security coverage NFR-007

Gate consequence: `G-02`, `G-14` and `G-23` must prove server-side authorization of Matrix event, exact room/owner/device and record/action on ingress and immediately before outbound effects.

#### Security coverage NFR-008

Gate consequence: `G-03`, `G-14` and `G-23` must prove canonicalization/validation at trusted boundaries, parameterized SQL/process/network interfaces, bounded file/media handling, minimum context and instruction-as-data behavior.

#### Security coverage NFR-009

Gate consequence: `G-04`, `G-06`, `G-11`, `G-14` and `G-23` must prove idempotency, replay safety, rate/concurrency/body/file/time bounds, retry-storm resistance, resource cleanup and truthful cost effects.

#### Security coverage NFR-010

Gate consequence: `G-06`, `G-10`, `G-14` and `G-23` must prove one persisted canonical order and transactional confirm/outbox/archive transitions with crash/retry recovery.

#### Security coverage NFR-011

Gate consequence: `G-06`, `G-10` and `G-23` must prove collision-resistant closed-session integrity and rejection of tampered or mismatched archive/export evidence.

#### Security coverage NFR-012

Gate consequence: `G-09`, `G-11`, `G-17` and `G-23` must prove content-free correlated security events, synchronized time, protected logs/alerts, generic user errors, truthful auth/quota/cost/failure status and no secret/PII leakage.

#### Security coverage NFR-016

Наслідок gate: G-18 і G-23 вимагають окремого allowed/denied/recovery evidence для NFR-016.a, NFR-016.b, NFR-016.c, NFR-016.d, NFR-016.e, NFR-016.f, NFR-016.g, NFR-016.h та FR-038(a–d)/FR-039(a–c). Виняток без власної MFA вже визначено PRD; нездійснені компенсації блокують release, не авторство.

#### Security coverage NFR-017

Gate consequence: `G-19` and `G-23` must prove authorized full-schema Settings validation and one atomic MySQL version/CAS/idempotency transaction with no partial write, lost update or active-snapshot mutation.

#### Security coverage NFR-019

Gate consequence: `G-14`, `G-19` and `G-23` must prove fail-closed configuration/capability state, minimal exposed methods/services/headers, fixed host/forwarded-header/egress allowlists and stateless Preview without shared stateful writes.

### Requirement Traceability

Mandatory overlays are load-bearing: `G-16` applies to every affected user-visible implementation on `SUR-01`/`SUR-02`; `G-21` applies to every applicable user-visible journey/state/route/viewport; `G-22` applies to the critical/consequential/new-or-changed task scopes represented by `AC-001`–`AC-016` and `UV-01`–`UV-05`; `G-23` applies to exactly the 11 Security Requirements listed below. Historical `G-13` is not load-bearing for current implementation or release mappings.

#### Functional requirements

| Requirement | Primary gates |
|---|---|
| `FR-001` | `G-02`, `G-14` |
| `FR-002` | `G-03` |
| `FR-003` | `G-03`, `G-12` |
| `FR-004` | `G-03`, `G-14` |
| `FR-005` | `G-03`, `G-14` |
| `FR-006` | `G-03` |
| `FR-007` | `G-04`, `G-07` |
| `FR-008` | `G-05` |
| `FR-009` | `G-05`, `G-17` |
| `FR-010` | `G-05`, `G-17` |
| `FR-011` | `G-05`, `G-06` |
| `FR-012` | `G-05`, `G-06` |
| `FR-013` | `G-06` |
| `FR-014` | `G-06` |
| `FR-015` | `G-06`, `G-07`, `G-12` |
| `FR-016` | `G-06` |
| `FR-017` | `G-06`, `G-12`, `G-16`, `G-21` |
| `FR-018` | `G-06`, `G-12`, `G-16`, `G-21` |
| `FR-019` | `G-06`, `G-12`, `G-16`, `G-21` |
| `FR-020` | `G-04`, `G-08` |
| `FR-021` | `G-08` |
| `FR-022` | `G-04`, `G-08` |
| `FR-023` | `G-05`, `G-07`, `G-09` |
| `FR-024` | `G-03`, `G-07` |
| `FR-025` | `G-09` |
| `FR-026` | `G-09`, `G-16`, `G-21`, `G-22` |
| `FR-027` | `G-09` |
| `FR-028` | `G-09` |
| `FR-029` | `G-09` |
| `FR-030` | `G-09`, `G-17` |
| `FR-031` | `G-10`, `G-14` |
| `FR-032` | `G-10` |
| `FR-033` | `G-11`, `G-17` |
| `FR-034` | `G-12` |
| `FR-035` | `G-03`, `G-09` |
| `FR-036` | `G-09`, `G-16`, `G-21` |
| `FR-037` | `G-16`, `G-18`, `G-20`, `G-21`, `G-22` |
| `FR-038` | `G-18` |
| `FR-039` | `G-17`, `G-18` |
| `FR-040` | `G-16`, `G-19`, `G-20`, `G-21`, `G-22` |
| `FR-041` | `G-19`, `G-20` |
| `FR-042` | `G-19`, `G-20` |
| `FR-043` | `G-17`, `G-19`, `G-20` |
| `FR-044` | `G-19`, `G-20` |
| `FR-045` | `G-19`, `G-20` |
| `FR-046` | `G-17`, `G-19` |

#### Nonfunctional requirements

| Requirement | Primary gates |
|---|---|
| `NFR-001` | `G-07` |
| `NFR-002` | `G-07` |
| `NFR-003` | `G-07` |
| `NFR-004` | `G-07` |
| `NFR-005` | `G-10`, `G-14`, `G-23` |
| `NFR-006` | `G-03`, `G-14`, `G-17`, `G-23` |
| `NFR-007` | `G-02`, `G-14`, `G-23` |
| `NFR-008` | `G-03`, `G-14`, `G-23` |
| `NFR-009` | `G-04`, `G-06`, `G-11`, `G-23` |
| `NFR-010` | `G-06`, `G-10`, `G-23` |
| `NFR-011` | `G-06`, `G-10`, `G-23` |
| `NFR-012` | `G-09`, `G-11`, `G-17`, `G-23` |
| `NFR-013` | `G-12`, `G-16`, `G-21` |
| `NFR-014` | `G-09`, `G-16`, `G-21` |
| `NFR-015` | `G-12`, `G-16`, `G-21` |
| `NFR-016` | `G-18`, `G-23` |
| `NFR-017` | `G-19`, `G-23` |
| `NFR-018` | `G-16`, `G-20`, `G-21`, `G-22` |
| `NFR-019` | `G-14`, `G-19`, `G-23` |

#### Незалежні пункти та UC

| Пункт / сценарій | Активні gate |
|---|---|
| NFR-016.a, NFR-016.b, NFR-016.c, NFR-016.d, NFR-016.e, NFR-016.f, NFR-016.g, NFR-016.h | G-18, G-23; кожний пункт має окремий результат |
| UC-001 | G-02–G-07, G-09, G-14, G-15, G-17; усі пов'язані FR/NFR залишаються обов'язковими |
| UC-002 | G-04, G-06–G-08, G-10 |
| UC-003 | G-18, G-20, G-23 |
| UC-004 | G-19, G-20, G-23 |
| UC-005 | G-10, G-14, G-23 |
| UC-006 | G-11, G-17 |

Застосовні G-16/G-21/G-22 перевіряються окремо для користувацьких наслідків. Кожний майбутній QA check має один primary gate; додаткові supporting gate references не створюють дубльованого членства. QA визначає конкретні checks після цього owner; наявність старих QA IDs не є передумовою DoD.

#### Acceptance scenarios

| Requirement | Primary gates |
|---|---|
| `AC-001` | `G-04`, `G-05`, `G-07`, `G-09`, `G-15` |
| `AC-002` | `G-05`, `G-06`, `G-07`, `G-09`, `G-15`, `G-17` |
| `AC-003` | `G-06`, `G-10`, `G-12`, `G-15`, `G-16`, `G-21`, `G-22` |
| `AC-004` | `G-04`, `G-08`, `G-15` |
| `AC-005` | `G-03`, `G-14`, `G-15` |
| `AC-006` | `G-02`, `G-14`, `G-15` |
| `AC-007` | `G-05`, `G-07`, `G-09`, `G-15`, `G-17` |
| `AC-008` | `G-10`, `G-15` |
| `AC-009` | `G-11`, `G-15`, `G-17` |
| `AC-010` | `G-12`, `G-15`, `G-16`, `G-21`, `G-22` |
| `AC-011` | `G-03`, `G-09`, `G-15`, `G-16`, `G-21`, `G-22` |
| `AC-012` | `G-15`, `G-16`, `G-18`, `G-21`, `G-22` |
| `AC-013` | `G-15`, `G-19`, `G-20` |
| `AC-014` | `G-15`, `G-17`, `G-19` |
| `AC-015` | `G-15`, `G-19` |
| `AC-016` | `G-15`, `G-16`, `G-20`, `G-21`, `G-22` |

## Lane Or State Promotion Gates

Not applicable: sources define product Session/runtime states, not engineering delivery lanes or repository state-promotion workflow. `SS-01`–`SS-46`, Settings revision/snapshot states and runtime/credential lease states therefore do not create CI/merge lanes. If a future development plan defines engineering lanes, it must bind transitions to the applicable gates in this document without treating ordinary product UI states as engineering gates.

## Eval Result Format

Every persisted eval result records:

| Field | Contract |
|---|---|
| `eval_id` | Stable unique result identifier |
| `gate` | One named gate from `G-01`–`G-23` |
| `scope` | Product, feature unit, change, environment and affected requirement IDs |
| `level` | `unit`, `integration`, `e2e`, `device`, `manual_review` or `static_source` |
| `definition_status` | `prepared` or `blocked`: whether the gate/check can be executed as specified |
| `execution_status` | `not_run`, `passed`, `failed`, `blocked`, `deferred` or `not_applicable` |
| `release_readiness` | `not_evaluated` during authoring; only an explicit release evaluation may record `passed` or `blocked` |
| `source_references` | Exact source artifact/version/hash and relevant requirement IDs |
| `environment_fingerprint` | Code revision plus deployed config/runtime/model/A2A/key/export/client identifiers relevant to the claim; no secrets |
| `owner` | Person or agent responsible for executing and reading the evidence |
| `started_at` / `finished_at` | Timestamp with timezone; timing evals additionally retain monotonic durations |
| `expected` / `actual` | Source-backed condition and observed result |
| `evidence_references` | Persistable logs, reports, screenshots/recordings, hashes, provider receipts or archive manifests |
| `evidence_limit` | What this run does not prove |
| `findings` | Zero or more findings with severity/release effect schema below |
| `rerun_of` | Prior result identifier when the run verifies a fix or recovery |

Definition semantics:

- `prepared`: the gate has source, applicability, evidence, pass/block, rerun and automation contracts; it does not mean execution or pass.
- `blocked`: a missing material definition/source prevents valid execution.

Execution semantics:

- `not_run`: prepared definition exists, but no execution result is claimed.
- `passed`: every applicable pass condition is met with fresh readable evidence and no blocking finding.
- `failed`: the eval executed and at least one pass condition was violated.
- `blocked`: required source, environment, permission, integration, device, evidence or unresolved high-risk policy prevents a valid execution or conclusion.
- `deferred`: applicable execution is postponed; it is not a pass and blocks when the gate is required for the claim.
- `not_applicable`: the source-backed applicability condition is false for this scope; reason is mandatory. `G-16` is active for every affected user-visible unit; it may not be reported `passed` without baseline-bound evidence.

Aggregate completion status is `passed` only when all applicable required child results are `passed`. A `not_run`, required `deferred`, `failed` or `blocked` hard gate blocks Done. Advisory findings remain visible and do not change an otherwise valid `passed` result unless their recorded Release Effect is `blocking`. Цей authoring pass лишає всі execution statuses `not_run`, а release readiness — `not_evaluated`.

## Evidence Requirements

### Evidence levels

| Level | Proves | Does not prove alone |
|---|---|---|
| Unit | Local deterministic rule or invariant | Module wiring, provider behavior, real process identity, user-visible result |
| Integration | Contract across named real modules or configured external boundary | Full user journey across every provider/device |
| E2E | Whole deployed workflow and acceptance result | Universal behavior outside tested environment/client/config |
| Device/client | Actual native rendering and accessibility path | Server correctness, A2A identity, archive encryption |
| Manual review | Semantics, truthfulness, design/content/accessibility judgment | Runtime state not present in the evidence |
| Static source/prototype | Intended scope, layout/content contract or code/config property | Runtime function, delivery, encryption at rest, latency, process separation or completion |

### Completion evidence bundle

For each completion claim retain:

- requirement and gate coverage;
- source/code/config lineage and hashes;
- per-level eval results with timestamps and owners;
- raw or immutable references sufficient to inspect actual output;
- failure-injection and recovery results where applicable;
- finding register with severity and release effect;
- known limitations and unavailable evidence;
- final aggregate status and the exact claims it supports.

Evidence must be fresh after the last relevant change. A cached result may support history but cannot pass the current gate. Sensitive evidence must be minimized and must not contain Secrets, Matrix access/recovery keys, OAuth tokens, `auth.json`, setup-token, reauth URL/code, raw document content or wrapping keys.

For Settings claims, the bundle additionally links content-free GoDaddy Node Google/transaction/session/request-control configuration and result receipts, catalog/provider-runtime provenance, MySQL Settings version/snapshot hashes and deployed accessibility evidence. It never retains Google token/identity, session-signing secret/cookie, CSRF token, Settings body or AI credential; an opaque actor/result correlation is sufficient.

## Evidence Limits

- Static documentation defines intended checks but proves no runtime behavior.
- Mockups and proposed prototypes prove presentation intent only; they do not prove Element/Matrix delivery, native-client equivalence, agent identity, A2A, timing, cancellation, encryption, archive, deletion or cost.
- `consilium/live/*` and its tests prove only local preview mechanics. They are not a product surface, production archive or evidence of deployed V1.
- A successful Element/Matrix API response proves provider acceptance only, not user-visible delivery/read or client formatting.
- A visible role label proves no separate real agent context: Codex requires distinct current thread/workspace/lease evidence, while Claude requires a distinct current process/workspace/lease.
- Distinct Codex role/thread labels do not prove credential isolation; evidence must show those distinct contexts under one fenced OAuth lineage and no cloned auth store.
- `account/read`, `claude auth status` or a plan screenshot proves only the observed auth/plan state, not a universal legal right, future eligibility, quota sufficiency for later calls or absence of fallback elsewhere in configuration.
- Видима Google-кнопка, збережена Console-конфігурація, redirect/cookie/header або один успішний login не доводять усі NFR-016.a–h, окрему локальну сесію, request protection, ізоляцію AI OAuth та відсутність обхідних шляхів.
- A static Settings page, client-side validation or one successful save does not prove server-side exact-three schema, live provider capability truth, no silent downgrade, atomic rollback/CAS/idempotency, audit redaction or immutable session snapshot.
- An accessibility scanner or viewport screenshot alone does not prove keyboard/assistive-technology operation, status announcements, focus recovery, long-content reflow or that the displayed result matches committed runtime state.
- Passing unit/integration tests does not replace `G-15`.
- Ciphertext-looking output or static config does not by itself prove correct key isolation, read-back integrity, recovery or deletion.
- A screenshot cannot prove full body/order/immutability without linked canonical transcript/hash evidence.
- AI-agent agreement is not independent evidence.
- WCAG, security, privacy or compliance guarantees cannot be claimed from this document or static review alone.

## Failure And Blocker Classification

Every finding records:

- **Severity:** `P0`, `P1`, `P2` or `P3`.
- **Release Effect:** `blocking` or `advisory`.
- **Applicability:** affected gate, requirement, environment, client and scope.
- **Source:** source requirement or invariant.
- **Evidence:** observed result and immutable reference.
- **Rationale:** why severity and release effect apply.

| Severity | Meaning | Default release treatment |
|---|---|---|
| `P0` | Catastrophic severe harm, material secret/plaintext exposure, unauthorized protected access/effect, destructive loss or system-wide unusability | `blocking` |
| `P1` | Broken primary journey, real-consilium invariant, core capability, release invariant or high-impact requirement with no acceptable workaround | `blocking` |
| `P2` | Localized but meaningful defect, regression, requirement gap or visual/interaction drift while product remains broadly usable or has a reasonable workaround | Explicitly `blocking` or `advisory` with rationale |
| `P3` | Low-impact polish or cosmetic inconsistency without material effect | Usually `advisory` |

Severity does not silently determine release effect. Nevertheless, unresolved P0 and P1 always block this V1 contract. A P2 blocks when it affects authorization, data/permission boundary, canonical body/order, timing threshold, cancellation, archive integrity, cost truth, Settings access/atomicity/capability/snapshot, an inoperable required accessibility path, a required acceptance path or an expressly blocking design deviation.

Blocker classes:

- `source_blocked` — missing/conflicting/stale authoritative source;
- `implementation_blocked` — required mechanism or interface absent;
- `environment_blocked` — provider, GoDaddy deploy, Rust artifact/store, MySQL schema/state, key, runtime, eligible subscription/quota, owner-auth/session/capability evidence or device unavailable;
- `permission_blocked` — required explicit owner authorization is absent;
- `evidence_blocked` — required evidence cannot be produced or read;
- `policy_blocked` — unresolved high-risk policy prevents a valid pass condition.

## Rerun And Recovery Rules

1. A failed or blocked hard gate is never waived by prose; fix/restore the cause or reduce the claim/scope truthfully.
2. After a fix, rerun the failed gate, its direct dependencies and every acceptance scenario affected by the changed shared contract.
3. Changes to Rust sidecar/protocol/store/room policy, Node registrar state/order/generation, MySQL ingress/outbox/archive, owner auth/data policy, Codex lineage/checkpoint/writer fencing, Claude setup-token runtime, forbidden environment/egress rules, runtime adapter, archive/crypto or shared formatter require broader regression because they affect multiple gates.
4. Timing reruns use fresh monotonic measurements and representative load; prior latency does not pass changed deployment/config.
5. Recovery evidence must show both the injected failure and the restored invariant: dedupe under retry, lease replacement, late-output rejection, outbox replay, archive mismatch halt or key-provider pause.
6. A rerun result references the prior result via `rerun_of`; the old result remains immutable.
7. If only advisory P2/P3 remains, aggregate may pass only when the finding, rationale, owner and follow-up are persisted.
8. Post-approval baseline or approved override changes rerun `G-16`, `G-21` and applicable `G-22` tasks for all affected states/viewports/clients.
9. Auth expiry/revocation/quota or crash-recovery reruns must show the fail-closed event, absence of any dependent call/fallback, safe out-of-band recovery where applicable, a fresh `SS-28`, and affected `G-05`, `G-11`, `G-14`, `G-15`, `G-17` results.
10. Google/transaction/session/request-security changes rerun `G-18` across the complete positive/negative auth and browser-security matrix, plus affected `G-15`, `G-20`–`G-23`; a single happy-path login cannot substitute.
11. Settings schema/catalog/provider/speed/persistence/snapshot changes rerun `G-19` including failure injection, live capability reconciliation and concurrent save/start, plus affected `G-15`, `G-17`, `G-20`–`G-23`.
12. `SUR-02` presentation or interaction changes rerun affected deployed states/viewports/accessibility paths in `G-20`, active `G-16`, `G-21` and applicable `G-22`; runtime result correlation remains required.
13. Security-relevant changes rerun every affected implementation-level check, supporting hard gates and `G-23`; the QA `security_requirement_ids` union is rechecked against the exact 11-ID set before any release evaluation.

## PR Merge And Completion Rules

Перевірені `package.json`, Rust workspace/lockfile та `.github/workflows/matrix-sidecar.yml` визначають наявні локальні й CI засоби. Їх існування не є результатом запуску або доказом branch protection/deployment. Цей SDD pass не виконував product gates.

- A change may be called `merge-ready` only when its requirement trace is complete, all applicable unit/integration/manual design gates pass on the current revision and no blocking finding remains.
- A merge or local commit is not a release claim. Product V1 is `release-ready` only after all applicable hard gates, including `G-15`, active `G-16`, `G-17`–`G-20` and mandatory `G-21`–`G-23`, pass.
- Absence of automation is not a waiver: required evidence may be manual/hybrid but must retain the same result schema.
- Human approval is not a default completion gate. The one whole-design approval has been recorded in the active baseline; product-specific explicit permissions remain runtime safety boundaries, not PR approvals.
- Any change that conflicts with current source truth returns to the upstream owner; it is not merged as an implicit requirement change.

## Out Of Scope

- New product requirements, channels, users, roles, surfaces, message/settings groups, commands, attachment types or parallel Sessions.
- Architecture choices beyond the configurable seams already defined in `docs/architecture.md`.
- Per-screen/per-scenario QA procedures, test data sets, exact commands, screenshots or future QA check IDs.
- Implementation units, coding tasks, milestones, issue hierarchy or delivery schedule.
- CI/provider/tool commands not present in the repository.
- Replacing or extending the active visual baseline without a new explicit whole-design approval.
- Claiming security, privacy, accessibility, delivery or regulatory guarantees without corresponding runtime and specialist evidence.

## Open Questions

1. **Sensitive-document policy.** Which versioned classes define an Особливо чутливий документ? Until resolved, uncertain documents must request separate permission; production `G-03` is blocked if the implemented classifier has no versioned policy basis.
2. **Stopped/replaced Session lifecycle.** What archive treatment applies after `Стоп` and to the prior Session after `Нова задача`? `G-08` can verify cancellation/isolation, but `G-10` cannot pass those archive paths until the policy is fixed.
3. **Archive/export/deletion contract.** Which bundle/export encoding and content-free deletion receipt/tombstone policy preserve exact body/order while stating provider retention honestly? `G-10` requires the selected contract in its environment fingerprint before release.
4. **Runtime configuration.** Exact pinned Rust workspace/lockfile and sidecar artifact, Codex app-server/SDK and Claude Code versions, A2A v0.3.0 serialization profile, private spool/store paths, MySQL outbox/lease schema, runtime adapter start/heartbeat/cancel semantics, wrapping-key provider, crypto version and retry scheduler remain implementation-bound; related gates cannot pass until the deployed choices are named and evidenced.
5. **Subscription, infrastructure and provider-status feeds.** Which configured subscription-fee records, actual infrastructure billing/usage feeds and provider-supported usage/limit/reset signals are authoritative? `G-11` requires reconciliation where data exists and `невідомо` where it does not; missing provider status never becomes an invented monetary AI total, reset or per-session token charge.
6. **Client variance.** Current Element/Matrix formatting and accessibility behavior on Mac, iPhone, Samsung Flip7/Android and Windows requires real-device evidence and honest reporting of material differences.
7. **Matrix.org.** `matrix.org` is the selected V1 public homeserver on its current free plan. Production `G-02`, `G-14` and `G-15` remain blocked until the free-plan status, bot policy, reliability, private E2EE room invariants and verified device lifecycle have live evidence. `m.federate: false` is not a V1 gate because the owner does not control that server-level setting on the public homeserver.
8. **Визначений виняток MFA.** Це більше не відкрите питання: PI-AUTH-20260905 і NFR-016.h задають Google-only вхід без власної MFA та парольного fallback. Перед release перевіряються NFR-016.a–g, ізоляція, безпечна конфігурація й умови перегляду ризику, не повторна згода на те саме рішення.
