# DoD And Evals

- Продукт: `Personal Consultant`
- Версія контракту: V1, pre-prototype proposed phase
- Дата: 15.08.2026
- owner_invocation_id: `5082ce66-e734-415c-b1bf-064bab46531f`

## Source References

Порядок істини успадковано з `docs/guardrails.md`. `docs/product-idea.md` використано, тому що `docs/prd.md` прямо називає його основним джерелом продуктового наміру. Поточна pipeline-фаза є pre-prototype proposed phase: Approved Visual Baseline ще не потрібен, а чинний visual-evidence контракт походить із валідованого proposed `docs/design-brief.md`. Після одного whole-design approval візуальний гейт має бути конкретизований даними approval receipt.

| Джерело | SHA-256 / evidence | Спожиті фрагменти |
|---|---|---|
| `README.md` | `d1afdf92181df9e002f9f75678f8ca46083c90bec0a9a33e47535a0593fa1c9c` | Позиціонування; практичний результат; локальний browser-preview лише як обмежений evidence |
| `docs/product-idea.md` | `627dfdadc2363e1011e3ea0091c598c8f989e43fdf1ec45c512705ca0f9cf902` | Element/Matrix V1; реальний Консиліум; private single-owner subscription OAuth; дані, час, архів, команди й витрати |
| `docs/prd.md` | `0c61a4dd97564f6ba17c2a387e2b420adad4282f3bf778f3b644a3d9c28920b6` | `US-001`–`US-023`; `FR-001`–`FR-036`; `NFR-001`–`NFR-015`; `AC-001`–`AC-011`; OAuth-only і fail-closed contract |
| `docs/project-context.md` | `b7710d6018a19a949cdb7d6b89051b57b765f425bcfb1f0eef2d469d129664f0` | Outcomes; platforms; private/non-SaaS boundary; constraints; assumptions; risks; open questions |
| `docs/canonical-terms.md` | `469ff18d98fc2001cce2e485195bd57c9b19b7603119c026cddcd810dc04d540` | Ролі; об'єкти; команди; стани; OAuth; A2A; Реєстратор; Канонічний порядок; Облік витрат |
| `docs/guardrails.md` | `45f6003f56462073514928a038ec24630f4a85529328d66ec6ae972945eb0737` | Source order; private-use and OAuth boundaries; stop rules; credential containment; evidence; design authority |
| `docs/user-journey.md` | `4fc297e61081690cb7f03e150388b65a32952eaa99bec494008648b6c334d944` | Stages 1–10; decisions; OAuth preflight/recovery; failures; costs; success |
| `docs/screen-map.md` | `3f12f48577b03e26f8d0e1ce51fb9f1f53f5bdbb7dd534c56e1c9c3191766ef3` | `SUR-01`; `MG-01`–`MG-13`; `SS-01`–`SS-29`; transitions; edge paths |
| `docs/wireframes.md` | `49e5ae2421827373c3d3565520d1b548c5d832b3d6c515f4ffb9dc6252f7a700` | Native Element patterns; `SS-28`/`SS-29`; costs; state coverage; accessibility |
| `docs/design-brief.md` | `c0bc4237b1668cd04262ff8662018b5c9df3aafc866739eab1f10f71acbba60f` | Proposed Candidate B contract; `P-01`–`P-10`; `SS-28`/`SS-29`; no approved baseline |
| `docs/architecture.md` | `1b7c452e534140730028fb57a158cec28f47c681528d693d2b5a852bcdf3c69b` | Matrix/E2EE; fixed `RegistrarDO`; one fenced Codex OAuth lineage/writer; separate Codex threads and Claude process; fail-closed auth/quota; encrypted R2; truthful costs |
| Поточний репозиторій | Read-only inspection, 15.08.2026 | `scripts/consilium-*.mjs`, `consilium/live/*` і `tests/consilium-chat.test.mjs` доводять лише локальне збереження body, форматування й preview; package manifest, CI, Cloudflare config і production runtime відсутні |
| Явна pipeline-вказівка | 15.08.2026 | Pre-prototype proposed phase; Approved Visual Baseline не є передумовою цього артефакту; visual gates спираються на proposed design contract і конкретизуються після approval |

## Definition Of Done Model

Done — це підтверджений стан, а не самооцінка агента, наявність документа, зелений локальний тест або прийняття повідомлення зовнішнім API. Стан визначається для конкретного scope та environment свіжими результатами всіх застосовних гейтів.

Рівні Done:

