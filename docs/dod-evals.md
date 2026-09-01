# DoD And Evals

- Продукт: `Personal Consultant`
- Версія контракту: V1, implementation phase after approved visual baseline
- Дата: 16.08.2026
- owner_invocation_id: `e05a1a53-1bfe-4a6b-a6db-a3ba80de9266`

## Source References

Порядок істини успадковано з `docs/guardrails.md`. `docs/product-idea.md` використано, тому що `docs/prd.md` прямо називає його основним джерелом продуктового наміру. Поточна pipeline-фаза має approved visual baseline `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`; усі user-visible implementation units перевіряються проти його immutable target та approval receipt.

| Джерело | SHA-256 / evidence | Спожиті фрагменти |
|---|---|---|
| `README.md` | `d1afdf92181df9e002f9f75678f8ca46083c90bec0a9a33e47535a0593fa1c9c` | Позиціонування; практичний результат; локальний browser-preview лише як обмежений evidence |
| `docs/product-idea.md` | `263a5d15949e2ebf70f9fb4fa8ba67ff1e882cb5ae2774ecf218ccff16586ac5` | Element/Matrix V1; реальний Консиліум; Owner Settings; private single-owner subscription OAuth; дані, час, архів, команди й витрати |
| `docs/prd.md` | `2d9546dd7b0f4cd25dea0f225ffa35c0819966e3edb9efaa72f781f3fb70d660` | `US-001`–`US-029`; `FR-001`–`FR-046`; `NFR-001`–`NFR-019`; `AC-001`–`AC-016`; Settings, OAuth-only і fail-closed contracts |
| `docs/project-context.md` | `529ee8b70ec81b2a4734cb7580e5bfc84052a9f2552b039cd52bd42dfe4b2fee` | Outcomes; two surfaces; Google Access/JWT; atomic Settings; private/non-SaaS boundary; constraints; risks |
| `docs/canonical-terms.md` | `75e8ab94a47faa0f89a51605543f2f643ce9b53c8513d26ee7d5bb54037f26fc` | Ролі; об'єкти; команди; Settings groups/states; OAuth; A2A; Реєстратор; Канонічний порядок; Облік витрат |
| `docs/guardrails.md` | `54c7ccd20d612e908f1038499c2db101d47e587c141a2d5363e003b2a0dbb3bc` | Source order; Google Access/JWT; exact-three/atomic/snapshot rules; private-use and OAuth boundaries; stop rules; evidence; design authority |
| `docs/user-journey.md` | `e4dfa9801ef0eab241c4b768719732628e37aebb068a8fd8067eeedbe1a6d7cd` | Element Stages 1–10; Settings S1–S5; decisions; auth/access recovery; failures; costs; success |
| `docs/screen-map.md` | `5f138005cf9b6c9b347cc8d876bd74f6f9c977503ad6dc53436ccd35e75f0a5b` | `SUR-01`–`SUR-02`; `MG-01`–`MG-13`; `SG-01`–`SG-05`; `SS-01`–`SS-46`; transitions; edge paths |
| `docs/wireframes.md` | `df7ca5c68e238416d16541e765b6a062bd29ab1328de06dc0f064f0600fb2edc` | Native Element patterns; authenticated responsive Settings structure; all state/group coverage; accessibility |
| `docs/design-brief.md` | `fe448a96e48f78751c6e7f301515c5abf3856c3b69266d9dac4ec0321c017824` | Approved `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`; both surfaces; `P-01`–`P-15`; HappyPro palette for `SUR-02` |
| `docs/architecture.md` | `f115117a92b1a158003aab579cb26abb804fa7cd340d55c1a9060b52b7c6d183` | Matrix/E2EE and OAuth runtime; Cloudflare Settings access/browser hardening; `OwnerSettingsDO`; capability catalogs; atomic save/reset; immutable session snapshot |
| Поточний репозиторій | Read-only inspection, 16.08.2026 | `scripts/consilium-*.mjs`, `consilium/live/*` і `tests/consilium-chat.test.mjs` доводять лише локальне збереження body, форматування й preview; package manifest, CI, Cloudflare config і production runtime відсутні |
| Явне рішення Власника | 16.08.2026 | Candidate B v2 цілісно затверджено фразою «ОК. Закрий хром і продовжуй розробку»; тільки цей baseline є visual source для наступних user-visible units |

Канонічне покриття цього контракту: `US=29`, `FR=46`, `NFR=19`, `AC=16`, `SUR=2`, `MG=13`, `SG=5`, `SS=46`. Відсутній або додатковий ID є `G-01` blocker, доки upstream source не змінено явно.

## Definition Of Done Model

Done — це підтверджений стан, а не самооцінка агента, наявність документа, зелений локальний тест або прийняття повідомлення зовнішнім API. Стан визначається для конкретного scope та environment свіжими результатами всіх застосовних гейтів.

Рівні Done:

1. **Product V1 Done:** усі `AC-001`–`AC-016` пройдено в одному evidence lineage: реальна приватна E2EE Matrix-кімната з перевіреними пристроями; реальна protected responsive `SUR-02` через Cloudflare Access/Worker; один fenced authoritative Codex subscription-OAuth lineage; окремі реальні Codex threads/workspaces; окремий Claude Code subscription-OAuth process; фактичні provider/runtime integrations; усі застосовні hard gates пройдено.
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
- статика, mockup, prototype, згенерований HTML чи локальний browser-preview не використані як доказ Element/Matrix, Cloudflare, A2A, реальних процесів, архіву, вартості або доставки;
- твердження про успіх не перевищує evidence: provider acceptance не називається delivery, кілька labels не називаються реальним Консиліумом, а оцінка вартості не називається фактичною сумою;
- user-visible content відповідає approved visual baseline `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`;
- кожний user-visible implementation scope проходить активний `approved_visual_baseline_fidelity`;
- evidence bundle містить owner, час, environment/config fingerprint, source revision, фактичний результат і незмінні посилання або hashes.
- один-owner/non-SaaS eligibility, auth mode, quota, credential-writer fence і відсутність API/PAYG/cloud-provider fallback перевірені до кожного залежного model call; unknown або failure веде до `SS-29`, а не до часткового прихованого запуску.
- `SUR-02` допускає лише exact-owner Google Access principal після незалежної Worker-перевірки JWT і request-security controls; Settings зберігаються all-or-nothing, а нова Сесія отримує повний immutable effective snapshot лише після свіжої capability/auth/quota validation.

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
- Access JWT cases for algorithm, signature/JWKS rotation, issuer, audience, `exp`/`nbf`/clock skew and exact normalized email; request-policy cases for method/content type/body size, same-origin, Fetch Metadata and CSRF binding;
- exact Settings schema/key validation; separate typed Codex/Claude allowlists; capability freshness/mapping and no-downgrade cases for every `low`/`medium`/`high`/`xhigh` value;
- whole-object Settings validation, revision/CAS and idempotency-ledger cases for success, conflict, exact retry, reused-key/different-body, reset, offline and failed write;
- deterministic speed-policy mapping for all three presets plus invariant checks that forbid Fast/priority/PAYG/extra usage and preserve critic/A2A/E2EE/verbatim/research/safety/privacy/permission rules;
- immutable session-snapshot creation and rejection of later mutation, including concurrent save/start ordering and capability drift;
- cost aggregation that separates configured subscription fees, actual infrastructure spend and provider usage/limit/reset, while excluding estimates from actual totals;
- archive manifest/hash verification, confirmed-delete state transition and failure classification;
- content-contract validators that can inspect role/`HH:MM`, forbidden metadata and final-series structure.

