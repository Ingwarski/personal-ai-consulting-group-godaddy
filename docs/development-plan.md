# План розробки

- `status`: `awaiting-implementation-prompt`; цей перегляд SDD не дозволяє реалізацію, deployment або зовнішні зміни
- `definition_status`: `prepared`
- `execution_status`: `not_run`
- `release_readiness`: `not_evaluated`
- `updated_at`: `2026-09-05`
- `owner_invocation_id`: `6e95790f-e5cd-428e-93fe-49b35bfa417b`
- `working_language`: `uk`
- Approved Visual Baseline: `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`

Цей артефакт визначає послідовність і межі реалізації. Він не стверджує, що описані QA-перевірки, security review, representative-user sessions, real Matrix integration або release evaluation уже виконані.

## Source References

| Джерело | SHA-256 / binding | Спожите рішення |
|---|---|---|
| `docs/prd.md` | `a45aa866bd0591ba778b8ddf1528f9789fd954eef86dd2d8109c8db3f0ed23cc` | Поточний документ / перевірені інтерфейси й обмеження |
| `docs/project-context.md` | section hashes у manifest | ## 7. Цільові платформи; ## 9. Межі V1; ## 10. Поза межами V1; ## 11. Обмеження; ## 12. Припущення; ## 13. Ризики; ## 14. Відкриті питання |
| `docs/canonical-terms.md` | section hashes у manifest | ## Робоча мова та збережені IT-терміни; ## 2. Ролі; ## 3. Основні доменні об'єкти; ## 4. Дії користувача; ## 5. Стани продукту; ## 6. Назви поверхонь і потоків; ## 7. Затверджені користувацькі терміни; ## 8. Внутрішні терміни |
| `docs/guardrails.md` | `6b88dcd634b03203f9f8dde93bd4e4abdba3fe57205b5f3bb776106b39bd999b` | Поточний документ / перевірені інтерфейси й обмеження |
| `docs/user-journey.md` | `ef058d468fde194ff38efe5d209edbdc3f061d90e4f9602671071c1cc28b2c39` | Поточний документ / перевірені інтерфейси й обмеження |
| `docs/screen-map.md` | `fe25f595f954cb7b04e369aec65066ec31d7a66a3359953c968343713d41039d` | Поточний документ / перевірені інтерфейси й обмеження |
| `docs/wireframes.md` | `e065b36af6ba851cb79a2028227b4599129da9c3656dc4be1a913d08cba62ed5` | Поточний документ / перевірені інтерфейси й обмеження |
| `docs/design-brief.md` | `a5feac6981acefb15cc84e827080d72b4b7b3734a1e6487cf4046f611095396e` | Поточний документ / перевірені інтерфейси й обмеження |
| `docs/architecture.md` | `4f89d993e0029b3dd5b34231ae4177ae315faa860d6e15212c689b8d67ff05d6` | Поточний документ / перевірені інтерфейси й обмеження |
| `docs/dod-evals.md` | section hashes у manifest | ## Definition Of Done Model; ## Acceptance Criteria Vs Definition Of Done; ## Global Definition Of Done; ## Feature Unit Definition Of Done; ## Verification Profile; ## Gate Matrix; ## Lane Or State Promotion Gates; ## Eval Result Format; ## Evidence Requirements; ## Evidence Limits; ## Failure And Blocker Classification; ## Rerun And Recovery Rules; ## PR Merge And Completion Rules; ## Out Of Scope; ## Open Questions |
| `docs/qa-checklist.md` | section hashes у manifest | ### Checklist Field Contract; ### Shared Verification Scope; ## Product Acceptance; ## User Journey Checks; ## Screen And State Checks; ## Wireframe Consistency Checks; ## UX/UI Checks; ## Heuristic Usability Checks; ## Usability Validation Checks; ## Google Owner Access Checks; ## Product Security Requirements; ## Visual Regression Checks; ## Responsive Checks; ## Accessibility Checks; ## Interaction And State-Change Checks; ## Browser And Device Checks; ## Evidence Requirements; ## Evidence Limits; ## Regression Risks; ### Release Evaluation Check |
| `package.json` | `37c436772007d340d21c4b7b8c5d2c9c384262e758e935c949b6160752674614` | Поточний документ / перевірені інтерфейси й обмеження |
| `.github/workflows/matrix-sidecar.yml` | `7d938106d59726180af6951353af8ad5a244948fb1fc13af8f080547e026119e` | Поточний документ / перевірені інтерфейси й обмеження |
| `native/matrix-sidecar/Cargo.toml` | `513aeb016de461432fb07fc345e330a14cc8f6d61e113689d4644cef729e06b1` | Поточний документ / перевірені інтерфейси й обмеження |

Context/terms застосовано вибірково до платформ, меж V1, приватного Власника, термінів і ризиків; вони не створюють нові вимоги. Використані QA/DoD визначення, спільний scope та evidence conventions; **QA Execution Status і Current Execution Limitations не є planning inputs**. Історичні code/run observations нижче — окремий опис стану, не джерело продуктових правил.

## Implementation Strategy

1. Production target is the existing GoDaddy Node 22 application. Legacy Cloudflare adapters remain reference/rollback code only; they are not a runtime dependency or deployment target.
2. Keep Preview stateless. It receives no production database, Matrix store, OAuth or owner-session credentials and cannot read or mutate Published state.
3. Preserve one MySQL-backed canonical registrar. A confirmed agent message and its ordered Matrix outbox record are created in the same transaction; Matrix delivery never defines canonical order.
4. Run Matrix E2EE in one checksum-pinned Rust sidecar. Node owns HTTP, policy, MySQL, provider orchestration and supervision; the sidecar owns only Matrix SDK/session/crypto/store/media transport.
5. Complete local deterministic implementation before any credential, real room/device or deployment action. Those effects require separate just-in-time authorization.
6. Treat the 04.09.2026 Published Rust probe only as host feasibility, not proof of final sidecar, final paths, real Matrix integration or release readiness.
7. Keep destructive legacy code/secret/database cleanup behind `G-00`: exact inventory, backup, isolated restore/reconciliation, rollback and action-time confirmation.