1. **Product V1 Done:** усі `AC-001`–`AC-011` пройдено в розгорнутому середовищі через реальну приватну E2EE Matrix-кімнату з перевіреними пристроями, один fenced authoritative Codex subscription-OAuth lineage, окремі реальні Codex threads/workspaces, окремий Claude Code subscription-OAuth process і фактичні provider/runtime integrations; усі hard gates пройдено.
2. **Feature unit Done:** усі пов'язані `FR`/`NFR` мають unit та integration evidence; user-visible scope також має потрібний Element/Matrix/design evidence; жодного blocking finding не залишилося.
3. **Change Done:** зміна має визначений scope, трасування до вимог, свіжий evidence після останньої зміни й не порушує неохоплені інваріанти.
4. **Evidence-limited result:** якщо runtime або provider evidence недоступний, результат може бути лише `blocked` або чесно частковим; він не підвищується до Done.

## Acceptance Criteria Vs Definition Of Done

Acceptance criteria відповідають на питання, чи реалізовано потрібну поведінку конкретного сценарію. Для V1 це `AC-001`–`AC-011`.

Definition of Done відповідає на питання, чи завершено scope до повторюваного стандарту: вимога реалізована, інтегрована, безпечно обмежена, перевірена на потрібному рівні, має свіжі докази, не містить blocking findings і готова до заявленого середовища. Проходження одного acceptance-сценарію не замінює standing DoD.

## Global Definition Of Done

Scope є Done лише коли одночасно:

- його вимоги й acceptance-сценарії трасуються до конкретних гейтів;
- кожний застосовний hard gate має статус `passed` на поточній версії коду, конфігурації, runtime і design source;
- unit evidence доводить локальні інваріанти, integration evidence — контракти між реальними модулями, а end-to-end evidence — фактичний користувацький результат;
- немає відкритих P0, P1 або P2 із `Release Effect: blocking`;
- статика, mockup, prototype, згенерований HTML чи локальний browser-preview не використані як доказ Element/Matrix, Cloudflare, A2A, реальних процесів, архіву, вартості або доставки;
- твердження про успіх не перевищує evidence: provider acceptance не називається delivery, кілька labels не називаються реальним Консиліумом, а оцінка вартості не називається фактичною сумою;
- user-visible content відповідає чинному proposed design contract; до approval жоден prototype не названо Approved Visual Baseline;
- після whole-design approval кожний user-visible implementation scope додатково проходить `approved_visual_baseline_fidelity`;
- evidence bundle містить owner, час, environment/config fingerprint, source revision, фактичний результат і незмінні посилання або hashes.
- один-owner/non-SaaS eligibility, auth mode, quota, credential-writer fence і відсутність API/PAYG/cloud-provider fallback перевірені до кожного залежного model call; unknown або failure веде до `SS-29`, а не до часткового прихованого запуску.

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
| `G-13 proposed_design_contract_fidelity` | Pre-approval prototype або user-visible implementation |
| `G-14 matrix_e2ee_room_and_platform_isolation` | Deployed integration та release |
| `G-15 v1_real_matrix_e2e` | Product V1 release |
| `G-16 approved_visual_baseline_fidelity` | Inactive до whole-design approval; після approval стає hard gate для user-visible release scope |
| `G-17 subscription_oauth_private_runtime` | Будь-який model call, agent launch, `SS-28`/`SS-29` або Product V1 release |

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
- A2A draft → atomic registration/order/hash → target route і visible outbox;
- `RegistrarDO` → `ArchiveCryptoPort`/key provider → ciphertext R2 object → read-back/hash verification;
- archive export і confirmed whole-session deletion з provider-retention disclosure;
- failure injection для duplicate event, runtime loss, late callback, outbox retry, R2 mismatch, key-provider unavailability й incomplete usage.

Contract-test doubles можуть допомагати відтворюваності, але release evidence має включати фактичні configured integrations для claims, які залежать від них.

### System Checks

System/end-to-end evidence запускає `AC-001`–`AC-011` через реальну приватну E2EE Matrix-кімнату, точні room/mxid, перевірені Element/bot devices, розгорнуту Cloudflare server side, one named registrar, one fenced Codex OAuth lineage/writer, distinct real Codex threads/workspaces, real separate Claude Code subscription-OAuth critic, configured A2A v0.3.0 adapter, encrypted archive path and actual cost records.

Окремо фіксуються:

- received, provider-accepted, delivered/read/failed statuses, не змішуючи їх;
- timestamps для 5/30/60 секунд і 10 хвилин;
- process lease identities та generation;
- Codex credential lineage/checkpoint/writer-fence metadata, distinct thread/workspace identities, Claude process/auth-mode status and credential-free environment inspection without secret values;
- positive `SS-28` preflight and injected unknown/expired/revoked/refresh-failed/invalid-setup-token/quota-exhausted/ineligible/forbidden-credential cases that reach `SS-29` before a dependent call and resume only after provider-managed out-of-band recovery plus fresh preflight;
- canonical body/order comparison між registrar, Element/Matrix-visible stream, export і archive;
- actual client/app/OS versions у device evidence matrix;
- injected failure, partial status, recovery result and rerun.