Поточний репозиторій не містить implementation package або test harness для цих production units. Automation status залишається `not available yet`, доки код не надасть фактичні команди.

### Integration Checks

Integration evidence використовує реальні contract boundaries, а не лише mocks:

- verified bot-device у `MatrixBridgeContainer` → room-invariant gate → named `RegistrarDO` з exact room/mxid і idempotency;
- `RegistrarDO` → durable `MatrixOutboxIntent` → `MatrixBridgeContainer` → Matrix event receipt;
- `RegistrarDO` → `AgentRuntimeAdapter` → окремий process lease/heartbeat/cancel/usage → registrar callback;
- `RegistrarDO` → one fenced `CodexCredentialLease` → sealed checkpoint restore/managed refresh/CAS checkpoint → teardown or revocation, including concurrent-writer denial and crash recovery;
- one `CodexAccountRuntime` → distinct head/specialist thread IDs and isolated workspaces without cloned `auth.json`/OAuth caches; separate `ClaudeCriticProcess` → subscription setup-token/auth-status path;
- scrubbed runtime environment and outbound handlers → OpenAI/Anthropic subscription endpoints only; negative proof that API/PAYG, automatic credits, Bedrock, Vertex, Foundry, custom endpoint and higher-precedence provider credentials cannot activate;
- real Cloudflare Access application → Google-only exact-email policy → protected hostname/assets/API → independent Worker JWT validator, including wrong account, alternate/bypass/service-auth/default-IdP/OTP paths and malformed/forged/stale assertion cases;
- deployed Settings Worker → same-origin/CSRF/CSP/no-store/header enforcement → `OwnerSettingsDO` full-object API; cross-origin, cache, content-type, body-size, method and clickjacking/XSS policy negatives;
- `SettingsAPI` → fixed `OwnerSettingsDO` revision/CAS/idempotency/audit → `ModelCapabilityCatalogService` provider capability reconciliation → truthful current/default/effective response;
- `OwnerSettingsDO` → `SessionSettingsResolver` → `RegistrarDO` session-start snapshot, including compatible, drift, concurrent-save, auth/quota failure and next-session-only cases;
- A2A draft → atomic registration/order/hash → target route і visible outbox;
- `RegistrarDO` → `ArchiveCryptoPort`/key provider → ciphertext R2 object → read-back/hash verification;
- archive export і confirmed whole-session deletion з provider-retention disclosure;
- failure injection для duplicate event, runtime loss, late callback, outbox retry, R2 mismatch, key-provider unavailability й incomplete usage.

Contract-test doubles можуть допомагати відтворюваності, але release evidence має включати фактичні configured integrations для claims, які залежать від них.

### System Checks

System/end-to-end evidence запускає `AC-001`–`AC-016` через реальну приватну E2EE Matrix-кімнату та реальну protected `SUR-02`: точні room/mxid, перевірені Element/bot devices, Cloudflare Access Google-only application, незалежний Worker JWT/request-security gate, fixed `OwnerSettingsDO`, deployed Cloudflare server side, one named registrar, one fenced Codex OAuth lineage/writer, distinct real Codex threads/workspaces, real separate Claude Code subscription-OAuth critic, configured A2A v0.3.0 adapter, encrypted archive path and actual cost records.

Окремо фіксуються:

- received, provider-accepted, delivered/read/failed statuses, не змішуючи їх;
- timestamps для 5/30/60 секунд і 10 хвилин;
- process lease identities та generation;
- Codex credential lineage/checkpoint/writer-fence metadata, distinct thread/workspace identities, Claude process/auth-mode status and credential-free environment inspection without secret values;
- positive `SS-28` preflight and injected unknown/expired/revoked/refresh-failed/invalid-setup-token/quota-exhausted/ineligible/forbidden-credential cases that reach `SS-29` before a dependent call and resume only after provider-managed out-of-band recovery plus fresh preflight;
- positive exact-owner Google access plus wrong email, missing/malformed/unsigned/invalid/expired/not-yet-valid JWT, wrong algorithm/issuer/audience/email, unknown `kid`, expired JWKS cache, alternate IdP, password/OTP/magic-link/registration/bypass/service-auth and header/cookie-presence-only negatives, all without protected bytes;
- `SUR-02` current/default/effective load, exact-three schema, typed selector/capability evidence from both current subscription runtimes, supported/unsupported/unknown/stale effort mappings, all speed presets, atomic save/reset/CAS/idempotent retry/conflict/offline paths and immutable current-vs-active snapshot comparison;
- content-free inspection of Access/Worker configuration, response headers/cache behavior, request rejection, Settings audit and secret scans; no raw email, JWT, cookie, CSRF, settings body or AI credential appears in evidence;
- canonical body/order comparison між registrar, Element/Matrix-visible stream, export і archive;
- actual client/app/OS versions у device evidence matrix;
- injected failure, partial status, recovery result and rerun.

### UX/UI Checks

- Для historical proposed artifacts перевіряється `G-13 proposed_design_contract_fidelity`. Нові user-visible implementation units перевіряються активним `G-16 approved_visual_baseline_fidelity` проти `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`: рівно дві поверхні `SUR-01`–`SUR-02`, `MG-01`–`MG-13` (13), `SG-01`–`SG-05` (5), `SS-01`–`SS-46` (46), `P-01`–`P-15`, native Element/Matrix chat, one-page Settings hierarchy, HappyPro palette для `SUR-02`, plain-text meaning та accessibility floor.
- Representative evidence охоплює 390, 430, 768, 1280 і 1440 px як design stress viewports, але browser rendering не підміняє current-client evidence.
- Реальні Element/Matrix clients перевіряються на Mac, iPhone, Samsung Flip7/Android і Windows PC щодо order, formatting, long body, role/`HH:MM`, text scaling/screen-reader path і disclosed variance.
- Реальна deployed `SUR-02` перевіряється на representative mobile/desktop widths щодо keyboard-only navigation, programmatic labels/relationships, visible focus, 24×24 minimum targets і 44×44 primary touch target where applicable, error/status announcements, zoom/reflow, long model/mapping text, no horizontal loss of critical action and no color-only meaning.
- `G-16 approved_visual_baseline_fidelity` застосовується з Baseline ID, immutable target hash, coverage, concrete QA check IDs and `VisualQAEvidence`.

### Release Checks

Release-ready вимагає:

- усі hard gates, застосовні до V1, `passed` зі свіжим evidence;
- `G-15` пройдений у production-like або production environment, що використовує реальних providers/processes; середовище названо точно;
- configured model/runtime/A2A/key/retry/export choices зафіксовано у evidence fingerprint;
- `G-17` підтверджує актуальну private single-owner plan eligibility, subscription OAuth-only mode, один authoritative Codex writer/checkpoint lineage, окремі реальні agent contexts, Claude setup-token process, quota/fail-closed behavior і відсутність paid fallback;
- `G-18` підтверджує deployed Google-only exact-email Access policy, незалежну криптографічну JWT/request-security перевірку й відсутність protected cache/bypass/credential leakage;
- `G-19` підтверджує live provider-backed capability catalog, exact-three contract, all-or-nothing persistence/reset/retry і immutable next-session snapshot без Fast/PAYG або weakened invariant;
- `G-20` підтверджує, що deployed `SUR-02` реально usable й accessible на required responsive paths, а не лише відповідає статичному design source;
- deployment and rollback evidence доводить dark auth health check, safe checkpoint restore, credential-writer fencing, out-of-band reauth/revocation and `SS-29` retention when safe restore is unproven;
- жодного plaintext archive object, secret/body у telemetry або generic external-action connector;
- немає P0, P1 чи blocking P2;
- відомі client/provider limitations описані як limitations, а не приховані;
- CI/deployment scripts не заявляються наявними до появи в коді.

## Gate Matrix

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
| `G-14 matrix_e2ee_room_and_platform_isolation` | Static config, integration, deployed evidence | `FR-001`, `FR-004`, `FR-005`, `FR-031`; `NFR-005`–`NFR-008`; `AC-005`, `AC-006` |
| `G-15 v1_real_matrix_e2e` | Real end-to-end across both product surfaces | `AC-001`–`AC-016` and all supporting `FR`/`NFR` |
| `G-16 approved_visual_baseline_fidelity` | Post-approval visual/device evidence | Post-approval integrated `SUR-01` + `SUR-02` user-visible frontend/full-stack/integration scope |
| `G-17 subscription_oauth_private_runtime` | Unit, integration, security, deployed E2E | `FR-009`, `FR-010`, `FR-030`, `FR-033`; `NFR-006`, `NFR-012`; `AC-002`, `AC-007`, `AC-009` |
| `G-18 owner_settings_access_security` | Unit, Cloudflare config, security integration, deployed E2E | `FR-037`–`FR-039`; `NFR-006`, `NFR-016`; `AC-012` |
| `G-19 owner_settings_atomic_configuration` | Unit, integration, provider/runtime, deployed E2E | `FR-040`–`FR-046`; `NFR-017`, `NFR-019`; `AC-013`–`AC-015` |
| `G-20 owner_settings_runtime_ux` | Deployed browser/device, accessibility, manual/hybrid | `FR-037`, `FR-040`–`FR-045`; `NFR-018`; `AC-016` |

### `G-01 source_contract_integrity`

- **Gate:** `source_contract_integrity`
- **Purpose:** не дозволити stale або суперечливому source chain визначати Done.
- **Source References:** усі записи `Source References`; `docs/guardrails.md: Source Of Truth Order`.
- **Applies To:** кожний change, feature unit, PR/completion і release claim.
- **Required Evidence:** hashes актуальних source artifacts; diff/source review; exact coverage scan for `US=29`, `FR=46`, `NFR=19`, `AC=16`, `SUR=2`, `MG=13`, `SG=5`, `SS=46`; requirement-to-gate trace; explicit record of any superseded source.
- **Pass Condition:** hashes відповідають фактично прочитаним files; усі вісім coverage counts/ID ranges точні й без прогалин; dependencies validated; конфліктів scope/term/authority немає або вони явно вирішені upstream.
- **Fail Or Block Condition:** source missing/stale, hash mismatch, silent conflict, untraced requirement або downstream rule змінює upstream scope.
- **Rerun Rule:** після кожної зміни будь-якого source artifact, approval receipt або architecture/config contract.
- **Automation Status:** `manual`; hash/coverage scan може бути automated після появи project tooling.

### `G-02 ingress_authorization`

- **Gate:** `ingress_authorization`
- **Purpose:** допустити protected processing лише для exact private room, exact owner mxid і verified/non-revoked devices після успішного E2EE decrypt.
- **Source References:** PRD `FR-001`, `NFR-007`, `AC-006`; guardrails `When To Stop`; architecture §§5–6, `MatrixBridgeContainer`, room invariants and `AD-01`, `AD-14`.
- **Applies To:** кожний inbound Element/Matrix event та archive request.
- **Required Evidence:** unit cases для room/mxid/device normalization; integration receipts for wrong room, other mxid, unverified/revoked device, missing key and failed room invariant; E2E proof that denied input launches no agent lease, returns no protected data and changes no Active Session.
- **Pass Condition:** E2EE decrypt and all room/device invariants pass before protected processing; identity is rechecked at registrar; denied attempts produce no agent/runtime/archive effect.
- **Fail Or Block Condition:** plaintext fallback, room/device bypass, inconsistent identity, protected response, runtime launch, archive access or state mutation for unauthorized input.
- **Rerun Rule:** після bridge, crypto store, homeserver, room/device membership, identity normalization, routing or secret changes.
- **Automation Status:** `not available yet`.

### `G-03 consent_and_data_safety`

- **Gate:** `consent_and_data_safety`
- **Purpose:** enforce ordinary consent, independent permissions, safe input types, minimum context, secret rejection and conservative sensitive-document handling.
- **Source References:** PRD `FR-002`–`FR-006`, `FR-024`, `FR-035`, `NFR-006`, `NFR-008`, `AC-005`; guardrails `When To Ask`, `When To Stop`; architecture §§3, 5–6, 14–16 and `RegistrarDO` policy/secret boundaries.
- **Applies To:** text/image/PDF intake, sensitive document, >10-minute continuation, personal coaching boundary, external/high-risk action and deletion permission.
- **Required Evidence:** unit policy/state cases; integration proof that Secret is stopped before immutable storage/dispatch and not echoed; context-diff evidence per lease; E2E ordinary consent, supported attachments, unsupported type, secret, sensitive/uncertain document and separate permissions.
- **Pass Condition:** every permission is explicit and scope-bound; uncertain sensitive document waits for permission; Secret reaches no agent, canonical log, telemetry, archive or export; agents receive only bounded redacted context.
- **Fail Or Block Condition:** implicit/inherited permission, plaintext secret exposure, unsupported input analysis, unconfirmed sensitive processing, excess context or external/high-risk effect without named permission.
- **Rerun Rule:** після policy/classifier, prompt/context projection, attachment, permission or external-effect changes.
- **Automation Status:** `not available yet`; manual policy evidence remains required for classification boundaries.

### `G-04 session_idempotency_and_generation`

- **Gate:** `session_idempotency_and_generation`
- **Purpose:** preserve one Active Session, dedupe provider events and isolate generations/contexts.
- **Source References:** PRD `FR-007`, `FR-020`, `FR-022`, `NFR-009`, `AC-004`; architecture §§5–6, 13–14, 17, `RegistrarDO`, `ActiveSession` and `AD-09`–`AD-10`.
- **Applies To:** session creation/resume, clarification, duplicate Matrix event, `Нова задача` and recovery.
- **Required Evidence:** unit state-machine/dedupe cases; integration replay/concurrency evidence; E2E clarification remains in current Session and `Нова задача` creates a new generation without prior active context.
- **Pass Condition:** at most one Active Session; same provider event creates no duplicate session/work/message/cost; new generation rejects stale leases and context.
- **Fail Or Block Condition:** parallel Active Sessions, duplicate effects, context bleed, stale callback acceptance or ambiguous canonical generation.
- **Rerun Rule:** після session state, dedupe key, event routing, concurrency or recovery changes.
- **Automation Status:** `not available yet`.

