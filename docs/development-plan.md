# План розробки

- `status`: `validated`; локальна реалізація `U-06` дозволена окремим user prompt, зовнішні credentials/deploy і destructive cleanup не дозволені
- `definition_status`: `prepared`
- `execution_status`: `not_run`
- `release_readiness`: `not_evaluated`
- `updated_at`: `2026-09-04`
- `owner_invocation_id`: `990d3f67-1e4a-460d-8722-0292ddf2570b`
- `working_language`: `uk`
- Approved Visual Baseline: `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`

Цей артефакт визначає послідовність і межі реалізації. Він не стверджує, що описані QA-перевірки, security review, representative-user sessions, real Matrix integration або release evaluation уже виконані.

## Source References

| Джерело | SHA-256 | Спожите рішення |
|---|---|---|
| `docs/product-idea.md` | `ecc16d6b81c0019f462947b52c013b96636577bd3a14503638102004c7058c8a` | приватний Element/Matrix, GoDaddy Node, локальні Settings, subscription OAuth |
| `docs/prd.md` | `32d42a752cae06c4a5dd09a9fce408b537ae06cf6c8fd2fceb7e40773b0c3b94` | `US-001`–`US-029`, `FR-001`–`FR-046`, `NFR-001`–`NFR-019`, `AC-001`–`AC-016` |
| `docs/project-context.md` | `1b1268b1055984b5c142740196d3473a3c68518b47db7e1a1645fd8684e3ed15` | GoDaddy/MySQL boundary, дві поверхні, приватний single-owner scope |
| `docs/canonical-terms.md` | `e94b5540ac769b72fa454d364fcd708cbfa4b2a7d6fd19a3ed0a184fc4f253da` | канонічні ролі, стани, команди, outbox, liveness/readiness |
| `docs/guardrails.md` | `4705073ab9e4ccefb3ebc9abd48762fe549f7d529def86aa70f2ad5bf092fa48` | source authority, permission boundaries, evidence discipline |
| `docs/user-journey.md` | `dda85ac0e9a82152aa0c7b121c624341e2628381fa8d1aff2ffe7fe4b85b0e77` | Element Stages 1–10, Settings S1–S5, recovery та exits |
| `docs/screen-map.md` | `385708ad8bff541db37d265297d458c5c473a0053f0051cc2d908342bddacd52` | `SUR-01`–`SUR-02`, `MG-01`–`MG-13`, `SG-01`–`SG-05`, `SS-01`–`SS-46` |
| `docs/wireframes.md` | `49fc8ede68901b6e9be1548a162c13177c1a245bc19bf6f3bb73fe8dfc8324ca` | Matrix sequences, Settings hierarchy, atomic reply pattern |
| `docs/design-brief.md` | `719a32b4ea4fef9f9eaa0ee08864f00fa57f9637be530e67c404d58d1c2e5608` | approved Candidate B v2 та scoped `DB-D17` auth override |
| `docs/architecture.md` | `96366beeb83c11336b6466618115af51cb8190a05afec03fe0ad697adc89929e` | GoDaddy supervisor, MySQL, Rust sidecar, private NDJSON, security boundaries |
| `docs/dod-evals.md` | `135dc8038171a95d4dc84796c2c0d58c8fc886c73ded6d6b9c881b53da1e0fc5` | `G-01`–`G-23`, prepared/not-run semantics |
| `docs/qa-checklist.md` | `6dcd97be6b137dedc75f13b6c7dd37f6716ef95fe7c67dc5989233783d8b8006` | concrete QA IDs, H1–H10, representative tasks, `QA-SEC-001` |

## Implementation Strategy

