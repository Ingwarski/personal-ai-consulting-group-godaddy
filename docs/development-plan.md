# Development Plan

- `status`: Node 22 and Published Rust Matrix persistence/process gate verified; destructive migration recovery remains blocked
- `updated_at`: `2026-09-04`

## Source References

- `docs/prd.md`: `US-001`–`US-029`, `FR-001`–`FR-046`, `NFR-001`–`NFR-019`, `AC-001`–`AC-016`.
- `docs/project-context.md`: §7 Platform Targets, §8 Core Scenarios, §9 MVP Boundaries, §11 Constraints, §13 Risks.
- `docs/canonical-terms.md`: `Власник`, `Сесія`, `Консиліум`, `Підтверджена репліка агента`, `Налаштування власника`, `Моделі`, `Глибина міркування`, `Пресет швидкості`, `Фактичні налаштування сесії`, `Subscription OAuth`, `Реєстратор`, `Канонічний порядок`.
- `docs/guardrails.md`: Source Of Truth Order, Allowed/Forbidden Changes, Design Authority Rules, When To Stop, Verification Rules.
- `docs/user-journey.md`: Stages 1–10, Settings S1–S5, Failure Path, Exit Points.
- `docs/screen-map.md`: `SUR-01`–`SUR-02`, `MG-01`–`MG-13`, `SG-01`–`SG-05`, `SS-01`–`SS-46`.
- `docs/wireframes.md`: conversational sequences A–F, Owner Settings structure and atomic-agent-reply pattern.
- `docs/design-brief.md`: Approved Visual Baseline `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`, immutable target `96b91ba9622f8301809ed10ef661a313006e0c2743712912c624edc36a2ca8eb`.
- `docs/architecture.md`: §§5–20 and §25, especially the all-GoDaddy feasibility, legacy-cleanup, recovery and equivalence boundaries.
- `docs/dod-evals.md`: `G-01`–`G-20`, including active `G-16`.
- `docs/qa-checklist.md`: `QA-PA-*`, `QA-JRN-*`, `QA-SS-*`, `QA-VIS-*`, `QA-INT-*`, `QA-A11Y-*`, `QA-RR-001`.

## All-GoDaddy precondition

The user-selected hosting direction is the existing GoDaddy Node.js app, not a direct Worker deployment. The original checkout required Node.js `>=24`, supplied no Node HTTP `start` contract, and contains Cloudflare Worker/DO/R2-oriented adapters. A Node 22 build/start/`PORT`/health scaffold is verified. On 04.09.2026, a temporary content-free Published Rust Matrix gate proved checksum-pinned static-binary execution, Node child-process control, encrypted SQLite create/reopen, wrong-key rejection, Matrix HTTPS, exclusive locking, HTTP non-retrievability at both candidate roots, and persistence through Published restart and source redeploy. The fixed synthetic store was deleted and the gate was retired after its receipt. This resolves the Matrix host-capability subgate; recovery and destructive-migration gates still must pass before legacy-code cleanup, secret removal, database cleanup or a cutover claim.

`Preview` and `Published` must not be treated as isolated merely because they are variants. A stateful Preview requires provider-proven separate database/schema+credential; otherwise its scope is stateless build/UI verification only. An empty database table list in the dashboard is insufficient proof of legacy-data absence or exclusive ownership.

## Implementation Strategy

1. Complete the GoDaddy legacy-recovery and destructive-manifest gates before any legacy code, secret or database deletion.
2. Continue non-destructive adapter implementation only behind the verified Node 22 process/storage and existing fail-closed database/auth boundaries. The existing Cloudflare units are reference contracts, not deployable work items for the new target.
3. Recreate the canonical registrar, Matrix bridge, Settings access, OAuth fencing and archive only with proven equivalents; no adapter is assumed interchangeable.
4. Promote only the approved Candidate B v2 presentation fragments for `SUR-02`; `SUR-01` remains native Element/Matrix and is not reimplemented as a browser chat.
5. Claims progress from local contract evidence → controlled integration evidence → GoDaddy Published, real-device E2E evidence. A green local suite never substitutes a relevant hard gate.

## Codebase Map