8. Завершити Google-only виправлення U-04 з необхідними seams U-01/U-03/U-07 після нового окремого дозволу. Не перескакувати до наступної unit через зелений SDD checker; зберегти вже зроблені частини U-01–U-09 і повторно перевірити affected acceptance.

## Codebase Map

| Шлях | Поточна роль | Планова дія |
|---|---|---|
| `src/godaddy/server.mjs` | GoDaddy Node HTTP entrypoint | wire liveness and content-free Matrix readiness after supervisor completion |
| `src/godaddy/mysql-storage.ts` | transactional MySQL key/value adapter | reuse for registrar/outbox atomicity; no second state authority |
| `src/session/registrar-do.ts` | registrar domain | add transaction-local publication projection without binding domain logic to Matrix |
| `src/matrix/*` | policy/formatting reference | revalidate ingress/send policy; consume durable outbox instead of direct publish |
| `src/godaddy/settings-runtime.ts`, `src/godaddy/owner-password-auth.ts` | Наявний парольний/session/MySQL runtime, що не відповідає новому Google-only контракту | U-04 замінює identity/transaction boundary, зберігає перевірені session/CAS/restart safeguards; не видаляє live secrets чи таблиці |
| `src/cloudflare/*`, `src/worker.ts`, `wrangler.*` | legacy reference/rollback | never import from GoDaddy production entrypoint; cleanup only through `G-00` |
| `native/matrix-sidecar/**` | Наявні workspace, Cargo.toml/lock і реалізація | Продовжити bounded integration/verification U-06; не створювати наново і не вважати host build deployable |
| `.github/workflows/matrix-sidecar.yml` | Наявний non-deployable verification workflow | Зберегти локальні/Linux checks; U-09 має окремо забезпечити immutable release-builder provenance до promotion |
| `forge/design/candidates/candidate-b/v2/**` | frozen design evidence | never mutate; only bounded U-04 mapping applies |

Спостереження за checkout на 05.09.2026: названі файли існують; Settings runtime досі імпортує парольний сервіс; package scripts для build/typecheck/test/environment існують. Це не новий запуск тестів. Історичні часткові результати U-01–U-09 збережені в manifest та audit evidence; жодна unit не отримує нового completed/released статусу від цього плану. Старий U-06 prompt зберігається лише з authorization-correction, не дозволяє поточний hash плану.

## Implementation Units

### G-00 — GoDaddy recovery and destructive-cleanup gate

- **Purpose:** protect recoverable legacy code, secrets and database state before irreversible cutover or cleanup.
- **Depends On:** exact provider resource inventory and action-time Owner confirmation.
- **Work Items:** inventory exact app/variant/database/path mappings without secret values; preserve immutable Git rollback; create encrypted backup; prove isolated restore and ownership reconciliation; create exact destructive manifest; recheck immediately before action.
- **Acceptance Checks:** dashboard emptiness is not proof; no shared database/table/credential is deleted; rollback and restore evidence identify exact targets; ambiguity blocks action.
- **Verification:** provider metadata, backup hash, isolated restore record, resource-specific destructive manifest and final confirmation receipt.
- **Status:** Published Node/Rust feasibility subgate is complete and retired; recovery/destructive cleanup лишається закритим до action-time дозволу; він не блокує окремо дозволене локальне не-деструктивне виправлення, але й не дозволяє його сам.

### U-01 — GoDaddy Node 22 runtime and hardening boundary

- **Purpose:** provide the deterministic production host and supervisor contract.
- **Depends On:** approved baseline and current plan.
- **Work Items:** maintain Node 22 build/start/`PORT`; validate required configuration fail-closed; enforce trusted host/forwarded-header policy, minimal routes/methods/headers, timeouts and graceful shutdown; keep Preview stateless.
- **Acceptance Checks:** build, typecheck, liveness and host-policy tests pass; missing/unknown production configuration prevents dependent work; production entrypoint imports no legacy Cloudflare runtime.
- **Verification:** `npm run check`, forbidden-env scan, server tests, `git diff --check`.
- **Delivery Layer:** infrastructure.
- **Interfaces Produced:** Node process lifecycle, `/healthz` liveness and readiness aggregation seam.

### U-02 — Owner Settings domain core

- **Purpose:** retain typed complete settings, separate provider catalogs, compatibility validation, defaults and immutable session snapshot.
- **Depends On:** U-01.
- **Work Items:** preserve exact Codex/Claude model-effort contracts; reject arbitrary/stale/incompatible choices; keep speed limited to orchestration; prohibit API/PAYG/credits/Fast Mode fallback.
- **Acceptance Checks:** full-object validation is deterministic; provider defaults transmit no explicit effort; session snapshot cannot mutate.
- **Verification:** settings/catalog/snapshot and capability-drift tests.
- **Delivery Layer:** backend.
- **Interfaces Produced:** `OwnerSettings`, capability receipt and effective snapshot.

### U-03 — MySQL-backed Settings API

- **Purpose:** persist the complete settings document atomically on GoDaddy.
- **Depends On:** U-01, U-02.
- **Work Items:** use MySQL transactions for version/ETag, `If-Match`, idempotency-body hash, full-object save and confirmed reset; keep audit records content-free.
- **Acceptance Checks:** one successful mutation creates one complete revision; stale/concurrent/changed-body retries fail without partial write; restart reads the same revision.
- **Verification:** MySQL/Settings tests for CAS, idempotency, reset, restart and failure injection.
- **Delivery Layer:** backend.
- **Interfaces Produced:** `GET /api/settings`, `PUT /api/settings`, `POST /api/settings/reset`, `SettingsRevision`.
- **Interfaces Consumed:** U-02 schema; U-04 client; U-05 snapshot.

### U-04 — Google-вхід і захищені Налаштування власника