### UX/UI Checks

- У pre-prototype phase перевіряється `G-13 proposed_design_contract_fidelity` проти `docs/design-brief.md`: рівно одна `SUR-01`, `MG-01`–`MG-13` (13 груп), `SS-01`–`SS-29` (29 станів), native Element/Matrix chrome, `P-01`–`P-10`, content hierarchy, plain-text meaning та accessibility floor.
- Representative evidence охоплює 390, 430, 768, 1280 і 1440 px як design stress viewports, але browser rendering не підміняє current-client evidence.
- Реальні Element/Matrix clients перевіряються на Mac, iPhone, Samsung Flip7/Android і Windows PC щодо order, formatting, long body, role/`HH:MM`, text scaling/screen-reader path і disclosed variance.
- Після approval застосовується `G-16 approved_visual_baseline_fidelity` з фактичними Baseline ID, immutable target hash, coverage, concrete QA check IDs and `VisualQAEvidence`.

### Release Checks

Release-ready вимагає:

- усі hard gates, застосовні до V1, `passed` зі свіжим evidence;
- `G-15` пройдений у production-like або production environment, що використовує реальних providers/processes; середовище названо точно;
- configured model/runtime/A2A/key/retry/export choices зафіксовано у evidence fingerprint;
- `G-17` підтверджує актуальну private single-owner plan eligibility, subscription OAuth-only mode, один authoritative Codex writer/checkpoint lineage, окремі реальні agent contexts, Claude setup-token process, quota/fail-closed behavior і відсутність paid fallback;
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
| `G-13 proposed_design_contract_fidelity` | Static/design inspection, prototype/device evidence | `FR-017`–`FR-019`, `FR-026`, `FR-036`; `NFR-013`–`NFR-015`; `AC-003`, `AC-010`, `AC-011` |
| `G-14 matrix_e2ee_room_and_platform_isolation` | Static config, integration, deployed evidence | `FR-001`, `FR-004`, `FR-005`, `FR-031`; `NFR-005`–`NFR-008`; `AC-005`, `AC-006` |
| `G-15 v1_real_matrix_e2e` | Real end-to-end | `AC-001`–`AC-011` and all supporting `FR`/`NFR` |
| `G-16 approved_visual_baseline_fidelity` | Post-approval visual/device evidence | Post-approval user-visible frontend/full-stack/integration scope |
| `G-17 subscription_oauth_private_runtime` | Unit, integration, security, deployed E2E | `FR-009`, `FR-010`, `FR-030`, `FR-033`; `NFR-006`, `NFR-012`; `AC-002`, `AC-007`, `AC-009` |

### `G-01 source_contract_integrity`

- **Gate:** `source_contract_integrity`
- **Purpose:** не дозволити stale або суперечливому source chain визначати Done.
- **Source References:** усі записи `Source References`; `docs/guardrails.md: Source Of Truth Order`.
- **Applies To:** кожний change, feature unit, PR/completion і release claim.
- **Required Evidence:** hashes актуальних source artifacts; diff/source review; requirement-to-gate trace; explicit record of any superseded source.
- **Pass Condition:** hashes відповідають фактично прочитаним files, dependencies validated, конфліктів scope/term/authority немає або вони явно вирішені upstream.
- **Fail Or Block Condition:** source missing/stale, hash mismatch, silent conflict, untraced requirement або downstream rule змінює upstream scope.
- **Rerun Rule:** після кожної зміни будь-якого source artifact, approval receipt або architecture/config contract.
- **Automation Status:** `manual`; hash/coverage scan може бути automated після появи project tooling.

### `G-02 ingress_authorization`

- **Gate:** `ingress_authorization`
- **Purpose:** допустити protected processing лише для exact private room, exact owner mxid і verified/non-revoked devices після успішного E2EE decrypt.
- **Source References:** PRD `FR-001`, `NFR-007`, `AC-006`; guardrails `When To Stop`; architecture `MatrixBridgeContainer`, `RoomInvariantGate` і Trust boundaries.
- **Applies To:** кожний inbound Element/Matrix event та archive request.
- **Required Evidence:** unit cases для room/mxid/device normalization; integration receipts for wrong room, other mxid, unverified/revoked device, missing key and failed room invariant; E2E proof that denied input launches no agent lease, returns no protected data and changes no Active Session.
- **Pass Condition:** E2EE decrypt and all room/device invariants pass before protected processing; identity is rechecked at registrar; denied attempts produce no agent/runtime/archive effect.
- **Fail Or Block Condition:** plaintext fallback, room/device bypass, inconsistent identity, protected response, runtime launch, archive access or state mutation for unauthorized input.
- **Rerun Rule:** після bridge, crypto store, homeserver, room/device membership, identity normalization, routing or secret changes.
- **Automation Status:** `not available yet`.