| Current path | Status | Production treatment |
|---|---|---|
| `consilium/live/*` | Historical local preview | Preserve; never import into production runtime or `SUR-02`.
| `scripts/consilium-*.mjs` | Historical chat evidence utilities | Preserve as reference-only; do not use as a production registrar.
| `tests/consilium-chat.test.mjs` | Legacy formatting test | Preserve; add isolated MVP tests under a new runtime test tree.
| `forge/design/candidates/candidate-b/v2/*` | Approved visual evidence | Reuse only selected `SUR-02` presentation via the traced promotion in U-04.
| `forge/design/evidence/candidate-b/v2/*` | Approved visual evidence | Read-only visual target; use for `G-16`, never as runtime proof.
| `src/*`, `test/*`, `wrangler.*`, `package.json` | Existing Cloudflare-oriented partial implementation | Preserve as a reference/rollback source during feasibility; do not assert that it is a GoDaddy Node app or delete it before the legacy retention decision. |

## Implementation Units

### G-00 — All-GoDaddy feasibility and legacy recovery gate

- **Purpose:** establish whether the requested GoDaddy target can satisfy retained V1 invariants and whether legacy HappyPro state can be recovered before any irreversible change.
- **Source References:** architecture §25; PRD `FR-001`–`FR-046`, `NFR-001`–`NFR-019`; DoD `G-01`, `G-02`–`G-20`; QA `QA-RR-001` and all applicable `QA-PA-*`.
- **Depends On:** explicit hosting direction from the Owner; no legacy or provider-data mutation.
- **Work Items:** inventory deployed app/source/variant/database resource metadata without secret values or database payloads; map runtime to database; reconcile historic HappyPro persistence evidence; preserve immutable Git rollback artifact; create encrypted backup and prove an isolated restore; obtain provider evidence for database isolation and outbound policy; define and verify GoDaddy-equivalent registrar, Matrix crypto state, owner-secret Settings, subscription OAuth and encrypted archive. The Node 22 build/start/health contract and the 04.09.2026 content-free Published Rust Matrix process/private-durable-store gate are complete and retired. Real Matrix room/device evidence and all remaining recovery/stateful-equivalence work remain open.
- **Acceptance Checks:** dashboard table absence is never accepted as database-wipe authority; no legacy source/secrets/data are deleted; no stateful Preview is used without independent database/schema+credential; all missing provider guarantees become an explicit blocker rather than an assumption.
- **Verification:** redacted metadata inventory; backup hash and restore/reconciliation result; Node 22 build/start/health receipt; the completed content-free Published Rust Matrix gate receipt; provider capability evidence; architecture review mapping every V1 invariant to a GoDaddy equivalent or a no-go result.
- **Delivery Layer:** feasibility/recovery.
- **Interfaces Produced:** content-free environment inventory, recovery receipt, Rust Matrix capability receipt, and an approved GoDaddy runtime contract or a documented no-go.
- **Interfaces Consumed:** none.
- **Integration Verification:** no destructive action is eligible until the G-00 evidence bundle and action-time destructive manifest are both complete.

### U-01 — Runtime scaffold and contract test boundary

- **Purpose:** establish a small, deterministic TypeScript/Worker module boundary without changing legacy preview code.
- **Source References:** architecture §§5, 7, 20; guardrails Allowed/Forbidden Changes; DoD `G-01`, QA `QA-EVD-001`, `QA-LIM-001`.
- **Depends On:** approved baseline and this plan.
- **Work Items:** create `package.json`, TypeScript configuration, `wrangler` configuration, `src/`, `test/` and an explicit environment-schema module; make forbidden API/PAYG credential names fail validation; create deterministic test commands for the new code only.
- **Acceptance Checks:** no production module imports `consilium/live/*`; no required secret is committed; unknown environment mode fails closed.
- **Verification:** TypeScript check, unit test command, forbidden-env static scan, `git diff --check`.
- **Delivery Layer:** infrastructure.
- **Baseline Impact:** none.
- **Prototype Reuse:** none.

### U-02 — Owner Settings domain core