1. Production target is the existing GoDaddy Node 22 application. Legacy Cloudflare adapters remain reference/rollback code only; they are not a runtime dependency or deployment target.
2. Keep Preview stateless. It receives no production database, Matrix store, OAuth or owner-session credentials and cannot read or mutate Published state.
3. Preserve one MySQL-backed canonical registrar. A confirmed agent message and its ordered Matrix outbox record are created in the same transaction; Matrix delivery never defines canonical order.
4. Run Matrix E2EE in one checksum-pinned Rust sidecar. Node owns HTTP, policy, MySQL, provider orchestration and supervision; the sidecar owns only Matrix SDK/session/crypto/store/media transport.
5. Complete local deterministic implementation before any credential, real room/device or deployment action. Those effects require separate just-in-time authorization.
6. Treat the 04.09.2026 Published Rust probe only as host feasibility, not proof of final sidecar, final paths, real Matrix integration or release readiness.
7. Keep destructive legacy code/secret/database cleanup behind `G-00`: exact inventory, backup, isolated restore/reconciliation, rollback and action-time confirmation.

## Codebase Map

| Шлях | Поточна роль | Планова дія |
|---|---|---|
| `src/godaddy/server.mjs` | GoDaddy Node HTTP entrypoint | wire liveness and content-free Matrix readiness after supervisor completion |
| `src/godaddy/mysql-storage.ts` | transactional MySQL key/value adapter | reuse for registrar/outbox atomicity; no second state authority |
| `src/session/registrar-do.ts` | registrar domain | add transaction-local publication projection without binding domain logic to Matrix |
| `src/matrix/*` | policy/formatting reference | revalidate ingress/send policy; consume durable outbox instead of direct publish |
| `src/godaddy/settings-runtime.ts` | owner-password/session/MySQL Settings runtime | retain as `SUR-02`, isolated from provider OAuth |
| `src/cloudflare/*`, `src/worker.ts`, `wrangler.*` | legacy reference/rollback | never import from GoDaddy production entrypoint; cleanup only through `G-00` |
| `native/matrix-sidecar/**` | absent | create production Rust workspace and committed lockfile |
| `.github/workflows/matrix-sidecar.yml` | absent | create reproducible artifact/SBOM/checksum pipeline |
| `forge/design/candidates/candidate-b/v2/**` | frozen design evidence | never mutate; only bounded U-04 mapping applies |

## Implementation Units

### G-00 — GoDaddy recovery and destructive-cleanup gate

- **Purpose:** protect recoverable legacy code, secrets and database state before irreversible cutover or cleanup.
- **Depends On:** exact provider resource inventory and action-time Owner confirmation.
- **Work Items:** inventory exact app/variant/database/path mappings without secret values; preserve immutable Git rollback; create encrypted backup; prove isolated restore and ownership reconciliation; create exact destructive manifest; recheck immediately before action.
- **Acceptance Checks:** dashboard emptiness is not proof; no shared database/table/credential is deleted; rollback and restore evidence identify exact targets; ambiguity blocks action.
- **Verification:** provider metadata, backup hash, isolated restore record, resource-specific destructive manifest and final confirmation receipt.
- **Status:** Published Node/Rust feasibility subgate is complete and retired; recovery/destructive cleanup remains blocked and does not block local non-destructive U-06.

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

### U-04 — Local owner-password Settings surface