### `G-03 consent_and_data_safety`

- **Gate:** `consent_and_data_safety`
- **Purpose:** enforce ordinary consent, independent permissions, safe input types, minimum context, secret rejection and conservative sensitive-document handling.
- **Source References:** PRD `FR-002`–`FR-006`, `FR-024`, `FR-035`, `NFR-006`, `NFR-008`, `AC-005`; guardrails `When To Ask`, `When To Stop`; architecture `PolicyGate`, `Security Privacy And Access Model` and `Trust Boundaries And Secret Handling`.
- **Applies To:** text/image/PDF intake, sensitive document, >10-minute continuation, personal coaching boundary, external/high-risk action and deletion permission.
- **Required Evidence:** unit policy/state cases; integration proof that Secret is stopped before immutable storage/dispatch and not echoed; context-diff evidence per lease; E2E ordinary consent, supported attachments, unsupported type, secret, sensitive/uncertain document and separate permissions.
- **Pass Condition:** every permission is explicit and scope-bound; uncertain sensitive document waits for permission; Secret reaches no agent, canonical log, telemetry, archive or export; agents receive only bounded redacted context.
- **Fail Or Block Condition:** implicit/inherited permission, plaintext secret exposure, unsupported input analysis, unconfirmed sensitive processing, excess context or external/high-risk effect without named permission.
- **Rerun Rule:** після policy/classifier, prompt/context projection, attachment, permission or external-effect changes.
- **Automation Status:** `not available yet`; manual policy evidence remains required for classification boundaries.

### `G-04 session_idempotency_and_generation`

- **Gate:** `session_idempotency_and_generation`
- **Purpose:** preserve one Active Session, dedupe provider events and isolate generations/contexts.
- **Source References:** PRD `FR-007`, `FR-020`, `FR-022`, `NFR-009`, `AC-004`; architecture `Runtime And Automation Model`, `SessionState`, `MatrixOutboxIntent` and `Failure And Recovery Model`.
- **Applies To:** session creation/resume, clarification, duplicate Matrix event, `Нова задача` and recovery.
- **Required Evidence:** unit state-machine/dedupe cases; integration replay/concurrency evidence; E2E clarification remains in current Session and `Нова задача` creates a new generation without prior active context.
- **Pass Condition:** at most one Active Session; same provider event creates no duplicate session/work/message/cost; new generation rejects stale leases and context.
- **Fail Or Block Condition:** parallel Active Sessions, duplicate effects, context bleed, stale callback acceptance or ambiguous canonical generation.
- **Rerun Rule:** після session state, dedupe key, event routing, concurrency or recovery changes.
- **Automation Status:** `not available yet`.

### `G-05 real_consilium_runtime`

- **Gate:** `real_consilium_runtime`
- **Purpose:** distinguish a real separately executed Консиліум from role labels or one synthetic monologue.
- **Source References:** PRD `FR-008`–`FR-012`, `FR-023`, `AC-001`, `AC-002`, `AC-007`; architecture `Codex account runtime`, `Claude Code critic`, `AgentIdentity`, `AD-03`–`AD-05`.
- **Applies To:** routing between Пряма відповідь and Консиліум and every claimed participant.
- **Required Evidence:** integration lease/start/heartbeat/end records for one head and 2–5 separate Codex thread/workspace identities inside one account runtime, plus one separate Claude Code process/workspace; bounded objectives; independent first-pass evidence; E2E visible concrete roles, critic contribution, addressed discussion and truthful unavailable/replacement path. OAuth values are excluded from evidence.
- **Pass Condition:** simple request avoids needless roster; every visible Codex role maps to a distinct current thread/workspace/lease, critic maps to a distinct Claude process, and full Консиліум has the required roster and independent-first-pass behavior. A shared OAuth account does not collapse agent identity, and separate agents do not require cloned credential stores.
- **Fail Or Block Condition:** fabricated role, shared impersonating process, missing critic, direct unleased message, false successful Консиліум or concealed replacement/failure.
- **Rerun Rule:** після routing, roster, runtime adapter, process image/config, lease or critic changes.
- **Automation Status:** `not available yet`; real-process evidence cannot be replaced by unit mocks.

### `G-06 canonical_a2a_verbatim_order`