- **Purpose:** реалізувати UC-003/UC-004 у наявному GoDaddy app/hostname: Google-only identity, окремий durable local grant, незалежні provider groups; без власної MFA.
- **Depends On:** U-01, U-02, U-03. U-07 надає вузький readiness/credential-isolation seam, не стає prerequisite для самого Google login.
- **Work Items:**
  1. Виконати архітектуру §8.1–8.3 й усі NFR-016.a–h: trusted ID-token verifier, exact preallowed email + atomic issuer/sub binding, явний POST start, code/PKCE/state/nonce/browser transaction, pending→claimed→consumed без DB lock під час exchange.
  2. Окремий випадковий HMAC-signed local reference grant; зберегти 30-minute idle, 12-hour absolute, cap 16, rotation/logout/revoke-all/generation/restart/disable semantics та regression tests. Старий пароль не є fallback; live secret видалення не входить у це завдання.
  3. Належні host-only Secure/HttpOnly/SameSite=Lax cookies, local POST/PUT Origin/Fetch Metadata/purpose CSRF, bounded limiter/network/JWKS і no-store/security headers на success/error/redirect. Callback має protocol binding, не same-origin mutation guard.
  4. Same-tab повернення веде до `/operations/runtime`, якщо каталог не готовий, інакше `/settings`. Auth-ready, Matrix readiness і consultation-ready незалежні; Google-вхід/logout/relogin не змінюють AI OAuth. Секрети Google/session не передаються AI children.
  5. У protected namespace зберігати лише визначені hash/AEAD transaction/grant/binding records; не друкувати raw tokens, code, nonce/verifier або exact identity. Не робити DDL wipe/міграцію інших застосунків.
  6. Відобразити Google entry/cancel/retry/denied/session expiry/видимі logout/revoke і рівно три незалежні групи; current/default/effective, atomic save/reset і незмінний active snapshot.
- **Acceptance Checks:** кожний QA-AUTH-001–QA-AUTH-008 має окремі allowed/denied/failure/recovery результати. Зберегти старі коректні rotation/logout/restart/concurrency/CAS regressions; відкинути лише парольні очікування. Wrong owner/token, replay/claim race/crash, stale grant/CSRF/cache/config не відкривають protected bytes. Same-tab Google return працює без вимоги готового AI каталогу.
- **Verification:** QA-PA-012–QA-PA-016, QA-AUTH-001–QA-AUTH-008, QA-JRN-005–QA-JRN-006, QA-INT-013–QA-INT-018, QA-INT-022, QA-EVD-006, QA-REG-008–QA-REG-009; UI/HEU/USER bindings у Visual And UX Verification. Локальні mocked-provider tests не замінюють separately authorized real Google/browser proof.
- **Delivery Layer:** full-stack.
- **Approved Baseline / Target:** `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`; `07e3675265e8cadef1e65c132f32e3cbbf4d6537cbfd316ea16a6bacd56f1bd6`.
- **Prototype Root / Tree / Algorithm:** `forge/design/candidates/candidate-b/v2`; `57d103c5ed17bcc9a9d95a58718f83c33b8257229fc825b756367321eaa33199`; `sdd-render-sha256-v2`, залежності з Baseline Binding нижче.
- **Scope:** SUR-02, SG-01–SG-05, SS-30–SS-46; JOB-003 → UC-003/UC-004 → Settings S1–S5; browser viewports та accessibility з QA.
- **Permitted Variance:** тільки source-backed responsive reflow і DB-D18/DB-D19; схвалена палітра/ієрархія та native Matrix незмінні.
- **Security Decision:** виняток власної MFA вже визначений PRD. Усі компенсувальні вимоги обов'язкові; це не нове питання до Власника й не full-ASVS claim.
- **Interfaces:** U-04 володіє Google transaction/owner grant/CSRF; U-03 надає durable transaction storage; U-01 маршрутизацію; U-07 окремий content-free AI readiness. Точні method/path/config contracts — architecture §8, без нового alternate login.

### U-05 — MySQL registrar and atomic publication producer

- **Purpose:** make one durable authority for session generation, canonical order, confirmed bodies and Matrix publication intent.
- **Depends On:** U-01, U-02, U-03.
- **Work Items:** preserve append-only registrar state; create `ConfirmedAgentMessage` and ordered `MatrixOutboxRecord` in the same MySQL transaction; define deterministic transaction ID, lease/fencing, retry and status transitions; make `afterConfirmed` wake the consumer only.
- **Acceptance Checks:** no confirmed message lacks an outbox record; concurrent appends keep order; duplicate/retry/crash cannot duplicate visible work; `Стоп`/new generation fences late output.
- **Verification:** registrar/MySQL/outbox concurrency, rollback, restart, crash-window, duplicate and stale-lease tests.
- **Delivery Layer:** backend.
- **Interfaces Produced:** `ConfirmedAgentMessage`, `MatrixOutboxRecord`, ordered publication port.
- **Integration Verification:** U-06 consumes only durable outbox records and never changes canonical order.

### U-06 — Rust Matrix sidecar, ingress and durable publication

- **Purpose:** operate one private E2EE Matrix transport on GoDaddy while Node/MySQL retain policy and canonical state.
- **Depends On:** U-01 and U-05. The retired probe is feasibility evidence only. Real credentials, room/device setup and deployment require separate JIT authorization.
- **Work Items:**
  1. Завершити та перевірити наявний `native/matrix-sidecar/` with Rust `1.93`, exact `matrix-sdk = "=0.18.0"`, `e2e-encryption`, `bundled-sqlite` and committed `Cargo.lock`.
  2. Перевірити наявний locked/frozen `x86_64-unknown-linux-musl` CI, checksum/SBOM/licenses; його артефакт позначено non-deployable. Для release U-09 має забезпечити pinned immutable builder і окремий provenance; заборонено перейменувати verification binary на release.
  3. Hold one process-lifetime exclusive lock for one encrypted SQLite crypto store; quarantine missing/corrupt/wrong-passphrase/device-mismatch state without automatic logout/delete/reset.
  4. Implement Node supervisor verification of checksum, regular file, owner/mode, version/protocol; enforce hello/ready timeout, bounded 256-KiB UTF-8 NDJSON, strict schema/version/type/ID, queue bounds, backpressure and timeouts.
  5. Розділити `/healthz` liveness, web auth-ready, Matrix transport readiness та consultation readiness за architecture §8/§12; відсутній Google не зупиняє незалежний Matrix transport, AI-каталог не блокує Google login.
  6. Revalidate exact homeserver, room, owner/bot mxids, privacy/encryption/history/guest/bridge/widget policy and trusted non-revoked device on ingress and immediately before send.
  7. Drain U-05 outbox strictly in order with deterministic Matrix transaction IDs; retry the same ID after crash and distinguish `pending`, homeserver `accepted`, separately evidenced `device_delivered` and `read`.
  8. Persist ingress receipt in MySQL before durable ACK; replay the same Matrix event ID after crash without duplicate session, agent work or outbox.
  9. Preserve native reply relations and accept text/image/PDF only. Use a private bounded spool with opaque current-instance handles, size/MIME/extension/magic/hash, regular-file/no-symlink/no-path-escape and ACK/TTL cleanup checks.
  10. Allow only fixed HTTPS homeserver/media egress, disable redirects/discovery/caller-controlled URLs/proxy, and give sidecar no HTTP listener, Unix socket or MySQL access.
  11. On shutdown stop intake, bounded-drain ACK/outbox, send shutdown frame, then bounded wait, `SIGTERM`, `SIGKILL`; crash recovery uses bounded backoff and never resets store.
  12. Before credentials, verify final binary/store/spool permissions and HTTP non-retrievability under both URL roots. Permit only fresh device+confirmed-empty store or exact device/token+exact encrypted-store restore.