- **Purpose:** implement the typed settings object, separate Codex/Claude allowlists, shared reasoning-depth compatibility, speed presets, defaults, whole-object validation and immutable session snapshot resolver.
- **Source References:** PRD `FR-039`–`FR-046`, `NFR-017`–`NFR-019`, `AC-013`–`AC-016`; architecture §§9–13; canonical terms `Моделі` through `Фактичні налаштування сесії`; QA `QA-PA-013`–`QA-PA-016`, `QA-INT-016`–`QA-INT-018`.
- **Depends On:** U-01.
- **Work Items:** create `src/settings/schema.ts`, `catalog.ts`, `compatibility.ts`, `defaults.ts`, `snapshot.ts` and focused tests; model catalog is an injected versioned capability receipt, never hardcoded as proof that a subscription runtime supports a model; accept only `low`, `medium`, `high`, `xhigh`; make unsupported/stale/incompatible selections fail closed; make speed affect orchestration policy only.
- **Acceptance Checks:** arbitrary model text cannot parse; `xhigh` with an unsupported model blocks the whole save; no setting enables Fast Mode, API, PAYG, credits or a weakened invariant; a resolved Session snapshot is deeply immutable.
- **Verification:** positive/negative schema matrix; invariant test for each speed preset; snapshot mutation test; catalog-version drift test.
- **Delivery Layer:** backend.
- **Baseline Impact:** user-visible states/data/actions enabled later by U-03/U-04.
- **Prototype Reuse:** none.
- **Interfaces Produced:** `OwnerSettings`, `ModelCapabilityCatalog`, `CapabilityReceipt`, `EffectiveSessionSnapshot`, validation-result union.
- **Interfaces Consumed:** none.
- **API/Data Contract References:** architecture §§9–13; PRD `FR-039`–`FR-046`.
- **Interface Owner:** settings domain.
- **Compatibility Expectations:** all callers submit the complete typed object; no partial patch or implicit default merge at write time.
- **Integration Verification:** U-03 persists and U-06 consumes the same snapshot schema without mutation.

### U-03 — Versioned OwnerSettingsDO and Settings API

- **Purpose:** make stored settings atomic and revisioned behind the specified `GET`, full-object `PUT` and confirmed reset contract.
- **Source References:** architecture §§7–9, 12; PRD `FR-037`–`FR-046`, `AC-012`–`AC-016`; DoD `G-18`–`G-20`; QA `QA-INT-013`–`QA-INT-018`.
- **Depends On:** U-01, U-02.
- **Work Items:** create `src/settings/owner-settings-do.ts`, `src/settings/api.ts` and request/response types; implement revision/ETag, `If-Match`, idempotency-key body hash, explicit reset and an audit record without sensitive values; reject partial patches, wrong content type, stale revision, double submit and idempotency replay with a different body.
- **Acceptance Checks:** every successful save writes exactly one complete revision; failure leaves the prior revision unchanged; reset produces a new revision from complete defaults; read response separates stored/current/default/effective values.
- **Verification:** Durable Object unit/integration test harness; CAS conflict, restart, duplicate key, offline/retry and reset-confirmation API cases; secret-free audit-log scan.
- **Delivery Layer:** backend.
- **Baseline Impact:** user-visible states/data/actions enabled for `SS-34`–`SS-44`.
- **Prototype Reuse:** none.
- **Interfaces Produced:** `GET /api/settings`, `PUT /api/settings`, `POST /api/settings/reset` contract and `SettingsRevision`.
- **Interfaces Consumed:** U-02 schema/catalog/snapshot resolver; U-04 settings client; U-06 session-start resolver.
- **API/Data Contract References:** architecture §7 route table and §12 sequence.
- **Interface Owner:** `OwnerSettingsDO`.
- **Compatibility Expectations:** mutation callers must send full body, `If-Match`, idempotency key and same-origin/CSRF proof; a future session reads a committed revision only.
- **Integration Verification:** U-04 and U-06 use identical revision/snapshot fixtures.

### U-04 — Protected Owner Settings surface