- **Gate:** `canonical_a2a_verbatim_order`
- **Purpose:** prove registrar-mediated addressed A2A, exact immutable body, canonical order and dedupe.
- **Source References:** PRD `FR-011`–`FR-019`, `NFR-009`–`NFR-011`, `AC-002`, `AC-003`; architecture `A2A and visible message lifecycle`, `ConfirmedEnvelope`, `AD-07`.
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
- **Source References:** PRD `FR-020`–`FR-022`, `AC-004`; guardrails `When To Stop`; architecture `A2A and visible message lifecycle`, `Security Privacy And Access Model` and `Failure And Recovery Model`.
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
- **Source References:** PRD `FR-031`, `FR-032`, `NFR-005`, `NFR-010`, `NFR-011`, `AC-003`, `AC-008`; architecture `CryptoArchive`, `ArchiveManifest`, `AD-06` and `Trust Boundaries And Secret Handling`.
- **Applies To:** input blobs, normal completion, archive/read/export/delete and recovery.
- **Required Evidence:** unit manifest/hash/delete transitions; integration envelope encryption before R2, wrapped-key separation, ciphertext inspection, write/read hash verification, R2 mismatch/key outage, export and delete verification; E2E body/order comparison and double-confirmed whole-session deletion.
- **Pass Condition:** only verified archive transition marks Session completed; stored objects are ciphertext; sequence/count/integrity head recompute; export is complete/order-preserving; individual reply remains immutable; whole-session deletion occurs only after explicit confirmation and verified removal with honest retention disclosure.
- **Fail Or Block Condition:** plaintext object/key, unverified success, missing/reordered body, editable reply, deletion without confirmation, unverifiable removal or claim that provider-held copies were deleted without evidence.
- **Rerun Rule:** після crypto/key, R2, manifest, archive state, export, deletion or retention-policy changes.
- **Automation Status:** `not available yet`; security claims require config inspection plus runtime evidence.

### `G-11 confirmed_cost_accounting`

- **Gate:** `confirmed_cost_accounting`
- **Purpose:** show truthful subscription, infrastructure and provider-limit status without inventing a per-session model charge.
- **Source References:** PRD `FR-033`, `NFR-009`, `NFR-012`, `AC-009`; architecture `CostSnapshot`, `Capacity And Cost Model`, `AD-09`.
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
- **Purpose:** constrain pre-approval prototypes and user-visible work to the validated proposed design contract without inventing approval.
- **Source References:** `docs/wireframes.md`; `docs/design-brief.md` proposed contract, `P-01`–`P-10`, Accessibility Floor, Responsive And Platform Behavior and Approved Visual Baseline section.
- **Applies To:** every pre-approval Prototype Mockup Candidate and any user-visible implementation/evidence before whole-design approval.
- **Required Evidence:** exact coverage scan proving `SUR=1`, `MG=13` (`MG-01`–`MG-13`) and `SS=29` (`SS-01`–`SS-29`), including subscription preflight `SS-28`, fail-closed `SS-29`, and `P-01`–`P-10`; representative 390/430/768/1280/1440 stress views; manual content/accessibility review; explicit `proposed` label.
- **Pass Condition:** native Element/Matrix chrome remains inherited; candidates differ only in allowed presentation emphasis; full body/order/role/state meaning persist; critical meaning has plain-text form; no candidate is called approved.
- **Fail Or Block Condition:** custom product surface/chrome/control, browser-preview as product target, collapsed/edited agent body, color-only meaning, missing representative state or false Approved Visual Baseline claim.
- **Rerun Rule:** після wireframe/design-brief change, candidate revision or user-visible implementation change.
- **Automation Status:** `manual`.

### `G-14 matrix_e2ee_room_and_platform_isolation`

- **Gate:** `matrix_e2ee_room_and_platform_isolation`
- **Purpose:** verify Matrix E2EE, exact room/device invariants, persistent bot crypto state and Cloudflare isolation without claiming an external audit or hiding the bot-decryption boundary.
- **Source References:** PRD `FR-001`, `FR-004`, `FR-005`, `FR-031`, `NFR-005`–`NFR-008`, `AC-005`, `AC-006`; architecture `Matrix bridge`, `Trust Boundaries And Secret Handling`, `Technology Stack And Constraints`, `Security Privacy And Access Model`, `Performance Reliability And Observability`.
- **Applies To:** hosted homeserver/room, Element and bot devices, bridge/DO/internal bindings, runtime workspaces, outbound handlers, telemetry, R2 and wrapping-key boundary.
- **Required Evidence:** E2EE and ciphertext homeserver evidence; exact room/membership/invite/history/federation/guest/bridge/widget checks; encrypted crypto-store restart; verified/revoked-device tests; `enableInternet=false`, host allowlist and credential-injection inspection; workspace isolation denial; ciphertext R2 and content-free telemetry samples; secret scan covering Matrix/OAuth tokens, `auth.json`, setup-token, reauth URL/code, prompts, A2A, logs, archives, exports and repository artifacts.
- **Pass Condition:** only exact verified devices decrypt; homeserver sees ciphertext; room invariants pass; bridge restores keys without plaintext fallback; agents have scoped leases and no Matrix/R2/archive/OAuth checkpoint credentials; egress is allowlisted; R2 is application-encrypted; telemetry is content-free; OAuth plaintext exists only inside its authorized runtime boundary.
- **Fail Or Block Condition:** unknown member/invite, federation exception without approval, missing/revoked device accepted, lost keys bypassed, shared readable workspace, credential leakage, arbitrary egress, body in telemetry, plaintext R2, OAuth material in Matrix/agent context/evidence or unapproved external effect.
- **Rerun Rule:** після homeserver/room/device, bridge/crypto store, deployment, binding, runtime image, permission, egress, telemetry, archive crypto or key changes.
- **Automation Status:** `not available yet`; manual config review remains required.