- **Acceptance Checks:** checksum/protocol/mode mismatch prevents spawn; second process cannot open store; malformed/oversized/duplicate/late frames fail closed; room/device drift blocks send; crash windows create no duplicate Matrix event; ingress replay creates no duplicate work; invalid/path-escaping media never dispatches; acceptance never becomes delivered/read without evidence.
- **Verification:** `cargo test --locked`; locked musl build; checksum/SBOM/license verification; `QA-SEC-001`; `QA-INT-019`–`QA-INT-024`; Node supervisor/outbox/ingress failure tests. Real-room/four-client checks remain `not_run` until JIT authorization.
- **Delivery Layer:** integration.
- **Baseline / Target:** `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`; `07e3675265e8cadef1e65c132f32e3cbbf4d6537cbfd316ea16a6bacd56f1bd6`.
- **Scope:** `SUR-01`, `MG-01`–`MG-13`, `SS-01`–`SS-29`; native Element clients.
- **Permitted Variance:** Element/OS-native chrome and notifications; complete body, order, role and `HH:MM` are invariant.
- **Gates:** approved visual fidelity, applicable H1–H10, representative tasks `QA-USER-001` and `QA-USER-002`.
- **Interfaces Produced:** `ValidatedMatrixIngress`, `MatrixAcceptanceReceipt`, optional device/read evidence, Matrix readiness.
- **Interfaces Consumed:** U-05 outbox; U-08 results.
- **Interface Owner:** Rust owns SDK/store/transport; Node owns policy/supervision/DB.

### U-07 — Subscription OAuth fencing and provider preflight

- **Purpose:** verify one Codex subscription OAuth lineage and separate Claude Code subscription session without API/PAYG fallback.
- **Depends On:** U-01, U-02, U-05.
- **Work Items:** retain credential-writer fencing, content-free preflight and per-provider receipts; isolate Settings auth; reject forbidden env, API keys, PAYG, credits, unavailable models and failed/private auth before launch.
- **Acceptance Checks:** failure makes no dependent call; credentials/auth URLs/codes never reach Matrix, prompts, logs or archive; немає залежності provider-preflight від Google grant; Google auth використовує власний flow, а не legacy Cloudflare Access.
- **Verification:** provider/process negative tests; real OAuth only after separate authorization.
- **Delivery Layer:** integration.

### U-08 — Consilium runtime, A2A and critical path

- **Purpose:** run the head, 2–5 separate Codex contexts and one separate Claude critic, then publish only registrar-confirmed bodies.
- **Depends On:** U-05, U-06, U-07.
- **Work Items:** route direct/consilium mode; register agents before route; preserve independent first passes, addressed critique/revision and head synthesis; enforce cancellation/generation fences; wake U-06 after U-05 confirmation.
- **Acceptance Checks:** labels cannot substitute for contexts; critic is never silently removed; final series contains one decision, at most three actions, risk/assumption and review condition; no hidden reasoning/tool log/technical ID publishes.
- **Verification:** deterministic adapter tests and `QA-JRN-001`–`QA-JRN-004`; controlled provider/Matrix E2E remains `not_run`.
- **Delivery Layer:** full-stack.
- **Baseline / Scope:** `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`; target `07e3675265e8cadef1e65c132f32e3cbbf4d6537cbfd316ea16a6bacd56f1bd6`; `SUR-01`, `MG-04`–`MG-12`, `SS-08`–`SS-20`.
- **Gates:** approved visual fidelity, applicable H1–H10, `QA-USER-001`–`QA-USER-002`.

### U-09 — Archive, costs, GoDaddy deployment security and release evidence

- **Purpose:** complete encrypted archive/export/delete, truthful costs and release evidence on actual GoDaddy Published lineage.
- **Depends On:** U-03 through U-08; JIT authorization for production credentials/deploy, real Matrix/device tests and destructive archive/delete tests.
- **Work Items:** store only application-encrypted archive ciphertext in MySQL with external key lifecycle and integrity manifest; implement full export and double-confirmed whole-session deletion; reconcile subscription fees with actual GoDaddy/MySQL/Matrix data and provider status; verify Google identity/transaction and local-session bypass/throttle/expiry/rotation/logout/revoke, host/origin/headers and Preview isolation; collect deployment/binary/path/readiness and device evidence.
- **Acceptance Checks:** no plaintext archive or individual reply mutation/deletion; unavailable cost is `невідомо`; release evidence binds exact commit, Published app, DB, binary checksum, paths, Matrix room/devices and all gates.
- **Verification:** `G-10`–`G-23`, `QA-RR-001`, archive restore/tamper/export/delete, GoDaddy security and real-device tests after authorization.
- **Delivery Layer:** integration.

## Unit Obligation Traceability

Кожний рядок задає відповідальність unit за реалізацію перелічених обов'язків/станів у її Work Items та verification. Перетин означає producer/consumer або release integration, не заміну незалежної перевірки. Security parent не підмінює NFR-016.a–h. Виключених обов'язкових вимог/станів немає.