- **Purpose:** implement the single responsive `SUR-02` page and connect it to U-03 without creating a browser chat or credential UI.
- **Source References:** Approved Baseline `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`; PRD `FR-037`–`FR-046`, `AC-012`–`AC-016`; screen map `SG-01`–`SG-05`, `SS-30`–`SS-46`; wireframes Owner Settings; QA `QA-VIS-001`–`QA-VIS-003`, `QA-RSP-*`, `QA-A11Y-006`–`QA-A11Y-007`.
- **Depends On:** U-01, U-02, U-03.
- **Work Items:** create `src/settings/ui/*` and protected Worker asset route; render identity/access status, current/default/effective values, exactly three groups, compatibility, one atomic save action, reset confirmation and active-session notice; preserve keyboard focus and safe failure/denied states; do not render Google sign-in, provider OAuth, Fast Mode, credits, sound, motion or live agent status.
- **Acceptance Checks:** all controls are typed and labelled; save stays disabled for invalid whole set; save/reset result is whole-set only; 390–1440px works without horizontal loss; active session stays read-only in explanation and runtime semantics.
- **Verification:** `G-16` with baseline-bound captures; DOM/control inventory; keyboard/focus, 200% zoom, 390/430/768/1280/1440 responsive checks; U-03 contract integration tests; no-protected-render case on denied access.
- **Delivery Layer:** full-stack.
- **Approved Baseline ID:** `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`.
- **Immutable Visual Target Hash:** `96b91ba9622f8301809ed10ef661a313006e0c2743712912c624edc36a2ca8eb`.
- **Baseline Screens States And Viewports:** `SUR-02`, `SG-01`–`SG-05`, `SS-30`–`SS-46`, 390/430/768/1280/1440px.
- **Design Contract And Permitted Variance:** one-page settings hierarchy, HappyPro palette, no product sound/motion, system font and responsive reflow; only source-recorded native/access platform variance is permitted.
- **Operator Visual Overrides:** `SUR-02` HappyPro palette; no product-authored notification sound.
- **Visual Fidelity Verification:** `approved_visual_baseline_fidelity`.
- **Prototype Reuse:** traced promote/diff.
- **Prototype Source Root And Tree Hash:** `forge/design/candidates/candidate-b/v2`; `96b91ba9622f8301809ed10ef661a313006e0c2743712912c624edc36a2ca8eb`.
- **Prototype To Production Path Map:** `index.html` → `src/settings/ui/template.ts` (`adapt`); `styles.css` → `src/settings/ui/styles.css` (`adapt`); `app.js` → `src/settings/ui/controller.ts` (`reimplement`); `validate.mjs` → `test/settings-ui-baseline.test.ts` (`reimplement`).
- **Production Base Commit:** `1d879b8d2dc808fd2fa3da451b21b992f7f6a242`.
- **Allowed Prototype Adaptations:** remove review toolbar, scenario switcher and fixtures; replace simulated state with U-03 contract data; add Access-denied boundary and production CSP; retain only approved `SUR-02` hierarchy/tokens/interaction meaning.
- **Required PrototypePromotionReceipt:** `forge/runs/U-04/{run_id}/prototype-promotion.json`.
- **Production Capabilities Added Beyond Prototype:** Access/JWT gateway, real API, persistence/CAS/idempotency, catalog receipt, CSRF, deployment headers and evidence correlation.
- **Interfaces Produced:** Settings document shell and typed client actions.
- **Interfaces Consumed:** U-03 API contract and Access identity context.
- **API/Data Contract References:** architecture §7 and §12.
- **Interface Owner:** settings UI.
- **Compatibility Expectations:** only protected `SUR-02` consumes this UI; no Matrix transcript or provider credential enters the browser.
- **Integration Verification:** deployed Access + Worker test in U-09.

### U-05 — Canonical session registrar

- **Purpose:** implement one durable owner of session generation, idempotency, canonical order and immutable confirmed agent messages before Matrix/provider integration.
- **Source References:** PRD `FR-007`, `FR-011`–`FR-024`, `NFR-001`–`NFR-004`, `NFR-009`–`NFR-011`; architecture §§5–6, 13–14; wireframes Atomic agent-reply pattern; DoD `G-04`, `G-06`, `G-08`.
- **Depends On:** U-01, U-02.
- **Work Items:** create `src/session/registrar-do.ts`, session state machine, append-only confirmed-message ledger, generation/lease and cancellation model; store role, visible `HH:MM`, formatted body and content hash; keep technical IDs only internal.
- **Acceptance Checks:** duplicate input is idempotent; late outputs after `Стоп`/new generation cannot publish; a confirmed message cannot be changed, collapsed or reordered; session snapshot is fixed when the session starts.
- **Verification:** deterministic clock/order tests; duplicate/retry/late-callback/cancel/new-task matrix; body-hash and canonical-order comparison.
- **Delivery Layer:** backend.
- **Baseline Impact:** user-visible states/data/actions enabled for `MG-04`–`MG-12`, `SS-08`–`SS-20`.
- **Prototype Reuse:** none.
- **Interfaces Produced:** `SessionIntent`, `SessionGeneration`, `ConfirmedAgentMessage`, registrar append/result events.
- **Interfaces Consumed:** U-02 effective snapshot; U-06 Matrix ingress and U-08 agent events.
- **API/Data Contract References:** architecture §§6, 13–14; `MG-07`/`MG-10`/`MG-12`.
- **Interface Owner:** `RegistrarDO`.
- **Compatibility Expectations:** one and only one registrar authorizes visible order; all adapters are append-only clients.
- **Integration Verification:** U-06 and U-08 correlate adapter evidence to registrar sequence/body hashes.