- **Purpose:** deliver `SUR-02` without Google OAuth or provider-auth coupling.
- **Depends On:** U-01, U-02, U-03.
- **Work Items:** keep fresh same-origin challenge, constant-time high-entropy password verification, signed bounded owner session, secure cookie/origin/CSRF/no-store controls, throttling/rotation/idle and absolute expiry/logout; render current/default/effective values and atomic save/reset.
- **Acceptance Checks:** missing/wrong/weak/truncated password, replayed/expired/cross-origin challenge and forged/expired session return no protected bytes; active session remains unchanged; no credential/provider OAuth UI appears.
- **Verification:** `QA-PA-012`–`QA-PA-016`, `QA-INT-013`–`QA-INT-018`, `QA-USER-003`, applicable `QA-HEU-*`, accessibility/responsive and `G-16`.
- **Delivery Layer:** full-stack.
- **Approved Baseline / Target:** `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`; `07e3675265e8cadef1e65c132f32e3cbbf4d6537cbfd316ea16a6bacd56f1bd6`.
- **Prototype Root / Tree / Algorithm:** `forge/design/candidates/candidate-b/v2`; `4c6f2d51be1baf5962035933deeec7095d31f1d3e6c473ec9e43cb0e3a360744`; `sdd-tree-sha256-v1`.
- **Scope:** `SUR-02`, `SG-01`–`SG-05`, `SS-30`–`SS-46`; 390/430/768/1280/1440px.
- **Permitted Variance:** responsive reflow and `DB-D17` local owner-password semantics only; preserve hierarchy, palette and no product-authored sound/motion.
- **Gates:** approved visual fidelity, H1–H10 where applicable, representative task `QA-USER-003`.
- **Security Blocker:** ASVS `v5.0.0-6.3.3` needs residual-risk disposition or authorized compatible second factor before release.

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
  1. Create `native/matrix-sidecar/` with Rust `1.93`, exact `matrix-sdk = "=0.18.0"`, `e2e-encryption`, `bundled-sqlite` and committed `Cargo.lock`.
  2. Add locked/frozen `x86_64-unknown-linux-musl` CI build, checksum manifest, SBOM and license inventory.
  3. Hold one process-lifetime exclusive lock for one encrypted SQLite crypto store; quarantine missing/corrupt/wrong-passphrase/device-mismatch state without automatic logout/delete/reset.
  4. Implement Node supervisor verification of checksum, regular file, owner/mode, version/protocol; enforce hello/ready timeout, bounded 256-KiB UTF-8 NDJSON, strict schema/version/type/ID, queue bounds, backpressure and timeouts.
  5. Separate `/healthz` Node liveness from content-free Matrix readiness; Matrix-not-ready blocks new Matrix work without marking HTTP dead.
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
- **Acceptance Checks:** failure makes no dependent call; credentials/auth URLs/codes never reach Matrix, prompts, logs or archive; no Google Access dependency exists.
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
- **Work Items:** store only application-encrypted archive ciphertext in MySQL with external key lifecycle and integrity manifest; implement full export and double-confirmed whole-session deletion; reconcile subscription fees with actual GoDaddy/MySQL/Matrix data and provider status; verify owner-auth bypass/throttle/expiry/rotation/logout, host/origin/headers and Preview isolation; collect deployment/binary/path/readiness and device evidence.
- **Acceptance Checks:** no plaintext archive or individual reply mutation/deletion; unavailable cost is `невідомо`; release evidence binds exact commit, Published app, DB, binary checksum, paths, Matrix room/devices and all gates.
- **Verification:** `G-10`–`G-23`, `QA-RR-001`, archive restore/tamper/export/delete, GoDaddy security and real-device tests after authorization.
- **Delivery Layer:** integration.

## Dependency Order

`U-01 → U-02 → U-03 → U-04` is the Settings slice already present locally and subject to remaining security/release evidence.

`U-01 + U-02 + U-03 → U-05 → U-06 → U-07 → U-08 → U-09` is the native consultation path. The next permitted work is local, non-destructive `U-05/U-06`. Matrix credentials/room/device, OAuth mutation, deployment and cleanup are excluded.

`G-00` runs independently as recovery/destructive-action preparation. It cannot replace U-06 integration, and its unresolved destructive portion does not block local U-06 code/tests.

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
| `NFR-016` | U-04 password/challenge/session/throttle/rotation/expiry/logout/origin/CSRF/no-store; MFA blocker retained |
| `NFR-017` | U-02/U-03 full-object validation and atomic CAS/idempotency; U-05 immutable snapshot |
| `NFR-019` | U-01/U-03/U-04/U-06/U-09 fail-closed config, minimal host/routes, fixed egress, stateless Preview |

Negative/adversarial verification uses `QA-SEC-001`; no security item is advisory or silently not applicable.

## Visual And UX Verification