| Unit | Реалізує |
|---|---|
| `U-01` | `NFR-006`, `NFR-009`, `NFR-012`, `NFR-019` |
| `U-02` | `FR-040`, `FR-041`, `FR-042`, `FR-043`, `FR-045`, `FR-046`, `NFR-017`, `NFR-019` |
| `U-03` | `FR-044`, `NFR-017`, `NFR-019` |
| `U-04` | `FR-037`, `FR-038`, `FR-039`, `FR-040`, `FR-041`, `FR-042`, `FR-043`, `FR-044`, `FR-045`, `FR-046`, `NFR-006`, `NFR-009`, `NFR-012`, `NFR-016`, `NFR-016.a`, `NFR-016.b`, `NFR-016.c`, `NFR-016.d`, `NFR-016.e`, `NFR-016.f`, `NFR-016.g`, `NFR-016.h`, `NFR-017`, `NFR-018`, `NFR-019`, `SS-30`, `SS-31`, `SS-32`, `SS-33`, `SS-34`, `SS-35`, `SS-36`, `SS-37`, `SS-38`, `SS-39`, `SS-40`, `SS-41`, `SS-42`, `SS-43`, `SS-44`, `SS-45`, `SS-46` |
| `U-05` | `FR-014`, `FR-015`, `FR-016`, `FR-020`, `FR-021`, `FR-022`, `FR-045`, `NFR-009`, `NFR-010`, `NFR-011`, `NFR-017`, `SS-13`, `SS-14`, `SS-15`, `SS-16` |
| `U-06` | `FR-001`, `FR-003`, `FR-004`, `FR-015`, `FR-017`, `FR-018`, `FR-019`, `FR-034`, `NFR-005`, `NFR-006`, `NFR-007`, `NFR-008`, `NFR-009`, `NFR-010`, `NFR-012`, `NFR-013`, `NFR-015`, `NFR-019`, `SS-01`, `SS-25`, `SS-26`, `SS-27` |
| `U-07` | `FR-030`, `FR-039`, `NFR-006`, `NFR-009`, `NFR-012`, `NFR-019`, `SS-28`, `SS-29` |
| `U-08` | `FR-002`, `FR-003`, `FR-004`, `FR-005`, `FR-006`, `FR-007`, `FR-008`, `FR-009`, `FR-010`, `FR-011`, `FR-012`, `FR-013`, `FR-014`, `FR-015`, `FR-016`, `FR-017`, `FR-018`, `FR-019`, `FR-020`, `FR-021`, `FR-022`, `FR-023`, `FR-024`, `FR-025`, `FR-026`, `FR-027`, `FR-028`, `FR-029`, `FR-030`, `FR-035`, `FR-036`, `FR-045`, `FR-046`, `NFR-001`, `NFR-002`, `NFR-003`, `NFR-004`, `NFR-007`, `NFR-008`, `NFR-009`, `NFR-010`, `NFR-012`, `NFR-014`, `NFR-017`, `SS-01`, `SS-02`, `SS-03`, `SS-04`, `SS-05`, `SS-06`, `SS-07`, `SS-08`, `SS-09`, `SS-10`, `SS-11`, `SS-12`, `SS-13`, `SS-14`, `SS-15`, `SS-16`, `SS-17`, `SS-18`, `SS-19`, `SS-20`, `SS-28`, `SS-29` |
| `U-09` | `FR-031`, `FR-032`, `FR-033`, `FR-034`, `NFR-005`, `NFR-006`, `NFR-007`, `NFR-008`, `NFR-009`, `NFR-010`, `NFR-011`, `NFR-012`, `NFR-013`, `NFR-014`, `NFR-015`, `NFR-016`, `NFR-017`, `NFR-018`, `NFR-019`, `SS-21`, `SS-22`, `SS-23`, `SS-24`, `SS-25`, `SS-26`, `SS-27` |

### Shared Unit Acceptance And Verification

Кожна U-01–U-09 приймається лише після свого Source/Work/Acceptance, актуальних локальних tests, named interface integration і всіх застосовних гейтів. Відсутній real-environment доказ лишається непідтвердженим, а не passed. Власник виконання — runner відповідної unit; gate definitions — DoD, concrete checks — QA. Після зміни contract producer і consumer перевіряються разом; мовчазна сумісність заборонена.

| Unit | Concrete QA IDs / primary та supporting gates |
|---|---|
| U-01 | QA-SS-008, QA-INT-022, QA-SEC-001, QA-EVD-001–QA-EVD-002, QA-LIM-001, QA-LIM-004; G-01/G-14/G-23 |
| U-02 | QA-PA-013–QA-PA-016, QA-SS-012, QA-INT-016, QA-INT-018, QA-REG-009; G-19/G-20 |
| U-03 | QA-PA-015, QA-SS-013, QA-INT-017, QA-REG-009, QA-SEC-001; G-19/G-23 |
| U-04 | QA-PA-012–QA-PA-016, QA-AUTH-001–QA-AUTH-008, QA-JRN-005–QA-JRN-006, QA-SS-011–QA-SS-014, QA-WF-005, QA-UX-006, QA-A11Y-006–QA-A11Y-007, QA-INT-009, QA-INT-013–QA-INT-018, QA-INT-022, QA-DEV-007, QA-EVD-006, QA-REG-008–QA-REG-009; G-18/G-19/G-20/G-23 плюс UI |
| U-05 | QA-PA-003–QA-PA-004, QA-INT-003–QA-INT-006, QA-EVD-003, QA-REG-002, QA-REG-004, QA-SEC-001; G-04/G-06/G-08/G-23 |
| U-06 | QA-PA-006, QA-PA-010, QA-SS-009, QA-INT-001, QA-INT-019–QA-INT-024, QA-DEV-001–QA-DEV-006, QA-LIM-002, QA-REG-010, QA-SEC-001; G-02/G-07/G-12/G-14/G-23 плюс UI |
| U-07 | QA-PA-007, QA-SS-010, QA-INT-009–QA-INT-012, QA-REG-007, QA-SEC-001; G-05/G-17/G-23 |
| U-08 | QA-PA-001–QA-PA-007, QA-PA-011, QA-JRN-001–QA-JRN-004, QA-SS-001–QA-SS-005, QA-WF-001–QA-WF-004, QA-UX-001–QA-UX-005, QA-INT-002–QA-INT-006, QA-REG-001–QA-REG-004; G-03–G-09/G-15 плюс UI |
| U-09 | QA-PA-008–QA-PA-010, QA-SS-006, QA-INT-007–QA-INT-008, QA-REG-005, QA-EVD-001–QA-EVD-006, QA-LIM-001–QA-LIM-004, QA-RR-001; G-10/G-11/G-15/G-23 та агрегування **всіх 134** застосовних QA IDs з current QA Primary Gate Membership, без G-13 |