### U-06 — Matrix bridge and private-room ingress

- **Purpose:** attach one `matrix.org` bot to the registrar, enforce the room/device invariant and deliver confirmed messages into the same private E2EE room.
- **Source References:** PRD `FR-001`–`FR-006`, `FR-014`–`FR-019`, `FR-034`; architecture §§4–6, 16–17; DoD `G-02`, `G-03`, `G-12`, `G-14`; QA `QA-PA-005`–`QA-PA-006`, `QA-DEV-001`–`QA-DEV-006`.
- **Depends On:** U-01, U-05; hosted-provider authorization is required only immediately before deploy/test.
- **Work Items:** create `src/matrix/bridge.ts`, a Node supervisor that launches one checksum-pinned static Rust `matrix-sdk` sidecar through bounded private NDJSON stdio, room-invariant validator, consent/intake policy projection and Matrix-event formatter; use the sidecar's persistent encrypted bot crypto store; map native replies to registrar relation records; distinguish provider acceptance from device delivery. Rebuild the sidecar source and CI artifact as production work rather than reusing the retired feasibility probe.
- **Acceptance Checks:** incorrect room, identity or device starts no session and reads no protected data; secret content stops before dispatch/storage; visible role/time/body comes only after registrar confirmation.
- **Verification:** checksum/NDJSON/timeout/lock negative tests and sanitized adapter fixtures; controlled `matrix.org` room/device E2E only after separate just-in-time authorization configures the owner account and bot; four-client Matrix evidence required before release claim. The 04.09.2026 Published gate is host-feasibility evidence only, not product-integration completion.
- **Delivery Layer:** integration.
- **Baseline Impact:** user-visible states/data/actions enabled for `SUR-01`, `MG-01`–`MG-13`, `SS-01`–`SS-29`.
- **Prototype Reuse:** none.
- **Interfaces Produced:** validated `MatrixIngressEvent`, delivery receipt and reply-relation adapter.
- **Interfaces Consumed:** U-05 registrar messages; U-08 progress/final outputs.
- **API/Data Contract References:** Matrix Client-Server adapter contract; architecture §6.
- **Interface Owner:** `MatrixBridgeContainer`.
- **Compatibility Expectations:** no custom browser chat; Element/OS owns native notifications and sound.
- **Integration Verification:** device-visible role/time/body/order comparison against registrar ledger.

### U-07 — Subscription OAuth fencing and provider preflight

- **Purpose:** implement codified fail-closed verification of one Codex OAuth lineage and one separate Claude Code subscription-OAuth critic runtime, without API/PAYG fallback.
- **Source References:** PRD §3.5, `FR-009`–`FR-010`, `FR-028`–`FR-030`, `NFR-006`, `NFR-012`; architecture §§6, 10–11, 16–20; DoD `G-17`; QA `QA-PA-007`, `QA-INT-009`–`QA-INT-012`.
- **Depends On:** U-01, U-02, U-05; user authorization is required immediately before creating or configuring real OAuth/checkpoint secrets.
- **Work Items:** create provider adapter interfaces, content-free preflight result, Codex credential-writer fence/checkpoint seam and Claude auth-status seam; reject forbidden environment variables/routes and unavailable/private-ineligible/quota-failed state before agent launch; map success to invisible `SS-28` and failure to safe `SS-29`.
- **Acceptance Checks:** no API key/PAYG/credit route can activate; failure makes no dependent call; no token, setup-token, URL/code or auth state reaches Matrix, prompts, logs or archive.
- **Verification:** mocked auth/quota/eligibility negative matrix and env scan locally; real subscription-runtime validation only after explicit OAuth-secret configuration authorization.
- **Delivery Layer:** integration.
- **Baseline Impact:** user-visible states/data/actions enabled for invisible `SS-28` and safe `SS-29`.
- **Prototype Reuse:** none.
- **Interfaces Produced:** `ProviderPreflightResult`, credential-fence metadata and safe failure category.
- **Interfaces Consumed:** U-02 catalog; U-05 session launch; U-08 runtime adapter.
- **API/Data Contract References:** architecture §§10–13 and `MG-11`.
- **Interface Owner:** provider preflight boundary.
- **Compatibility Expectations:** subscription OAuth remains isolated from Google Access; a provider’s current capability receipt overrides design mockup catalog labels.
- **Integration Verification:** U-08 cannot route a turn without a fresh successful preflight.