### `G-15 v1_real_matrix_e2e`

- **Gate:** `v1_real_matrix_e2e`
- **Purpose:** provide the highest accepted evidence that V1 works as the intended product.
- **Source References:** PRD §9 and `AC-001`–`AC-011`; guardrails `Verification Rules/Evidence Requirements`; architecture full runtime topology.
- **Applies To:** Product V1 release claim.
- **Required Evidence:** one versioned E2E evidence bundle covering every `AC-001`–`AC-011` through a real private E2EE Matrix room, exact owner/bot identities, verified devices, deployed bridge/registrar/agent runtime, one fenced Codex OAuth lineage with distinct real Codex threads/workspaces, separate Claude setup-token process, A2A v0.3.0, encrypted archive and truthful subscription/infrastructure/quota evidence; device/client evidence linked where relevant.
- **Pass Condition:** all eleven scenarios pass; related lower-level hard gates pass on the same source/config lineage; no blocking finding remains; limitations are explicit.
- **Fail Or Block Condition:** any AC missing/failed, mock-only homeserver/bridge/provider/runtime, browser-preview substituted for Element, missing room/device evidence, stale lineage, hidden partial state or unsupported completion claim.
- **Rerun Rule:** full rerun for release candidate after changes to shared registrar/state/security/outbox/runtime/archive contracts; otherwise rerun impacted AC plus regression set defined by future QA.
- **Automation Status:** `not available yet`; real providers/devices require controlled manual or hybrid execution.

### `G-16 approved_visual_baseline_fidelity`

- **Gate:** `approved_visual_baseline_fidelity`
- **Purpose:** bind post-approval user-visible frontend/full-stack/integration units to the one immutable whole-design baseline.
- **Source References:** guardrails `Design Authority Rules`; design brief `Approved Visual Baseline`; explicit pre-prototype pipeline instruction.
- **Applies To:** lifecycle status `inactive` in the current pre-prototype proposed phase because no whole-design approval receipt exists. It becomes an active hard gate immediately after that receipt exists.
- **Required Evidence:** active Baseline ID; immutable visual target hash; affected routes/states/viewports; permitted variance and operator overrides; concrete future QA check IDs; `VisualQAEvidence` references; `PrototypePromotionReceipt` when approved prototype code is reused.
- **Pass Condition:** after approval, baseline is current; all required coverage exists; every deviation is permitted or source-backed; no P0, P1 or blocking P2 fidelity finding remains. While inactive this gate cannot be reported `passed` and does not block prototype creation.
- **Fail Or Block Condition:** after approval, stale/superseded baseline, missing target/hash/coverage, unexplained material drift, missing required evidence or blocking finding.
- **Rerun Rule:** after every affected user-visible change, baseline supersession, approved override or client-variance change.
- **Automation Status:** `not available yet`.
- **Baseline ID:** not assigned before whole-design approval, as confirmed by `docs/design-brief.md`.
- **Immutable Target Hash:** not established before approval.
- **Affected Routes States And Viewports:** proposed coverage is `SUR-01`, `MG-01`–`MG-13`, `SS-01`–`SS-29` and 390/430/768/1280/1440 px; approval receipt must freeze the actual covered set.
- **Permitted Variance And Operator Overrides:** only native Element/Matrix/OS platform variance is presently source-backed; no operator override is recorded.
- **QA Check IDs:** concrete IDs do not exist because `docs/qa-checklist.md` has not yet been created; they become mandatory after approval and before this gate can pass.
- **VisualQAEvidence References:** none exist in the pre-prototype phase.
- **PrototypePromotionReceipt:** not applicable until approved prototype code is reused.

### `G-17 subscription_oauth_private_runtime`