### Cross-Layer Interface Ownership

| Producer / owner | Consumer | Contract / compatibility | Integration proof |
|---|---|---|---|
| U-01 Node entry/lifecycle | U-04 web, U-06 supervisor, U-07 runtime | architecture routes/config; liveness/auth/transport/consultation readiness окремі; preview isolation | QA-INT-022, QA-DEV-007 |
| U-02 settings domain/catalog | U-03 API, U-04 UI, U-05/U-08 launch | versioned OwnerSettings/capability-map; exact provider model+effort, default omission, immutable snapshot; unsupported version fail-closed | QA-INT-016–QA-INT-018 |
| U-03 MySQL transaction adapter | U-04 owner grants, U-05 registrar | full-object CAS/idempotency, namespace/AEAD isolation; no lock over network; no implicit DDL | QA-INT-017, QA-AUTH-003–QA-AUTH-005 |
| U-04 Google transaction/grant + CSRF | U-01 routing, U-03 protected API, U-07 operations UI | architecture §8 methods/paths, hashed references, separate generation; старий password/audience не accepted fallback | QA-AUTH-001–QA-AUTH-008, QA-JRN-005–QA-JRN-006 |
| U-05 canonical registrar/outbox | U-06 transport, U-08 orchestrator, U-09 archive | confirmed body/order + outbox одна transaction; generation/fence/deterministic txn ID, wake не другий write | QA-INT-003–QA-INT-007, QA-REG-002 |
| U-06 Rust SDK/store + Node supervisor | U-05 ingress/ACK, U-08 invocation flow | versioned private NDJSON, bounded media handles, Matrix receipt != device delivery/read; malformed/unknown version blocked | QA-INT-019–QA-INT-024 |
| U-07 subscription runtime/credential owner | U-02 catalog, U-08 agent runner, U-04 readiness only | one Codex fenced lineage, separate Claude process, no Google secrets/implicit OAuth mutation | QA-INT-009–QA-INT-012, QA-INT-022 |
| U-08 orchestration/policy | U-05 registration, U-06 publication, U-09 result/archive | A2A schema, independent first pass, cancel generation and confirmed body only; no synthetic fallback | QA-JRN-001–QA-JRN-004, QA-INT-002–QA-INT-006 |

### Lifecycle Responsibilities

| Unit owner | Коли / результат | Доказ і умова зупинки |
|---|---|---|
| U-01/U-09 | Перед кожним дозволеним release: pinned dependencies/build, minimal config, preview isolation, runtime health/readiness | QA-INT-019, QA-INT-022, QA-SEC-001; missing immutable builder/provenance блокує promotion |
| U-03/U-05/U-06 | Перед інтеграційним прийманням і після storage/protocol change: restart, crash/replay/CAS, store continuity та exact device restore | QA-INT-017, QA-INT-020–QA-INT-023; corrupt/ambiguous state quarantined, не wipe |
| U-04/U-07 | Після identity/session/provider/config зміни: revoke/reauth/restart та secret isolation | QA-AUTH-001–QA-AUTH-008, QA-REG-007–QA-REG-009; невиконаний компенсувальний контроль закриває доступ |
| U-09 | Перед і після окремо дозволених release/rollback/archive effects: fingerprint, isolated restore, no duplicate order, retention/cost truth | QA-INT-007–QA-INT-008, QA-EVD-001–QA-EVD-006, QA-RR-001; неповний доказ не дозволяє release/cleanup |
| U-09 / Власник | Після реалізації: реальні завдання й outcomes проти JOB/UC, потім після material change або incident | QA-USER-001–QA-USER-003, H1–H10; findings повертаються відповідному SDD owner, не переписують продукт автоматично |

## Dependency Order

Наявні U-01–U-09 частково реалізовані; це не порожній проєкт. Схема залежностей визначає інтеграцію, а не наказ переписати все.

- Settings: U-01 → U-02 → U-03 → U-04.
- Consultation: U-01/U-02/U-03 → U-05; далі U-06 (Matrix) та U-07 (provider preflight) незалежні на цьому seam; U-08 потребує U-05/U-06/U-07; U-09 агрегує U-03–U-08.
- Перший змістовний repair після **нового окремого implementation prompt** — U-04 Google-only разом із необхідними readiness/storage seams U-01/U-03/U-07. Не переходити до іншої unit, доки affected локальні acceptance й явно названі інтеграційні обмеження не перевірені.
- G-00 — окрема підготовка recovery/destructive дій. Наявні code/tests зберігаються; цей план не дає дозволу на credentials, Matrix device/room, OAuth mutation, deploy, DB/legacy cleanup.

## Verification Plan

| Phase | Обов'язковий доказ | Статус зараз |
|---|---|---|
| SDD gate | current hashes, baseline/receipt, security/QA bindings, separate prompt | prepared; checker must pass before code |
| Local Node/TS | `npm run check`, supervisor/outbox/ingress/failure tests | not run for this unit |
| Local Rust | `cargo test --locked`, format/lint, locked/frozen musl build, checksum/SBOM/licenses | not run |
| Final-path safety | binary/store/spool ownership/mode, lock/quarantine, both-root non-retrievability | not run |
| Controlled integration | MySQL crash/replay/order and real Matrix room/device/store restore | local DB not run; Matrix needs JIT |
| UX/security | `G-16`, H1–H10, representative tasks, `QA-SEC-001` | prepared/not_run |
| Release | correlated GoDaddy Published evidence with blockers closed | not_evaluated |

Passing local tests does not establish Matrix delivery, representative usability, security conformance or release readiness. `accepted`, `device_delivered` and `read` require separate evidence.

## Security Coverage

This is the development-plan consequence map for the exact PRD security set. Every item binds to `G-23 product_security_requirements` and `QA-SEC-001`; planning is not execution.