### U-08 — Real consilium runtime, A2A and critical path

- **Purpose:** run one head plus 2–5 separate Codex contexts and one Claude Code critic through registered A2A envelopes, then publish their full confirmed messages and synthesis via the registrar.
- **Source References:** PRD `FR-008`–`FR-019`, `FR-023`–`FR-030`, `AC-001`–`AC-004`, `AC-007`, `AC-011`; architecture §§6, 13, 17; DoD `G-05`–`G-09`; QA `QA-JRN-001`–`QA-JRN-004`.
- **Depends On:** U-05, U-06, U-07.
- **Work Items:** create `src/consilium/router.ts`, `roster.ts`, A2A registration/envelope validator, Codex-thread adapter, Claude critic adapter and result synthesizer; select the smallest sufficient mode; start independent first passes; require critic feedback before final series; publish all confirmed agent messages complete and in real time through U-06.
- **Acceptance Checks:** role labels cannot stand in for a real context; every active agent is registered before route; critic cannot be silently removed by a speed preset; final recommendation has decision, up to three actions, risk/assumption/review condition and Technical part only when needed.
- **Verification:** deterministic fake-adapter tests for routing/order/cancel/timeout; real controlled subscription and Matrix E2E after U-07 authorization; content calibration review.
- **Delivery Layer:** full-stack.
- **Approved Baseline ID:** `PC-MATRIX-CANDIDATE-B-V2-20260816-R1`.
- **Immutable Visual Target Hash:** `96b91ba9622f8301809ed10ef661a313006e0c2743712912c624edc36a2ca8eb`.
- **Baseline Screens States And Viewports:** `SUR-01`, `MG-04`–`MG-12`, `SS-08`–`SS-20`, native Element clients.
- **Design Contract And Permitted Variance:** native Matrix chat only; full body, canonical order and `Роль · HH:MM` are immutable; Element/OS own chrome, sound and notifications.
- **Operator Visual Overrides:** no product-authored sound.
- **Visual Fidelity Verification:** `approved_visual_baseline_fidelity`.
- **Prototype Reuse:** none.
- **Interfaces Produced:** registrar-approved consilium messages, roster/progress/final event contracts.
- **Interfaces Consumed:** U-05 registrar, U-06 Matrix bridge, U-07 preflight.
- **API/Data Contract References:** architecture §13; `MG-06`–`MG-12`.
- **Interface Owner:** Agent runtime + registrar boundary.
- **Compatibility Expectations:** no raw tool logs, hidden reasoning, technical IDs or edited agent body reaches the Owner.
- **Integration Verification:** A2A registration → real context → registrar append → Element delivery correlation.

### U-09 — Archive, costs, deployed security and release evidence

- **Purpose:** complete the remaining high-risk release path: encrypted archive/export/delete, truthful costs, Cloudflare Access deployment, native-device matrix and evidence bundles.
- **Source References:** PRD `FR-031`–`FR-038`, `FR-033`, `AC-008`–`AC-010`, `AC-012`; architecture §§7–8, 14–20; DoD `G-10`–`G-20`; QA `QA-PA-008`–`QA-PA-010`, `QA-DEV-*`, `QA-EVD-*`, `QA-RR-001`.
- **Depends On:** U-03 through U-08; user authorization is required before any real Cloudflare/hosted-Matrix/OAuth secret/deployment or destructive archive test.
- **Work Items:** implement AEAD archive bundle/manifest, export and whole-session delete confirmation; cost ledger with configured subscriptions, actual infrastructure and provider status only; configure and verify Cloudflare Access exact Google email plus origin JWT; collect evidence through the result schema on Mac, iPhone, Samsung Flip7 and Windows.
- **Acceptance Checks:** archive is immutable and application-encrypted; individual reply edit/delete is impossible; costs never invent a per-session token amount; all protected assets/API reject bypass paths; release bundle links every AC and hard gate to exact environment evidence.
- **Verification:** deployed controlled E2E, device captures, export/body-order comparison, delete/recovery testing, security header/JWT matrix and cost-source reconciliation.
- **Delivery Layer:** integration.
- **Baseline Impact:** all user-visible deployment claims across `SUR-01` and `SUR-02`.
- **Prototype Reuse:** none.
- **Interfaces Produced:** `ArchiveManifest`, export/delete receipts, cost response and release evidence bundle.
- **Interfaces Consumed:** U-03, U-05, U-06, U-08.
- **API/Data Contract References:** architecture §§14–20; `MG-09`, `MG-13`.
- **Interface Owner:** archive/cost/deployment boundaries.
- **Compatibility Expectations:** all evidence is content-free except the minimum transcript comparison required; no secret or user document leaves its permitted boundary.
- **Integration Verification:** `G-10`–`G-20` and `AC-001`–`AC-016` on one deployed lineage.