### `G-05 real_consilium_runtime`

- **Gate:** `real_consilium_runtime`
- **Purpose:** distinguish a real separately executed Консиліум from role labels or one synthetic monologue.
- **Source References:** PRD `FR-008`–`FR-012`, `FR-023`, `AC-001`, `AC-002`, `AC-007`; architecture §§5–6, `CodexAccountRuntime`, `ClaudeCriticRuntime`, `AgentRegistration` and `AD-10`–`AD-12`.
- **Applies To:** routing between Пряма відповідь and Консиліум and every claimed participant.
- **Required Evidence:** integration lease/start/heartbeat/end records for one head and 2–5 separate Codex thread/workspace identities inside one account runtime, plus one separate Claude Code process/workspace; bounded objectives; independent first-pass evidence; E2E visible concrete roles, critic contribution, addressed discussion and truthful unavailable/replacement path. OAuth values are excluded from evidence.
- **Pass Condition:** simple request avoids needless roster; every visible Codex role maps to a distinct current thread/workspace/lease, critic maps to a distinct Claude process, and full Консиліум has the required roster and independent-first-pass behavior. A shared OAuth account does not collapse agent identity, and separate agents do not require cloned credential stores.
- **Fail Or Block Condition:** fabricated role, shared impersonating process, missing critic, direct unleased message, false successful Консиліум or concealed replacement/failure.
- **Rerun Rule:** після routing, roster, runtime adapter, process image/config, lease or critic changes.
- **Automation Status:** `not available yet`; real-process evidence cannot be replaced by unit mocks.

### `G-06 canonical_a2a_verbatim_order`

- **Gate:** `canonical_a2a_verbatim_order`
- **Purpose:** prove registrar-mediated addressed A2A, exact immutable body, canonical order and dedupe.
- **Source References:** PRD `FR-011`–`FR-019`, `NFR-009`–`NFR-011`, `AC-002`, `AC-003`; architecture §§5–6, 13–14, `RegistrarDO`, `ConfirmedMessage`, `AgentRegistration` and `AD-10`–`AD-11`.
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
- **Source References:** PRD `FR-020`–`FR-022`, `AC-004`; guardrails `When To Stop`; architecture §§5–6, 13, 17, `RegistrarDO`, generation fencing and reliability/recovery rules.
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
- **Source References:** PRD `FR-031`, `FR-032`, `NFR-005`, `NFR-010`, `NFR-011`, `AC-003`, `AC-008`; architecture §§5, 14, 17, `ArchiveService`, `SessionArchive` and `AD-13`.
- **Applies To:** input blobs, normal completion, archive/read/export/delete and recovery.
- **Required Evidence:** unit manifest/hash/delete transitions; integration envelope encryption before R2, wrapped-key separation, ciphertext inspection, write/read hash verification, R2 mismatch/key outage, export and delete verification; E2E body/order comparison and double-confirmed whole-session deletion.
- **Pass Condition:** only verified archive transition marks Session completed; stored objects are ciphertext; sequence/count/integrity head recompute; export is complete/order-preserving; individual reply remains immutable; whole-session deletion occurs only after explicit confirmation and verified removal with honest retention disclosure.
- **Fail Or Block Condition:** plaintext object/key, unverified success, missing/reordered body, editable reply, deletion without confirmation, unverifiable removal or claim that provider-held copies were deleted without evidence.
- **Rerun Rule:** після crypto/key, R2, manifest, archive state, export, deletion or retention-policy changes.
- **Automation Status:** `not available yet`; security claims require config inspection plus runtime evidence.

### `G-11 confirmed_cost_accounting`

- **Gate:** `confirmed_cost_accounting`
- **Purpose:** show truthful subscription, infrastructure and provider-limit status without inventing a per-session model charge.
- **Source References:** PRD `FR-033`, `NFR-009`, `NFR-012`, `AC-009`; architecture §§14, 18–19 and `CostRecord`.
- **Applies To:** configured subscription-fee records, infrastructure invoices/usage, provider-reported usage/limit/reset and every `Витрати` response (`MG-09`, `SS-14`).
- **Required Evidence:** unit currency/period/dedupe/unavailable-state cases; integration reconciliation of configured ChatGPT/Codex and Claude monthly fees, actual hosted-Matrix/Cloudflare/R2 spend and exposed provider usage/limit/reset; E2E `Витрати` response for complete and unavailable/partial feeds.
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
- **Purpose:** verify Matrix E2EE, exact room/device invariants, persistent bot crypto state and Cloudflare isolation without claiming an external audit or hiding the bot-decryption boundary.
- **Source References:** PRD `FR-001`, `FR-004`, `FR-005`, `FR-031`, `NFR-005`–`NFR-008`, `AC-005`, `AC-006`; architecture §§3–6, 14, 16–20, `MatrixBridgeContainer`, `RegistrarDO`, `ArchiveService` and `AD-01`, `AD-10`, `AD-13`–`AD-14`.
- **Applies To:** `matrix.org` room, Element and bot devices, bridge/DO/internal bindings, runtime workspaces, outbound handlers, telemetry, R2 and wrapping-key boundary.
- **Required Evidence:** E2EE and ciphertext homeserver evidence; exact room/membership/invite/history/federation/guest/bridge/widget checks; encrypted crypto-store restart; verified/revoked-device tests; `enableInternet=false`, host allowlist and credential-injection inspection; workspace isolation denial; ciphertext R2 and content-free telemetry samples; secret scan covering Matrix/OAuth tokens, `auth.json`, setup-token, reauth URL/code, prompts, A2A, logs, archives, exports and repository artifacts.
- **Pass Condition:** only exact verified devices decrypt; homeserver sees ciphertext; room invariants pass; bridge restores keys without plaintext fallback; agents have scoped leases and no Matrix/R2/archive/OAuth checkpoint credentials; egress is allowlisted; R2 is application-encrypted; telemetry is content-free; OAuth plaintext exists only inside its authorized runtime boundary.
- **Fail Or Block Condition:** unknown member/invite, federation exception without approval, missing/revoked device accepted, lost keys bypassed, shared readable workspace, credential leakage, arbitrary egress, body in telemetry, plaintext R2, OAuth material in Matrix/agent context/evidence or unapproved external effect.
- **Rerun Rule:** після homeserver/room/device, bridge/crypto store, deployment, binding, runtime image, permission, egress, telemetry, archive crypto or key changes.
- **Automation Status:** `not available yet`; manual config review remains required.

### `G-15 v1_real_matrix_e2e`