| PRD ID | Implementation consequence |
|---|---|
| `NFR-005` | U-06 Matrix E2EE/device/store continuity; U-09 TLS and MySQL application-layer archive ciphertext/key separation |
| `NFR-006` | U-06 pinned dependency/toolchain/artifact/checksum/SBOM and secret isolation; U-07 OAuth fencing; U-09 leak evidence |
| `NFR-007` | U-06 exact room/owner/bot/homeserver/device authorization on ingress and pre-send/read/action |
| `NFR-008` | U-06 bounded canonical NDJSON/media/process/network boundaries; U-08 instruction/data separation |
| `NFR-009` | U-05/U-06 idempotency, bounds, backpressure, replay, retries and cleanup |
| `NFR-010` | U-05 transactional order/atomic outbox; U-06 lease/fencing/ordered publication/crash reconciliation |
| `NFR-011` | U-05 confirmed-body/order lineage; U-09 archive manifest verified before read/export/restore |
| `NFR-012` | U-06 content-free correlated status/logging; U-07 truthful failures; U-09 evidence/cost reconciliation |
| `NFR-016` | U-04 кожний NFR-016.a–h, Google transaction/identity, local grant/lifecycle/request/rate/exception; QA-AUTH-001–QA-AUTH-008 плюс G-18/G-23, без власної MFA чи нового питання |
| `NFR-017` | U-02/U-03 full-object validation and atomic CAS/idempotency; U-05 immutable snapshot |
| `NFR-019` | U-02 відтворюваний settings/capability mapping; U-01/U-03/U-04/U-06/U-09 secure config/host/routes/egress/Preview; QA-PA-014, QA-PA-016, QA-INT-016, QA-SEC-001 |

Negative/adversarial verification uses `QA-SEC-001`; no security item is advisory or silently not applicable.

## Visual And UX Verification

- Active baseline: `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`.
- Target: `forge/design/candidates/candidate-b/v2/index.html`, SHA-256 `07e3675265e8cadef1e65c132f32e3cbbf4d6537cbfd316ea16a6bacd56f1bd6`.
- Frozen render bundle: `forge/design/candidates/candidate-b/v2`, `sdd-render-sha256-v2`, `57d103c5ed17bcc9a9d95a58718f83c33b8257229fc825b756367321eaa33199`; обидві залежності й історичне обмеження — Baseline Binding нижче.
- `SUR-01` inherits native Element; no browser chat is built.
- `SUR-02` зберігає схвалену палітру/ієрархію; DB-D18 замінює парольний flow на Google, DB-D19 розділяє provider model/effort. DB-D17 лише історичний, не чинна вимога.
- `QA-VIS-001`–`003`, `QA-HEU-001`–`010`, `QA-USER-001`–`003` remain prepared/not_run.

### Baseline Binding

- Candidate `candidate-b/v2`; схвалена дата/фраза лишаються в первинному receipt, нове схвалення не створюється.
- Поточний aggregate включає `forge/design/candidate-sets/whatsapp-consultant/v1/shared/scenario-fixture.js` (`96732f738a41bf1f838736de77a748ef65704d68010553bbf43638f83ddd1af6`) та `forge/design/candidate-sets/matrix-consultant/v2/shared/scenario-fixture.js` (`0f3959792187148a2e1ae842c738644da7ed60ddc01776948f86914b8fb207e6`).
- Current binding receipt: `forge/design/evidence/candidate-b/v2/approval-render-binding-20260905.json`, hash `30d4d7665209f591821ed00bdb551789fb560a4056c50c3aa0ee7a64eade7598`.
- Root-only `4c6f2d51be1baf5962035933deeec7095d31f1d3e6c473ec9e43cb0e3a360744` — компонент історії, не повний render hash. Первинний legacy hash не відтворено; неперервність root bytes від первинного схвалення не доведена. Поточний checker pass не закриває це обмеження.

### Unit Journey And UI Bindings

Кожна unit цього рядка використовує **той самий baseline/target/DB-D18/DB-D19** вище й QA Shared Verification Scope. Неавтентифіковані Google states також належать SUR-02. Backend units лише вмикають user states/data/actions; вони не створюють третій UI.

| Unit | JOB → UC → journey/scope | Visual / H1–H10 / representative task |
|---|---|---|
| U-01 | JOB-003 → UC-003 → S1/S2; SUR-02 SS-30–SS-35 readiness/error; backend enabling | QA-VIS-001–QA-VIS-003, QA-HEU-001–QA-HEU-010 для affected web/recovery, QA-USER-003 у інтеграції U-04 |
| U-02/U-03 | JOB-003 → UC-004 → S3–S5; SUR-02 SS-36–SS-46, SG-02–SG-05; backend enabling | QA-VIS-001–QA-VIS-003, QA-HEU-001–QA-HEU-010, QA-USER-003 у U-04 |
| U-04 | JOB-003 → UC-003/UC-004 → Settings S1–S5; SUR-02 SS-30–SS-46, SG-01–SG-05 | QA-VIS-001–QA-VIS-003, QA-HEU-001–QA-HEU-010, QA-USER-003; QA-RSP-001–QA-RSP-003, QA-A11Y-006–QA-A11Y-007 |
| U-05 | JOB-001/JOB-002 → UC-001/UC-002 → Stages 3–9; SUR-01 SS-08–SS-20, confirmed MG-07; backend enabling | QA-VIS-001–QA-VIS-003, QA-HEU-001–QA-HEU-010, QA-USER-001–QA-USER-002 через U-06/U-08 |
| U-06 | JOB-001/JOB-002/JOB-004 → UC-001/UC-002/UC-005 → Stages 1–10; SUR-01 SS-01–SS-29, MG-01–MG-13 | QA-VIS-001–QA-VIS-003, QA-HEU-001–QA-HEU-010, QA-USER-001–QA-USER-002; QA-A11Y-001–QA-A11Y-005, QA-DEV-001–QA-DEV-006 |
| U-07 | JOB-001/JOB-005 → UC-001/UC-006 → provider preflight/failure/cost availability; SUR-01 SS-28/SS-29; SUR-02 тільки operations readiness | QA-VIS-001–QA-VIS-003, QA-HEU-001–QA-HEU-010 для status/recovery, QA-USER-002 і QA-USER-003 у інтеграції |
| U-08 | JOB-001/JOB-002 → UC-001/UC-002 → direct/consilium Stages 1–9; SUR-01 MG-01–MG-12, SS-01–SS-20 | QA-VIS-001–QA-VIS-003, QA-HEU-001–QA-HEU-010, QA-USER-001–QA-USER-002 |
| U-09 | JOB-004/JOB-005 → UC-005/UC-006 → Stage 10/archive/cost; SUR-01 MG-09/MG-13, SS-21–SS-24 плюс aggregate обох поверхонь | QA-VIS-001–QA-VIS-003, QA-HEU-001–QA-HEU-010, QA-USER-001–QA-USER-003 як release aggregate; export/delete — окремі QA-PA-008/QA-INT-007, не вигаданий user-study pass |