- Active baseline: `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`.
- Target: `forge/design/candidates/candidate-b/v2/index.html`, SHA-256 `07e3675265e8cadef1e65c132f32e3cbbf4d6537cbfd316ea16a6bacd56f1bd6`.
- Frozen root/tree: `forge/design/candidates/candidate-b/v2`, `sdd-tree-sha256-v1`, `4c6f2d51be1baf5962035933deeec7095d31f1d3e6c473ec9e43cb0e3a360744`.
- `SUR-01` inherits native Element; no browser chat is built.
- `SUR-02` preserves approved hierarchy/palette; `DB-D17` changes only historical Google/Cloudflare auth semantics to local owner-password/session.
- `QA-VIS-001`–`003`, `QA-HEU-001`–`010`, `QA-USER-001`–`003` remain prepared/not_run.

## Prototype Promotion Plan

Only U-04 has bounded presentation reuse:

| Source | Destination | Strategy |
|---|---|---|
| `forge/design/candidates/candidate-b/v2/index.html` | `src/settings/ui/template.ts` | `adapt` |
| `forge/design/candidates/candidate-b/v2/styles.css` | `src/settings/ui/styles.css` | `adapt` |
| `forge/design/candidates/candidate-b/v2/app.js` | `src/settings/ui/controller.ts` | `reimplement` |
| `forge/design/candidates/candidate-b/v2/validate.mjs` | `test/settings-ui.test.ts` | `reimplement` |

- Production base commit: `7d2e944f9500a6c38745ce39b414ffc3b946a37c`.
- Allowed adaptations: remove review/scenario fixtures; connect local auth/MySQL; retain hierarchy, palette and interaction meaning.
- Missing capabilities: auth/session, API, MySQL/CAS/idempotency, capability receipt, CSRF/headers and deployment evidence.
- Receipt if a new promotion starts: `forge/runs/U-04/{run_id}/prototype-promotion.json`.
- U-06 declares no prototype-code reuse.

## Risks And Sequencing

- Highest local risk: delivery outside registrar transaction. U-05 atomic outbox precedes U-06 drain.
- Highest host risk: corrupting/recreating Matrix crypto state. Lock, checksum, quarantine and restore rules precede credentials.
- Highest evidence risk: treating retired probe, local tests or homeserver acceptance as release proof.
- Highest access residual: ASVS `v5.0.0-6.3.3`; it blocks release until disposition or compatible second factor.
- Credentials, OAuth, room/device state, Published deployment and destructive cleanup are stop boundaries.

## Out Of Scope

- Third surface, browser chat/dashboard/archive browser, custom Element chrome or product-authored sound.
- API key, PAYG, credits, Fast Mode, automatic paid fallback or arbitrary model input.
- Multi-owner SaaS, public onboarding, parallel active sessions or per-agent Settings.
- Runtime sidecar download/compile, caller-controlled Matrix discovery/URLs/proxy or automatic crypto-store reset.
- Production credentials, Matrix room/device setup, OAuth mutation, deployment, legacy code/secret deletion or DB cleanup under current local permission.

## Open Questions

1. Before real Matrix testing, what exact owner/bot mxids, room ID, homeserver origin and trusted-device policy will be authorized?
2. Will ASVS `v5.0.0-6.3.3` use an authorized second factor or documented residual-risk disposition?
3. What final encrypted-store/media-spool paths does GoDaddy Published expose, and do both pass non-retrievability/persistence checks?
4. Which classification governs `Особливо чутливий документ`, and what retention/export applies after `Стоп`/`Нова задача`?
5. Which subscription-fee records and actual GoDaddy/MySQL/Matrix billing/usage sources are authoritative for `Витрати`?

## Handoff

Next is local `U-05/U-06`: atomic registrar/outbox production, then Rust sidecar and Node supervisor integration. Definitions are prepared and unexecuted. The separate user implementation prompt authorizes only this local work; external/destructive actions remain gated.