- **Gate:** `subscription_oauth_private_runtime`
- **Purpose:** prove that all Codex and Claude Code work uses only the Власник's eligible paid subscriptions through the authorized private single-owner runtime, with safe credential lifecycle and no API/PAYG/cloud-provider fallback.
- **Source References:** PRD §3.1/§3.5, `FR-009`, `FR-010`, `FR-030`, `FR-033`, `NFR-006`, `NFR-012`, `AC-002`, `AC-007`, `AC-009`; guardrails `Forbidden Changes`, `When To Stop`, `Verification Rules`, `Evidence Requirements`; architecture `Codex account runtime`, `Codex bootstrap, reauth and revocation`, `Claude Code critic`, `Security Privacy And Access Model`, `AD-03`–`AD-05`, `AD-08`–`AD-10`; wireframes `SS-28`, `SS-29`, `MG-09`, `MG-11`.
- **Applies To:** bootstrap, deployment, rollback, every dependent model call/agent launch, OAuth refresh/checkpoint/reauth/revocation, quota/plan check, `Витрати`, and any Product V1 release claim.
- **Required Evidence:** current plan/terms eligibility evidence for exact one-owner private non-SaaS use; one content-free Codex lineage ID with sealed checkpoint version/hash, exactly one fenced writer lease, managed refresh/CAS/checkpoint/restore lifecycle, concurrent-writer denial, crash recovery and revocation tests; distinct real head/specialist Codex thread IDs, workspaces and leases sharing that lineage without cloned `auth.json`/OAuth caches; separate Claude Code process/workspace with `claude auth status` confirming subscription OAuth from out-of-band setup-token; environment/config inspection and negative launch cases proving `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, Bedrock, Vertex, Foundry, custom endpoint, API/PAYG/credits and other higher-precedence provider auth are absent and blocked; positive `SS-28`; injected unknown auth mode, expiry, revocation, refresh/checkpoint failure, invalid setup-token, quota exhaustion and ineligible/third-party cases; content-free secret scan over Matrix, prompts, A2A, logs, telemetry, archive, export, repository, images and workspaces; safe out-of-band reauth and fresh-preflight recovery; cost evidence required by `G-11`. Evidence records metadata only, never credentials, codes or auth URLs.
- **Pass Condition:** exactly one mutable Codex OAuth lineage and active credential writer exist; all Codex agents have distinct real contexts without credential-store clones; Claude critic is a separate subscription-OAuth process; exact one-owner private eligibility and quota pass immediately before each dependent call; forbidden auth variables/routes are absent and cannot activate; every negative case blocks before a new model call/reply, emits only safe `SS-29`, preserves confirmed messages and resumes only after provider-managed out-of-band recovery plus fresh `SS-28`; revocation makes old versions unusable; no credential material escapes its authorized runtime boundary; costs follow `G-11`.
- **Fail Or Block Condition:** multiple writers or mutable lineages, copied/reused `auth.json`/OAuth cache, shared/fabricated agent context, missing Claude process, API key/PAYG/cloud-provider/credit fallback, unknown or ineligible plan treated as pass, model call after auth/quota failure, credential/reauth material in Matrix or evidence, stale checkpoint accepted, revoked version reusable, third-party/client/employee/shared/SaaS use, invented AI token charge or unverified recovery.
- **Rerun Rule:** after any auth library/app-server/Claude CLI/runtime image, credential vault/checkpoint/fence, environment/egress, plan/terms, quota adapter, thread/workspace lifecycle, cost feed, deployment or rollback change; after auth/quota/revocation failure rerun the negative case, fresh `SS-28`, affected integration gates and `G-15` before release.
- **Automation Status:** `not available yet`; deterministic environment, fencing, state and leak checks may be automated, but current plan eligibility, provider-managed auth status, revocation/reauth and deployed E2E evidence require controlled manual or hybrid verification.

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

## Lane Or State Promotion Gates

Not applicable: sources define product Session/runtime states, not engineering delivery lanes or repository state-promotion workflow. `SS-01`–`SS-29` and runtime/credential lease states therefore do not create CI/merge lanes. If a future development plan defines engineering lanes, it must bind transitions to the applicable gates in this document without treating ordinary product UI states as engineering gates.

## Eval Result Format

Every persisted eval result records:

| Field | Contract |
|---|---|
| `eval_id` | Stable unique result identifier |
| `gate` | One named gate from `G-01`–`G-17` |
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
- `not_applicable`: the source-backed applicability condition is false for this scope; reason is mandatory. `G-16` is currently lifecycle status `inactive`, so it cannot be reported `passed`; no eval result is required until whole-design approval activates it.

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

## Evidence Limits

- Static documentation defines intended checks but proves no runtime behavior.
- Mockups and proposed prototypes prove presentation intent only; they do not prove Element/Matrix delivery, native-client equivalence, agent identity, A2A, timing, cancellation, encryption, archive, deletion or cost.
- `consilium/live/*` and its tests prove only local preview mechanics. They are not a product surface, production archive or evidence of deployed V1.
- A successful Element/Matrix API response proves provider acceptance only, not user-visible delivery/read or client formatting.
- A visible role label proves no separate real agent context: Codex requires distinct current thread/workspace/lease evidence, while Claude requires a distinct current process/workspace/lease.
- Distinct Codex role/thread labels do not prove credential isolation; evidence must show those distinct contexts under one fenced OAuth lineage and no cloned auth store.
- `account/read`, `claude auth status` or a plan screenshot proves only the observed auth/plan state, not a universal legal right, future eligibility, quota sufficiency for later calls or absence of fallback elsewhere in configuration.
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

Severity does not silently determine release effect. Nevertheless, unresolved P0 and P1 always block this V1 contract. A P2 blocks when it affects authorization, data/permission boundary, canonical body/order, timing threshold, cancellation, archive integrity, cost truth, a required acceptance path or an expressly blocking design deviation.

Blocker classes:

- `source_blocked` — missing/conflicting/stale authoritative source;
- `implementation_blocked` — required mechanism or interface absent;
- `environment_blocked` — provider, deploy, key, runtime, eligible subscription/quota or device unavailable;
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

## PR Merge And Completion Rules

The repository currently defines no package scripts, CI configuration, branch protection, PR template or deployment gate. This document does not invent them.

- A change may be called `merge-ready` only when its requirement trace is complete, all applicable unit/integration/manual design gates pass on the current revision and no blocking finding remains.
- A merge or local commit is not a release claim. Product V1 is `release-ready` only after all applicable hard gates, including `G-15`, `G-17` and post-approval `G-16` when active, pass.
- Absence of automation is not a waiver: required evidence may be manual/hybrid but must retain the same result schema.
- Human approval is not a default completion gate. The only standing design approval is the future one-time whole-design approval; product-specific explicit permissions remain runtime safety boundaries, not PR approvals.
- Any change that conflicts with current source truth returns to the upstream owner; it is not merged as an implicit requirement change.

## Out Of Scope

- New product requirements, channels, users, roles, screens, message groups, commands, attachment types or parallel Sessions.
- Architecture choices beyond the configurable seams already defined in `docs/architecture.md`.
- Per-screen/per-scenario QA procedures, test data sets, exact commands, screenshots or future QA check IDs.
- Implementation units, coding tasks, milestones, issue hierarchy or delivery schedule.
- CI/provider/tool commands not present in the repository.
- Creating or approving the Matrix-native rendered Candidate B or assigning an Approved Visual Baseline.
- Claiming security, privacy, accessibility, delivery or regulatory guarantees without corresponding runtime and specialist evidence.

## Open Questions

1. **Sensitive-document policy.** Which versioned classes define an Особливо чутливий документ? Until resolved, uncertain documents must request separate permission; production `G-03` is blocked if the implemented classifier has no versioned policy basis.
2. **Stopped/replaced Session lifecycle.** What archive treatment applies after `Стоп` and to the prior Session after `Нова задача`? `G-08` can verify cancellation/isolation, but `G-10` cannot pass those archive paths until the policy is fixed.
3. **Archive/export/deletion contract.** Which bundle/export encoding and content-free deletion receipt/tombstone policy preserve exact body/order while stating provider retention honestly? `G-10` requires the selected contract in its environment fingerprint before release.
4. **Runtime configuration.** Exact pinned Codex app-server/SDK and Claude Code versions, A2A v0.3.0 serialization profile, runtime adapter start/heartbeat/cancel semantics, wrapping-key provider, crypto version and retry scheduler remain implementation-bound; related gates cannot pass until the deployed choices are named and evidenced.
5. **Subscription, infrastructure and provider-status feeds.** Which configured subscription-fee records, actual infrastructure billing/usage feeds and provider-supported usage/limit/reset signals are authoritative? `G-11` requires reconciliation where data exists and `невідомо` where it does not; missing provider status never becomes an invented monetary AI total, reset or per-session token charge.
6. **Client variance.** Current Element/Matrix formatting and accessibility behavior on Mac, iPhone, Samsung Flip7/Android and Windows requires real-device evidence and honest reporting of material differences.
7. **Hosted homeserver.** `matrix.org` is only the conditional PoC default. Production `G-02`, `G-14` and `G-15` remain blocked until bot policy, reliability, room capabilities and the `m.federate: false` decision have live evidence.
8. **Approved Visual Baseline.** Candidate B is the selected content/UX direction, but no Matrix-native Baseline ID, immutable target hash, QA check IDs or VisualQAEvidence exists. This does not block documentation; after whole-design approval it activates `G-16` and its missing fields become blocking.