H1–H10 застосовуються до конкретного affected scope, не «автоматично пройдені» на кожній unit. QA визначає критерій успіху, Власник — representative group, timing post-implementation; потрібне фактичне спостереження, не розповідь агента. Кожний failure proof включає причину, збережений стан, наступну дію, retry/undo й ознаку успіху. Для native Matrix дозволена Element/OS variance; для web лише source-backed reflow/scoped overrides, без зміни палітри чи довільної третьої групи controls.

## Prototype Promotion Plan

Only U-04 has bounded presentation reuse:

| Source | Destination | Strategy |
|---|---|---|
| `forge/design/candidates/candidate-b/v2/index.html` | `src/settings/ui/template.ts` | `adapt` |
| `forge/design/candidates/candidate-b/v2/styles.css` | `src/settings/ui/styles.css` | `adapt` |
| `forge/design/candidates/candidate-b/v2/app.js` | `src/settings/ui/controller.ts` | `reimplement` |
| `forge/design/candidates/candidate-b/v2/validate.mjs` | `test/settings-ui.test.ts` | `reimplement` |

- Production base commit: `7d2e944f9500a6c38745ce39b414ffc3b946a37c`.
- Allowed adaptations: прибрати review/scenario fixtures; під'єднати Google/local grant/MySQL; зберегти схвалену presentation основу й DB-D18/DB-D19. Мапа не дозволяє переносити prototype auth або fixtures як production truth.
- Prototype не постачає production auth/session/API/MySQL/CAS/idempotency/capability/CSRF/headers. Частина цих можливостей уже є в production destinations; U-04 доповнює/перевіряє їх, а не вважає prototype їх доказом. Google-only і актуальні deployment/browser докази ще потрібні.
- На 05.09.2026 усі чотири declared destinations уже існують. Остання їх зміна в Git: `31fdf9e51e18174c892265c5f6792c241a0f3aaa` (03.09.2026). `forge/runs` та matching historical promotion receipt відсутні. Це **не доказ виконаної promotion**; G-16 provenance для такого claim не підтверджена. План не реконструює receipt або started_at.
- Старий base commit вище збережений як historical planning reference, не початок нового run. Для наступної явно дозволеної адаптації runner фіксує фактичні current base/start перед будь-якою зміною, actual diff/head/strategies/destination hashes і актуальний plan hash; якщо справжню provenance не встановити, fidelity claim залишається blocked.
- Required QA: QA-VIS-001–QA-VIS-003, QA-WF-005, QA-UX-006, QA-RSP-001–QA-RSP-003, QA-A11Y-006–QA-A11Y-007, QA-HEU-001–QA-HEU-010, QA-USER-003. Наявні незмінні prototype bytes не замінюють actual implementation evidence.
- Receipt if a new promotion starts: `forge/runs/U-04/{run_id}/prototype-promotion.json`.
- U-06 declares no prototype-code reuse.

## Risks And Sequencing

- Highest local risk: delivery outside registrar transaction. U-05 atomic outbox precedes U-06 drain.
- Highest host risk: corrupting/recreating Matrix crypto state. Lock, checksum, quarantine and restore rules precede credentials.
- Highest evidence risk: treating retired probe, local tests or homeserver acceptance as release proof.
- Ризик доступу: компрометація Google або local session за відсутності власної MFA. Виняток PRD визначений; блокують невиконані компенсувальні вимоги, а не повторне погодження того самого рішення.
- Credentials, OAuth, room/device state, Published deployment and destructive cleanup are stop boundaries.

## Out Of Scope

- Third surface, browser chat/dashboard/archive browser, custom Element chrome or product-authored sound.
- API key, PAYG, credits, Fast Mode, automatic paid fallback or arbitrary model input.
- Multi-owner SaaS, public onboarding, parallel active sessions or per-agent Settings.
- Runtime sidecar download/compile, caller-controlled Matrix discovery/URLs/proxy or automatic crypto-store reset.
- Production credentials, Matrix room/device setup, OAuth mutation, deployment, legacy code/secret deletion or DB cleanup under current local permission.

## Open Questions

1. Before real Matrix testing, what exact owner/bot mxids, room ID, homeserver origin and trusted-device policy will be authorized?
2. Google identity-only/no-app-MFA уже визначено. До live перевірки потрібні чинні protected config і separately authorized browser/Google execution; не запитувати повторно вибір auth чи MFA.
3. What final encrypted-store/media-spool paths does GoDaddy Published expose, and do both pass non-retrievability/persistence checks?
4. Which classification governs `Особливо чутливий документ`, and what retention/export applies after `Стоп`/`Нова задача`?
5. Which subscription-fee records and actual GoDaddy/MySQL/Matrix billing/usage sources are authoritative for `Витрати`?

## Handoff

SDD узгоджено з поточним skillset; **awaiting-implementation-prompt**. Наступна реалізація після окремого явного prompt — U-04 Google-only і мінімальні залежні storage/readiness/credential seams. Потім повернутися до незавершених перевірок Rust/Matrix та решти існуючих units за dependency graph, не оголошуючи їх готовими за локальними або статичними доказами.

Потрібний новий prompt прив'язується до поточного development-plan hash і approved baseline; історичний U-06 receipt не придатний. Live Google/Matrix/credentials/deploy та destructive дії мають власні дозволи. Цей запуск не виконував production code, promotion, тести, user sessions чи release.