- **Gate:** `v1_real_matrix_e2e`
- **Purpose:** provide the highest accepted evidence that V1 works as the intended product.
- **Source References:** PRD §9 and `AC-001`–`AC-016`; guardrails `Verification Rules/Evidence Requirements`; architecture full two-surface runtime topology.
- **Applies To:** Product V1 release claim.
- **Required Evidence:** one versioned E2E evidence bundle covering every `AC-001`–`AC-016`: real private E2EE Matrix room and native Element paths; real protected responsive `SUR-02`; exact owner/bot identities and verified devices; deployed Cloudflare Access/Worker/bridge/registrar/settings/runtime; one fenced Codex OAuth lineage with distinct real Codex threads/workspaces; separate Claude setup-token process; A2A v0.3.0; encrypted archive; truthful subscription/infrastructure/quota evidence; `G-18`–`G-20` results on the same deployment lineage.
- **Pass Condition:** all sixteen scenarios pass; related lower-level hard gates pass on the same source/config lineage; no blocking finding remains; limitations are explicit.
- **Fail Or Block Condition:** any AC missing/failed, mock-only homeserver/Access/Worker/provider/runtime, local/static Settings substituted for deployed protected `SUR-02`, browser-preview substituted for Element, missing room/device/access/provider evidence, stale lineage, hidden partial state or unsupported completion claim.
- **Rerun Rule:** full rerun for release candidate after changes to shared registrar/state/security/outbox/runtime/archive contracts; otherwise rerun impacted AC plus regression set defined by future QA.
- **Automation Status:** `not available yet`; real providers/devices require controlled manual or hybrid execution.

### `G-16 approved_visual_baseline_fidelity`

- **Gate:** `approved_visual_baseline_fidelity`
- **Purpose:** bind post-approval user-visible frontend/full-stack/integration units across both product surfaces to the one immutable whole-design baseline.
- **Source References:** guardrails `Design Authority Rules`; design brief `Approved Visual Baseline` (`PC-MATRIX-CANDIDATE-B-V2-20260816-R1`).
- **Applies To:** active hard gate for every user-visible frontend, full-stack or integration unit that affects `SUR-01` or `SUR-02`.
- **Required Evidence:** active Baseline ID; immutable visual target hash; affected routes/states/viewports; permitted variance and operator overrides; `QA-VIS-001`–`QA-VIS-003`; `forge/design/evidence/candidate-b/v2/visual-qa.json`; `PrototypePromotionReceipt` when approved prototype code is reused.
- **Pass Condition:** baseline is current; all required coverage exists; every deviation is permitted or source-backed; no P0, P1 or blocking P2 fidelity finding remains.
- **Fail Or Block Condition:** stale/superseded baseline, missing target/hash/coverage, unexplained material drift, missing required evidence or blocking finding.
- **Rerun Rule:** after every affected user-visible change, baseline supersession, approved override or client-variance change.
- **Automation Status:** `not available yet`.
- **Baseline ID:** `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`.
- **Immutable Target Hash:** `96b91ba9622f8301809ed10ef661a313006e0c2743712912c624edc36a2ca8eb`.
- **Affected Routes States And Viewports:** `SUR-01`–`SUR-02`, `MG-01`–`MG-13`, `SG-01`–`SG-05`, `SS-01`–`SS-46` and 390/430/768/1280/1440 px.
- **Permitted Variance And Operator Overrides:** native Element/Matrix/OS platform variance and source-backed responsive Settings reflow; `SUR-02` uses the HappyPro palette and has no product-authored sound.
- **QA Check IDs:** `QA-VIS-001`–`QA-VIS-003` after checklist reconciliation.
- **VisualQAEvidence References:** `forge/design/evidence/candidate-b/v2/visual-qa.json` and its four listed screenshots.
- **PrototypePromotionReceipt:** not applicable until approved prototype code is reused.

### `G-17 subscription_oauth_private_runtime`