## Dependency Order

`U-01 → U-02 → U-03 → U-04` yields the first locally testable user-facing vertical slice.

`U-01 + U-02 → U-05 → U-06 → U-07 → U-08 → U-09` yields the native Element/Matrix consultation path and release evidence.

U-04 can proceed in parallel with U-05 after U-03 completes. U-06, U-07 and U-09 each stop at their external-configuration boundary until the necessary just-in-time authorization is given.

## Verification Plan

| Phase | Required proof | Source contract |
|---|---|---|
| Local domain | Typecheck, deterministic unit/integration tests, no-secret/forbidden-env scan, full-object/CAS/snapshot tests | `G-01`, `G-17`–`G-20` |
| Local presentation | `G-16` baseline comparison, responsive/keyboard/zoom tests for affected `SUR-02` states | `QA-VIS-*`, `QA-RSP-*`, `QA-A11Y-006`–`QA-A11Y-007` |
| Controlled integrations | Matrix room/device, Access/JWT, OAuth preflight, A2A/registrar and archive tests with content-free evidence | `G-02`–`G-14`, `G-17`–`G-20` |
| Release candidate | One correlated deployed evidence bundle for `AC-001`–`AC-016` on required clients | `G-15`, `QA-EVD-005`, `QA-RR-001` |

## Visual And UX Verification

Every user-visible implementation unit must carry the active Baseline ID and immutable target hash. `SUR-01` is verified against native Element content choreography rather than a custom webpage. `SUR-02` is compared against the approved Candidate B v2 hierarchy and HappyPro palette at 390, 430, 768, 1280 and 1440px; any material deviation needs a source-backed operator override or a new baseline.

## Prototype Promotion Plan

Only U-04 may reuse design prototype material. Its frozen source root, tree hash, path map, permitted adaptations, production base commit and receipt path are fixed in U-04. The implementation runner records actual source/destination hashes, the Git diff, adaptations, visual evidence and verification status in `forge/runs/U-04/{run_id}/prototype-promotion.json`. No simulation code, Matrix browser-chat frame, scenario switcher or review toolbar may be promoted.

## Risks And Sequencing Notes

- The oldest risk is falsely treating a local preview as Matrix, OAuth or Cloudflare evidence. U-01–U-05 therefore make no deployment claim.
- The model names in Candidate B v2 are visual labels only. U-02/U-07 must accept a model only from a current subscription-runtime capability receipt.
- `matrix.org` account/room configuration, Cloudflare configuration, OAuth setup tokens/checkpoints and destructive archive testing are external effects. They are sequenced after local contracts and require explicit authorization at the moment of configuration.
- The unresolved sensitive-document, stopped-session archive and provider-cost feed policies remain release blockers for only their respective paths; they do not block U-01–U-05.

## Out Of Scope

- A third product surface, browser chat, dashboard, archive browser, custom Element chrome or product-authored sound.
- API key, PAYG, credit, Fast Mode or cloud-provider auth fallback.
- Multi-owner SaaS, public onboarding, arbitrary model input, per-agent settings or parallel active sessions.
- OAuth secret creation, Cloudflare deployment, `matrix.org` account/room setup or destructive data action without just-in-time authorization. Matrix provider purchase is out of scope for V1.

## Open Questions

1. Before release, is the `matrix.org` free plan still available and do the live bot, room/device invariant, retention and reliability checks pass?
2. Which exact supported provider capability receipt exposes model/effort availability for the user’s subscription runtime at deployment time?
3. Which versioned classification defines `Особливо чутливий документ`?
4. What retention/export treatment applies after `Стоп` and `Нова задача`?
5. Which configured subscription-fee records and actual Cloudflare/Matrix/R2 billing sources are authoritative for `Витрати`?