- **Gate:** `subscription_oauth_private_runtime`
- **Purpose:** prove that all Codex and Claude Code work uses only the Власник's eligible paid subscriptions through the authorized private single-owner runtime, with safe credential lifecycle and no API/PAYG/cloud-provider fallback.
- **Source References:** PRD §3.1/§3.5, `FR-009`, `FR-010`, `FR-030`, `FR-033`, `NFR-006`, `NFR-012`, `AC-002`, `AC-007`, `AC-009`; guardrails `Forbidden Changes`, `When To Stop`, `Verification Rules`, `Evidence Requirements`; architecture §§3, 5–6, 13–14, 17–20, `CodexAccountRuntime`, `ClaudeCriticRuntime`, `CodexOAuthCheckpoint`, `ClaudeOAuthSecret` and `AD-10`–`AD-12`; wireframes `SS-28`, `SS-29`, `MG-09`, `MG-11`.
- **Applies To:** bootstrap, deployment, rollback, every dependent model call/agent launch, OAuth refresh/checkpoint/reauth/revocation, quota/plan check, `Витрати`, and any Product V1 release claim.
- **Required Evidence:** current plan/terms eligibility evidence for exact one-owner private non-SaaS use; one content-free Codex lineage ID with sealed checkpoint version/hash, exactly one fenced writer lease, managed refresh/CAS/checkpoint/restore lifecycle, concurrent-writer denial, crash recovery and revocation tests; distinct real head/specialist Codex thread IDs, workspaces and leases sharing that lineage without cloned `auth.json`/OAuth caches; separate Claude Code process/workspace with `claude auth status` confirming subscription OAuth from out-of-band setup-token; environment/config inspection and negative launch cases proving `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, Bedrock, Vertex, Foundry, custom endpoint, API/PAYG/credits and other higher-precedence provider auth are absent and blocked; positive `SS-28`; injected unknown auth mode, expiry, revocation, refresh/checkpoint failure, invalid setup-token, quota exhaustion and ineligible/third-party cases; content-free secret scan over Matrix, prompts, A2A, logs, telemetry, archive, export, repository, images and workspaces; safe out-of-band reauth and fresh-preflight recovery; cost evidence required by `G-11`. Evidence records metadata only, never credentials, codes or auth URLs.
- **Pass Condition:** exactly one mutable Codex OAuth lineage and active credential writer exist; all Codex agents have distinct real contexts without credential-store clones; Claude critic is a separate subscription-OAuth process; exact one-owner private eligibility and quota pass immediately before each dependent call; forbidden auth variables/routes are absent and cannot activate; every negative case blocks before a new model call/reply, emits only safe `SS-29`, preserves confirmed messages and resumes only after provider-managed out-of-band recovery plus fresh `SS-28`; revocation makes old versions unusable; no credential material escapes its authorized runtime boundary; costs follow `G-11`.
- **Fail Or Block Condition:** multiple writers or mutable lineages, copied/reused `auth.json`/OAuth cache, shared/fabricated agent context, missing Claude process, API key/PAYG/cloud-provider/credit fallback, unknown or ineligible plan treated as pass, model call after auth/quota failure, credential/reauth material in Matrix or evidence, stale checkpoint accepted, revoked version reusable, third-party/client/employee/shared/SaaS use, invented AI token charge or unverified recovery.
- **Rerun Rule:** after any auth library/app-server/Claude CLI/runtime image, credential vault/checkpoint/fence, environment/egress, plan/terms, quota adapter, thread/workspace lifecycle, cost feed, deployment or rollback change; after auth/quota/revocation failure rerun the negative case, fresh `SS-28`, affected integration gates and `G-15` before release.
- **Automation Status:** `not available yet`; deterministic environment, fencing, state and leak checks may be automated, but current plan eligibility, provider-managed auth status, revocation/reauth and deployed E2E evidence require controlled manual or hybrid verification.

### `G-18 owner_settings_access_security`

- **Gate:** `owner_settings_access_security`
- **Purpose:** prove that every byte of `SUR-02`, including static assets and API, is available only to the exact Власник through Google-only Cloudflare Access plus independent cryptographic origin validation, with browser/request hardening and no credential-domain leak.
- **Source References:** PRD `FR-037`–`FR-039`, `NFR-006`, `NFR-016`, `AC-012`; guardrails `Forbidden Changes`, `When To Stop`, `Verification Rules`, `Evidence Requirements`; architecture §§7–8, §15, `SettingsAccessGateway`, `AD-02`–`AD-04`; screen-map `SG-01`, `SS-30`–`SS-33`.
- **Applies To:** Settings hostname, HTML/CSS/JS, every Settings API method, Access/Google configuration, JWT/JWKS validator, identity normalization, CSRF/origin policy, response security/cache controls, logs/audit and any release claim involving `SUR-02`.
- **Required Evidence:** exported content-free Cloudflare Access application/policy fingerprint proving one self-hosted application, Google as sole login method, exact owner-email Allow policy, default deny and absence of password, OTP, magic link, default/other IdP, registration, bypass, service-auth and public asset/health exception; deployed positive exact-owner flow; negative request correlation for wrong email and every absent/alternate method; Worker-level cases for missing/malformed/unsigned/invalid/unexpected-algorithm JWT, signature/JWKS/`kid` rotation, wrong `iss`, missing/wrong `aud`, expired/not-yet-valid token, clock-skew boundary, wrong normalized email, header/cookie presence without a valid assertion, JWKS outage with valid bounded cache and expired/unknown-key denial; real response/request evidence for whole-host protection, generic `403`, exact Origin, same-origin Fetch Metadata, bound short-lived CSRF, allowed method/content type/body limit, CORS disabled, `Cache-Control: no-store` on assets/API/errors, CSP/frame/content-type/referrer/permissions/HSTS controls and no third-party resources; secret/leak scan over browser storage, network response, logs, metrics, audit, repo, Matrix and archive proving absence of raw email, JWT/cookie/CSRF, Google OAuth secret and all AI OAuth material. Evidence stores only opaque correlation IDs and result classes.
- **Pass Condition:** exact-owner Google flow succeeds only after edge policy and independent Worker signature/issuer/audience/time/email validation; every negative path yields no protected byte or mutation; public/bypass/alternate login routes do not exist; state changes require all same-origin/CSRF/method/body controls; protected content is not cached or framed; Google/Access secrets and AI OAuth domains never enter Settings payload/storage/log/evidence; denial remains generic and content-free.
- **Fail Or Block Condition:** any protected asset/API reachable without both gates; auth based only on header/cookie or decoded claims; wrong/alternate identity accepted; stale/unknown JWKS bypass; missing CSRF/origin/cache/CSP control required by architecture; sensitive response cached; allowlisted email/policy/token/credential leaked; Google session reads, changes or replaces Codex/Claude Subscription OAuth.
- **Rerun Rule:** after any Access application/policy/IdP/hostname/DNS, Google OAuth config, Worker/JWT/JWKS/email normalization, route/static asset, CSRF/origin/CORS/cache/header, secret/log/audit, browser bundle or deployment/rollback change; rerun all positive/negative cases and affected `AC-012`, `G-15`, `G-20`.
- **Automation Status:** `not available yet`; JWT/request-policy cases can become automated, but current Cloudflare configuration, live Google/Access flow, browser/network and deployed secret-leak evidence require controlled integration/manual execution.

### `G-19 owner_settings_atomic_configuration`

- **Gate:** `owner_settings_atomic_configuration`
- **Purpose:** prove that Owner Settings exposes exactly three allowed groups, validates current provider capabilities without silent downgrade, persists/reset them all-or-nothing and binds only the next new Session to one immutable effective snapshot.
- **Source References:** PRD `FR-040`–`FR-046`, `NFR-017`, `NFR-019`, `AC-013`–`AC-015`; guardrails `Forbidden Changes`, `When To Stop`, `Verification Rules`, `Evidence Requirements`; architecture §§9–13, `OwnerSettingsDO`, `ModelCapabilityCatalogService`, `SessionSettingsResolver`, `AD-05`–`AD-10`; screen-map `SG-02`–`SG-05`, `SS-34`–`SS-45`.
- **Applies To:** Settings schema/defaults/read/save/reset/cancel, capability and speed-policy catalogs, provider/runtime reconciliation, revision/CAS/idempotency/audit, offline/retry/recovery, session creation and every model/depth/speed change.
- **Required Evidence:** deployed GET schema/result showing only separate typed Codex and Claude selectors, one shared `low|medium|high|xhigh` depth, one `швидко|збалансовано|ретельно` preset and separately labeled current/default/effective/active-snapshot values; signed/versioned release catalog and live content-free Codex app-server plus Claude Code subscription-runtime capability receipts for each allowlisted model/effort mapping, availability/provenance/freshness and unsupported/unknown/deprecated/retired/drift cases; negative arbitrary slug, extra key/fourth group, shared selector, per-agent/per-unit override and every cross-field incompatibility; full-object validate-before-save/reset evidence for success and every invalid field, source-backed defaults, explicit reset, cancel/no-write, version conflict, failed storage, timeout-after-commit, offline, exact idempotent retry, reused key/different body and concurrent saves, with before/after revision/hash proving one whole revision or none; server audit proving actor `owner`, operation, before/after revision, catalog version, request hash and result without settings body/email/header/secret; all three speed-policy runtime fingerprints showing only source-backed orchestration changes and no Claude Fast Mode, OpenAI priority/Fast tier, API/PAYG, extra usage/credits or weakening of critic/A2A/E2EE/verbatim/research/safety/privacy/permission/timing guards; session-start evidence pairing one validated settings/catalog revision to a complete immutable snapshot, plus save/reset during active A, next-session B, incompatible C, concurrent save/start and catalog-drift cases.
- **Pass Condition:** response and server schema contain exactly three groups and typed values; both current subscription runtimes confirm the exact mappings at save and again at new-session preflight; unsupported/unknown/stale state blocks save/start with no downgrade; save/reset commits one new full revision or none; CAS and idempotency prevent lost/duplicate/partial writes; cancel/offline never mutate state; shown effective values match the committed revision; Active Session A never changes, the next valid Session receives exactly B, and C/drift starts no Session; every speed preset preserves all mandatory invariants and excluded paid modes remain technically blocked.
- **Fail Or Block Condition:** arbitrary/provider-mismatched value; fourth/hidden/forbidden control; documentation-only capability claim without live provider/runtime evidence; silent effort fallback; stale catalog accepted; partial/per-key write; false success; lost update, duplicate revision or non-idempotent retry; reset bypasses validation; body/email/secret in audit; active snapshot mutation; session start without a complete validated snapshot; any Fast/priority/API/PAYG/extra-usage path or weakened mandatory invariant.
- **Rerun Rule:** after Settings schema/default/catalog/provider mapping/speed policy, runtime/model/entitlement, API/DO storage/CAS/idempotency/audit, offline/client retry, session resolver/Registrar snapshot, invariant/preflight, deployment or rollback change; rerun impacted `AC-013`–`AC-015`, `G-05`–`G-09`, `G-15`, `G-17`, `G-20` as applicable.
- **Automation Status:** `not available yet`; schema/state/CAS/idempotency/snapshot invariants can become automated, but live subscription-runtime capability reconciliation, deployed atomicity/failure injection and cross-runtime invariant evidence require controlled integration/hybrid execution.

### `G-20 owner_settings_runtime_ux`

- **Gate:** `owner_settings_runtime_ux`
- **Purpose:** prove the deployed `SUR-02` is a usable responsive and accessible single-page Owner Settings surface without expanding product scope or treating a static design artifact as runtime evidence.
- **Source References:** PRD `FR-037`, `FR-040`–`FR-045`, `NFR-018`, `AC-016`; wireframes `SUR-02`, `SG-01`–`SG-05`, `SS-30`–`SS-46`; design brief `P-11`–`P-15`, Accessibility Floor, Responsive And Platform Behavior; architecture §§7, 12, 15; guardrails `Verification Rules`, `Evidence Requirements`.
- **Applies To:** every user-visible Settings route/control/status and each `SUR-02` release across 390/430/768/1280/1440 representative viewports, keyboard path and supported assistive-technology/browser combinations recorded by evidence.
- **Required Evidence:** recordings/screenshots plus DOM/accessibility-tree and network/result correlation from the deployed protected hostname covering Access loading/granted/denied, Settings loading, loaded/empty-effective, dirty valid, inline incompatible, provider drift, save progress/success/failure, reset confirmation/result, immutable-active-snapshot notice, permission/auth expiry, offline/reconnect, long model/mapping/error content and mobile reflow; keyboard-only traversal and activation; programmatic names/labels/descriptions/error associations, logical focus and return after confirmation, visible focus ring, live status/error announcements, text zoom/reflow, no color/motion/sound-only meaning, ≥24×24 CSS px targets and 44×44 primary touch target/equivalent on 390/430; semantic order and no horizontal loss of critical action; exact visible inventory of three groups, primary Save, secondary Reset/cancel and current/default/effective values; `G-18`/`G-19` runtime receipts linked so visual success/denial is not inferred from appearance.
- **Pass Condition:** the full `SS-30`–`SS-46` semantic contract is operable and understandable on representative mobile/desktop paths; every control/status has an accessible text/programmatic equivalent; long/zoomed content preserves group/value/error/action relationships; no required action is hover-, color-, motion- or sound-only; only one one-page Settings utility exists, with no sidebar/dashboard/chat/archive/admin surface or forbidden credential/free-text/Fast/PAYG/safety control; observed UI result matches the corresponding access/atomic/provider evidence.
- **Fail Or Block Condition:** primary Settings path unusable by keyboard/assistive technology; unlabeled or unreachable control; invisible/lost focus; unannounced validation/save/denial; color-only status; clipped critical action/content; mobile omission; extra group/surface/navigation/forbidden control; product-owned alternative login UI; visual success without committed state or protected content visible after failed access.
- **Rerun Rule:** after any Settings HTML/CSS/JS/content/control/validation/status/focus/responsive/accessibility, browser hardening that changes rendering, state-contract, viewport/browser support, design source, deployment or baseline change; rerun affected states/viewports, `G-13`, `G-18`, `G-19`, `G-15` and active `G-16` when applicable.
- **Automation Status:** `not available yet`; automated accessibility/browser checks may contribute later, but real deployed keyboard/assistive-tech/device evidence and manual semantic review remain required.

### Requirement Traceability

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
| `FR-017` | `G-06`, `G-12`, `G-13` |
| `FR-018` | `G-06`, `G-12`, `G-13` |
| `FR-019` | `G-06`, `G-12`, `G-13` |
| `FR-020` | `G-04`, `G-08` |
| `FR-021` | `G-08` |
| `FR-022` | `G-04`, `G-08` |
| `FR-023` | `G-05`, `G-07`, `G-09` |
| `FR-024` | `G-03`, `G-07` |
| `FR-025` | `G-09` |
| `FR-026` | `G-09`, `G-13` |
| `FR-027` | `G-09` |
| `FR-028` | `G-09` |
| `FR-029` | `G-09` |
| `FR-030` | `G-09`, `G-17` |
| `FR-031` | `G-10`, `G-14` |
| `FR-032` | `G-10` |
| `FR-033` | `G-11`, `G-17` |
| `FR-034` | `G-12` |
| `FR-035` | `G-03`, `G-09` |
| `FR-036` | `G-09`, `G-13` |
| `FR-037` | `G-13`, `G-18`, `G-20` |
| `FR-038` | `G-18` |
| `FR-039` | `G-17`, `G-18` |
| `FR-040` | `G-13`, `G-19`, `G-20` |
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
| `NFR-005` | `G-10`, `G-14` |
| `NFR-006` | `G-03`, `G-14`, `G-17` |
| `NFR-007` | `G-02`, `G-14` |
| `NFR-008` | `G-03`, `G-14` |
| `NFR-009` | `G-04`, `G-06`, `G-11` |
| `NFR-010` | `G-06`, `G-10` |
| `NFR-011` | `G-06`, `G-10` |
| `NFR-012` | `G-09`, `G-11`, `G-17` |
| `NFR-013` | `G-12`, `G-13` |
| `NFR-014` | `G-09`, `G-13` |
| `NFR-015` | `G-12`, `G-13` |
| `NFR-016` | `G-18` |
| `NFR-017` | `G-19` |
| `NFR-018` | `G-13`, `G-20` |
| `NFR-019` | `G-19` |

#### Acceptance scenarios

| Requirement | Primary gates |
|---|---|
| `AC-001` | `G-04`, `G-05`, `G-07`, `G-09`, `G-15` |
| `AC-002` | `G-05`, `G-06`, `G-07`, `G-09`, `G-15`, `G-17` |
| `AC-003` | `G-06`, `G-10`, `G-12`, `G-13`, `G-15` |
| `AC-004` | `G-04`, `G-08`, `G-15` |
| `AC-005` | `G-03`, `G-14`, `G-15` |
| `AC-006` | `G-02`, `G-14`, `G-15` |
| `AC-007` | `G-05`, `G-07`, `G-09`, `G-15`, `G-17` |
| `AC-008` | `G-10`, `G-15` |
| `AC-009` | `G-11`, `G-15`, `G-17` |
| `AC-010` | `G-12`, `G-13`, `G-15` |
| `AC-011` | `G-03`, `G-09`, `G-13`, `G-15` |
| `AC-012` | `G-15`, `G-18` |
| `AC-013` | `G-15`, `G-19`, `G-20` |
| `AC-014` | `G-15`, `G-17`, `G-19` |
| `AC-015` | `G-15`, `G-19` |
| `AC-016` | `G-13`, `G-15`, `G-20` |

## Lane Or State Promotion Gates

Not applicable: sources define product Session/runtime states, not engineering delivery lanes or repository state-promotion workflow. `SS-01`–`SS-46`, Settings revision/snapshot states and runtime/credential lease states therefore do not create CI/merge lanes. If a future development plan defines engineering lanes, it must bind transitions to the applicable gates in this document without treating ordinary product UI states as engineering gates.

## Eval Result Format

Every persisted eval result records:

| Field | Contract |
|---|---|
| `eval_id` | Stable unique result identifier |
| `gate` | One named gate from `G-01`–`G-20` |
| `scope` | Product, feature unit, change, environment and affected requirement IDs |
| `level` | `unit`, `integration`, `e2e`, `device`, `manual_review` or `static_source` |
| `status` | `passed`, `failed`, `blocked` or `not_applicable` |
| `source_references` | Exact source artifact/version/hash and relevant requirement IDs |
| `environment_fingerprint` | Code revision plus deployed config/runtime/model/A2A/key/export/client identifiers relevant to the claim; no secrets |
| `owner` | Person or agent responsible for executing and reading the evidence |
| `started_at` / `finished_at` | Timestamp with timezone; timing evals additionally retain monotonic durations |
| `expected` / `actual` | Source-backed condition and observed result |
| `evidence_references` | Persistable logs, reports, screenshots/recordings, hashes, provider receipts or archive manifests |
| `evidence_limit` | What this run does not prove |
| `findings` | Zero or more findings with severity/release effect schema below |
| `rerun_of` | Prior result identifier when the run verifies a fix or recovery |

Status semantics:

- `passed`: every applicable pass condition is met with fresh readable evidence and no blocking finding.
- `failed`: the eval executed and at least one pass condition was violated.
- `blocked`: required source, environment, permission, integration, device, evidence or unresolved high-risk policy prevents a valid execution or conclusion.
- `not_applicable`: the source-backed applicability condition is false for this scope; reason is mandatory. `G-16` is active for every affected user-visible unit; it may not be reported `passed` without baseline-bound evidence.

Aggregate completion status is `passed` only when all applicable required child results are `passed`. A `failed` or `blocked` hard gate blocks Done. Advisory findings remain visible and do not change an otherwise valid `passed` result unless their recorded Release Effect is `blocking`.

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

For Settings claims, the bundle additionally links content-free Cloudflare Access/Worker configuration and request-result receipts, catalog/provider-runtime provenance, Settings revision/snapshot hashes and deployed accessibility evidence. It never retains raw owner email, JWT/cookie/CSRF, Google OAuth secret, Settings body or AI credential; an opaque actor/result correlation is sufficient.

## Evidence Limits

- Static documentation defines intended checks but proves no runtime behavior.
- Mockups and proposed prototypes prove presentation intent only; they do not prove Element/Matrix delivery, native-client equivalence, agent identity, A2A, timing, cancellation, encryption, archive, deletion or cost.
- `consilium/live/*` and its tests prove only local preview mechanics. They are not a product surface, production archive or evidence of deployed V1.
- A successful Element/Matrix API response proves provider acceptance only, not user-visible delivery/read or client formatting.
- A visible role label proves no separate real agent context: Codex requires distinct current thread/workspace/lease evidence, while Claude requires a distinct current process/workspace/lease.
- Distinct Codex role/thread labels do not prove credential isolation; evidence must show those distinct contexts under one fenced OAuth lineage and no cloned auth store.
- `account/read`, `claude auth status` or a plan screenshot proves only the observed auth/plan state, not a universal legal right, future eligibility, quota sufficiency for later calls or absence of fallback elsewhere in configuration.
- A Cloudflare Access login screen, valid-looking email, cookie/header presence or decoded-but-unverified JWT does not prove Google-only exact-email policy, signature/JWKS, `iss`/`aud`/time/email validation, whole-host protection or absence of bypass.
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
- `environment_blocked` — provider, deploy, key, runtime, eligible subscription/quota, Cloudflare Access/JWKS/capability evidence or device unavailable;
- `permission_blocked` — required explicit owner authorization is absent;
- `evidence_blocked` — required evidence cannot be produced or read;
- `policy_blocked` — unresolved high-risk policy prevents a valid pass condition.

## Rerun And Recovery Rules

1. A failed or blocked hard gate is never waived by prose; fix/restore the cause or reduce the claim/scope truthfully.
2. After a fix, rerun the failed gate, its direct dependencies and every acceptance scenario affected by the changed shared contract.
3. Changes to `RegistrarDO` state/order/generation, auth/data policy, Codex lineage/checkpoint/writer fencing, Claude setup-token runtime, forbidden environment/egress rules, outbox, runtime adapter, archive/crypto or shared formatter require broader regression because they affect multiple gates.
4. Timing reruns use fresh monotonic measurements and representative load; prior latency does not pass changed deployment/config.
5. Recovery evidence must show both the injected failure and the restored invariant: dedupe under retry, lease replacement, late-output rejection, outbox replay, archive mismatch halt or key-provider pause.
6. A rerun result references the prior result via `rerun_of`; the old result remains immutable.
7. If only advisory P2/P3 remains, aggregate may pass only when the finding, rationale, owner and follow-up are persisted.
8. Post-approval baseline or approved override changes rerun `G-16` for all affected states/viewports/clients.
9. Auth expiry/revocation/quota or crash-recovery reruns must show the fail-closed event, absence of any dependent call/fallback, safe out-of-band recovery where applicable, a fresh `SS-28`, and affected `G-05`, `G-11`, `G-14`, `G-15`, `G-17` results.
10. Access/Google/JWT/request-security changes rerun `G-18` across the complete positive/negative identity and browser-security matrix, plus affected `G-15`/`G-20`; a single happy-path login cannot substitute.
11. Settings schema/catalog/provider/speed/persistence/snapshot changes rerun `G-19` including failure injection, live capability reconciliation and concurrent save/start, plus affected `G-15`/`G-17`/`G-20`.
12. `SUR-02` presentation or interaction changes rerun affected deployed states/viewports/accessibility paths in `G-20` and active `G-16`; runtime result correlation remains required.

## PR Merge And Completion Rules

The repository currently defines no package scripts, CI configuration, branch protection, PR template or deployment gate. This document does not invent them.

- A change may be called `merge-ready` only when its requirement trace is complete, all applicable unit/integration/manual design gates pass on the current revision and no blocking finding remains.
- A merge or local commit is not a release claim. Product V1 is `release-ready` only after all applicable hard gates, including `G-15`, active `G-16`, and `G-17`–`G-20`, pass.
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
4. **Runtime configuration.** Exact pinned Codex app-server/SDK and Claude Code versions, A2A v0.3.0 serialization profile, runtime adapter start/heartbeat/cancel semantics, wrapping-key provider, crypto version and retry scheduler remain implementation-bound; related gates cannot pass until the deployed choices are named and evidenced.
5. **Subscription, infrastructure and provider-status feeds.** Which configured subscription-fee records, actual infrastructure billing/usage feeds and provider-supported usage/limit/reset signals are authoritative? `G-11` requires reconciliation where data exists and `невідомо` where it does not; missing provider status never becomes an invented monetary AI total, reset or per-session token charge.
6. **Client variance.** Current Element/Matrix formatting and accessibility behavior on Mac, iPhone, Samsung Flip7/Android and Windows requires real-device evidence and honest reporting of material differences.
7. **Matrix.org.** `matrix.org` is the selected V1 public homeserver on its current free plan. Production `G-02`, `G-14` and `G-15` remain blocked until the free-plan status, bot policy, reliability, private E2EE room invariants and verified device lifecycle have live evidence. `m.federate: false` is not a V1 gate because the owner does not control that server-level setting on the public homeserver.
