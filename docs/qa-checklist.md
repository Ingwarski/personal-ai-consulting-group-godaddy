# QA Checklist

- Продукт: `Personal Consultant`
- Фаза: V1, pre-prototype proposed phase
- Статус артефакту: proposed pre-approval checklist
- Дата: 15.08.2026
- owner_invocation_id: `17b27b2a-8a7c-49d6-ad2f-57e0d4fbe0c8`
- Proposed design contract: `docs/design-brief.md` SHA-256 `1840c78c92d6ef665528602b70dc854d4e59e05180753c613af2671ed2a29ba4`
- Approved Visual Baseline: не існує в поточній фазі; Baseline ID та immutable visual target hash не присвоєно
- Regeneration rule: після whole-design approval цей файл потрібно регенерувати проти active Baseline ID, immutable target hash, затверджених artifacts, states, viewports, permitted variance та operator overrides до продовження development planning або release evaluation

Цей чекліст визначає конкретні QA-перевірки та потрібні evidence-артефакти. Він не змінює продуктову поведінку, design contract, архітектуру або гейти Definition of Done. Статуси гейтів, schema eval result і правила агрегування належать `docs/dod-evals.md`; політика доказів і межі дозволів — `docs/guardrails.md`.

## Source References

| Джерело | SHA-256 / статус | Спожиті фрагменти |
|---|---|---|
| `README.md` | `d1afdf92181df9e002f9f75678f8ca46083c90bec0a9a33e47535a0593fa1c9c` | Позиціонування, практичний результат, локальний browser-preview лише як обмежений evidence |
| `docs/product-idea.md` | `bb6392c8762ebad8ad50be8da4cfc69cb925bc59a37fc993d5b75a8900b8ba73` | Element/Matrix V1, реальний Консиліум, дані, швидкість, команди, архів, витрати, критерій готовності |
| `docs/prd.md` | `196af1b75e9a8b89bb581203403cbb9a986c1dca5630639150fa192cd04f01ec` | §3–4, `FR-001`–`FR-036`, `NFR-001`–`NFR-015`, §8–12, `AC-001`–`AC-011` |
| `docs/project-context.md` | `19bc260c395412d5332e7bae62f60e4befea79fcf60b876fdd18db2e19e514c0` | Outcomes, platforms, scenarios, boundaries, constraints, assumptions, risks, open questions |
| `docs/canonical-terms.md` | `e9555a092cd994ec120013b62ac79615ac2f85b45c4180b1b1e9c505b82d105f` | Roles, objects, commands, states, A2A, Реєстратор, Канонічний порядок, Незмінний журнал сесії |
| `docs/guardrails.md` | `64a1e0998ac811202d96de532a04b70912a2ed6ad288295d1f4ffbb0f6d559db` | Source order, permissions, stop conditions, verification/evidence, design authority |
| `docs/user-journey.md` | `a9b39c4102c2715622a77973069eb0adbc722a04382083e1f975cc72b880a7d3` | Stages 1–10, decisions, failures, exits, success |
| `docs/screen-map.md` | `36b6c720adc3edb819027610e5eecbbdd05d987670b096e9bc2e4e3759a0e786` | `SUR-01`, `MG-01`–`MG-13`, `SS-01`–`SS-27`, transitions, edge paths |
| `docs/wireframes.md` | `b078bdcaf96b7f0f5fc822e842ae3339c93d3816875e8396b4df3a48eff37e83` | Sequences A–F, message structures, responsive notes, state variants |
| `docs/design-brief.md` | `1840c78c92d6ef665528602b70dc854d4e59e05180753c613af2671ed2a29ba4`, `proposed` | `P-01`–`P-10`, native inheritance, content hierarchy, accessibility floor, client/viewport coverage, proposed baseline state |
| `docs/architecture.md` | `66d2491008aac910c2d949ac29dea54b2467fd4ab6bb9a81ec19c51e7d8ba256` | Matrix bridge/E2EE crypto store, room invariants, named `RegistrarDO`, real processes, A2A v0.3.0, encrypted R2, outbound isolation, timing, costs |
| `docs/dod-evals.md` | `53e825f8264b9870ec9204b2d1b3f5f9c2be4d7a17a93887bc876b967cc750a2` | `G-01`–`G-16`, pass/block rules, evidence schema and levels, severity/release effect, rerun rules, open blockers |

### Checklist Field Contract

Every checklist row contains `Check ID`, `Check`, `Severity`, `Release Effect`, `Applicability`, `Source`, `Evidence` and `Rationale`. Severity and release effect are separate. P0 and P1 are blocking; P2 is blocking only for a required gate, primary/critical journey, applicable accessibility/security/privacy/data-integrity requirement, supported client/viewport or material design/interaction meaning. Otherwise P2 and P3 are advisory.

Evidence must be recorded using the eval result format from `docs/dod-evals.md`: `eval_id`, `gate`, `scope`, `level`, `status`, `source_references`, `environment_fingerprint`, `owner`, timestamps, `expected`, `actual`, `evidence_references`, `evidence_limit`, `findings` and `rerun_of` when applicable.

## Product Acceptance

| Check ID | Check | Severity | Release Effect | Applicability | Source | Evidence | Rationale |
|---|---|---|---|---|---|---|---|
| `QA-PA-001` | Простий Запит з exact private room, exact owner mxid і verified device отримує підтвердження не пізніше 5 секунд і Пряму відповідь без зайвого Консиліуму. | P1 | blocking | `AC-001`; direct-answer release path | `PRD AC-001`, `FR-007`–`FR-008`, `NFR-001`; `G-02`, `G-04`, `G-05`, `G-07`, `G-09`, `G-15` | Real Element/Matrix E2E timeline, room/device evidence, registrar state, lease inventory and visible response | Direct response is a primary path; unnecessary agents violate speed, cost and routing intent. |
| `QA-PA-002` | Складний Запит запускає one head Codex, 2–5 separate Codex specialists and one separate Claude Code critic, shows the first confirmed agent reply by 30 seconds, runs addressed A2A discussion and returns a synthesized result by 10 minutes or requests permission to continue. | P1 | blocking | `AC-002`; full Консиліум | `PRD AC-002`, `FR-009`–`FR-015`, `NFR-002`–`NFR-004`; `G-05`–`G-07`, `G-09`, `G-15` | Process lease/start/heartbeat/end records, independent first-pass artifacts, A2A registrations, Element/Matrix timeline and final-series capture | Real multi-process consultation is the central product promise. |
| `QA-PA-003` | Visible and archived agent messages preserve the exact confirmed body and canonical order; date/time, concrete role and `HH:MM` are visible, while technical IDs, seconds, hidden reasoning, tool logs and raw Markdown-as-code are absent. | P1 | blocking | `AC-003`; every `MG-07`, archive and export path | `PRD AC-003`, `FR-014`–`FR-019`, `NFR-010`–`NFR-011`; `G-06`, `G-10`, `G-12`, `G-13`, `G-15` | Hash or canonical-text comparison across registrar, Element-visible stream, archive and export; device captures; forbidden-metadata scan | Verbatim visibility and provenance distinguish the product from a synthetic transcript. |
| `QA-PA-004` | An ordinary message during an Active Session updates the same context; `Стоп` halts new calls and visible late output; `Нова задача` creates a fresh generation without prior active context. | P1 | blocking | `AC-004`; active session control | `PRD AC-004`, `FR-020`–`FR-022`; `G-04`, `G-08`, `G-15` | E2E clarification, injected late callback after `Стоп`, lease/cancel records and generation/context diff after `Нова задача` | User control and context isolation are release invariants. |
| `QA-PA-005` | Text, image and PDF are accepted; unsupported types do not start analysis; Secret is stopped before agent dispatch or immutable storage without echo; sensitive or uncertain document waits for separate permission. | P0 | blocking | `AC-005`; all input/data flows | `PRD AC-005`, `FR-003`–`FR-006`, `NFR-006`, `NFR-008`; `G-03`, `G-14`, `G-15` | Policy/unit cases, dispatch and storage traces, no-echo output, context projection diff, E2E supported/unsupported/sensitive fixtures | Leakage into immutable or external systems can cause severe harm and is difficult to remediate. |
| `QA-PA-006` | Wrong room/mxid, unverified or revoked device, missing E2EE key or failed room invariant launches no agent, returns no protected data, reads no archive and does not change the Active Session. | P0 | blocking | `AC-006`; every protected ingress/archive request | `PRD AC-006`, `FR-001`, `NFR-007`; `G-02`, `G-14`, `G-15` | Positive/negative Matrix identity, device, crypto and room-invariant cases; lease/outbox/archive absence; registrar state hash | Unauthorized protected access is catastrophic and cannot have a workaround. |
| `QA-PA-007` | Runtime/provider failure, stalled agent, missing evidence or need for more than 10 minutes is reported truthfully; replacement is visible; no synthetic reply or hidden success appears. | P1 | blocking | `AC-007`; failure and long-running paths | `PRD AC-007`, `FR-023`–`FR-024`, `FR-028`–`FR-030`, `NFR-003`–`NFR-004`, `NFR-012`; `G-05`, `G-07`, `G-09`, `G-15` | Failure injection, progress timeline, replacement lease record, partial-state capture and continuation permission record | A concealed failure destroys trust and may cause action on invented evidence. |
| `QA-PA-008` | A verified encrypted archive preserves the full Session; export preserves body/order; an individual reply cannot be edited/deleted; whole-session deletion requires a second explicit confirmation and verified removal. | P0 | blocking | `AC-008`; archive/export/delete | `PRD AC-008`, `FR-031`–`FR-032`, `NFR-005`, `NFR-010`–`NFR-011`; `G-10`, `G-15` | Ciphertext and key-separation inspection, manifest recomputation, full export comparison, negative individual-delete case, double-confirmed deletion and retention disclosure | Plaintext exposure or unconfirmed destructive deletion can cause severe irreversible harm. |
| `QA-PA-009` | `Витрати` shows deduplicated provider-confirmed current-session and current-month amounts with currency/period; missing data is partial/unavailable and no hard limit is invented. | P1 | blocking | `AC-009`; every usage provider and cost response | `PRD AC-009`, `FR-033`, `NFR-009`, `NFR-012`; `G-11`, `G-15` | Usage-to-lease/envelope correlation, duplicate replay, period/currency calculations and incomplete-usage E2E capture | A claimed factual cost must be traceable and must not mislead financial decisions. |
| `QA-PA-010` | A new reply appears in the same private E2EE Element/Matrix room on every supported client without a separate product UI or product-authored sound. | P2 | blocking | `AC-010`; Mac, iPhone, Samsung Flip7/Android and Windows PC | `PRD AC-010`, `FR-034`, `NFR-013`, `NFR-015`; `G-12`, `G-13`, `G-15` | Device matrix, same-room captures, notification-source inspection and documented client variance | The supported experience remains one native room; Element/OS owns notifications. |
| `QA-PA-011` | Final result is a short series containing one decision, at most three actions, material risks/assumptions and review condition; a self-contained Technical part appears only when needed; any external/high-risk action remains separately permission-gated. | P1 | blocking | `AC-011`; direct or consilium final result | `PRD AC-011`, `FR-025`–`FR-030`, `FR-035`–`FR-036`, `NFR-014`; `G-03`, `G-09`, `G-13`, `G-15` | Content-schema result, manual evidence-calibration review, real final-series capture and external-effect negative/permission cases | The product must turn analysis into one safe, usable action contract. |

## User Journey Checks

| Check ID | Check | Severity | Release Effect | Applicability | Source | Evidence | Rationale |
|---|---|---|---|---|---|---|---|
| `QA-JRN-001` | Execute the direct path end to end: access → consent where needed → safe intake → accepted Session → mode selection → direct result → verified archive. | P1 | blocking | User Journey Stages 1–6A and 10 | `docs/user-journey.md` Stages 1–6A, 10 and Direct Success State; `AC-001` | One correlated E2E evidence bundle with state transitions, timeline, visible messages and archive manifest | A direct answer is complete only when ingress, result and closing integrity all hold. |
| `QA-JRN-002` | Execute the full consilium path end to end: access → safe intake → `MG-04` → roster → independent first pass → addressed discussion → critic → final series → verified archive. | P1 | blocking | User Journey Stages 1–6B, 8–10 | `docs/user-journey.md` Stages 1–10 and Full Consilium Success State; `AC-002`, `AC-003`, `AC-007`, `AC-011` | One correlated E2E bundle linking process leases, A2A envelopes, Element/Matrix stream, final result and archive | Partial component success does not prove the primary product journey. |
| `QA-JRN-003` | Execute every decision/exit branch: unauthorized access, no consent, unsupported type, Secret, no sensitive-document permission, insufficient evidence, unavailable consilium, no >10-minute permission, `Стоп`, `Нова задача`, export, denied deletion and confirmed deletion. | P1 | blocking | All Journey Decision Points, Failure Path and Exit Points | `docs/user-journey.md` Decision Points, Failure Path 1–12, Exit Points; `G-02`–`G-11` | Branch-indexed E2E/integration results with expected/actual, next state and absence of forbidden side effects | Failure and permission paths carry the highest trust and data risks. |
| `QA-JRN-004` | Verify that every success or partial exit tells the owner what happened, what is known/unknown and the next allowed action, without moving responsibility for synthesis back to the owner. | P1 | blocking | Direct, full consilium and evidence-limited outcomes | `docs/user-journey.md` Climax Beat, Success State; `PRD FR-025`–`FR-030`; `G-09` | Manual review of representative outputs plus structured final-series checks | Practical outcome and truthful limits are the user-value criterion. |

## Screen And State Checks

| Check ID | Check | Severity | Release Effect | Applicability | Source | Evidence | Rationale |
|---|---|---|---|---|---|---|---|
| `QA-SS-001` | `SUR-01` remains the only product surface: one private native Element/Matrix conversation, without browser product, dashboard, archive browser, consent center, notification center or custom navigation. | P1 | blocking | All V1 user-visible scope | `docs/screen-map.md` Screen Inventory, Navigation Model, Out Of Scope Screens; `NFR-013`; `G-12`, `G-13` | Route/surface inventory, deployed endpoint review and device evidence showing the flow stays in one native chat | A second product surface contradicts confirmed V1 scope. |
| `QA-SS-002` | `MG-01`–`MG-04` and `SS-01`–`SS-08` cover owner input, access, consent, input validation, denied access, unsupported type, Secret, sensitive permission and accepted-session start exactly as mapped. | P1 | blocking | Intake and session-entry scope | `docs/screen-map.md` `MG-01`–`MG-04`, `SS-01`–`SS-08`; Wireframes Sequence A | State-transition trace, visible content captures and negative-effect assertions for every state | These states protect access and data before irreversible work begins. |
| `QA-SS-003` | `MG-05`–`MG-08` and `SS-09`–`SS-12` cover direct answer, roster, live consilium, progress/wait/replacement with the required timing and truthful state meaning. | P1 | blocking | Direct and active-consilium scope | `docs/screen-map.md` `MG-05`–`MG-08`, `SS-09`–`SS-12`; Wireframes Sequences B–C | Mode-specific timeline, roster/process evidence, message captures and injected stall/replacement | The core working experience must not collapse direct and consilium modes or fake progress. |
| `QA-SS-004` | `MG-01`, `MG-09`–`MG-10` and `SS-13`–`SS-16` cover clarification, costs, `Стоп` and literal `Нова задача` transition with correct return/exit behavior. | P1 | blocking | Owner intervention during active/completed context | `docs/screen-map.md` `MG-09`–`MG-10`, `SS-13`–`SS-16`, Transition Notes 5–7; Wireframes Sequence D | Command and ordinary-message scenarios, before/after Session generation, cost response and late-output checks | Commands are control boundaries, not decorative chat copy. |
| `QA-SS-005` | `MG-02`, `MG-11`–`MG-12` and `SS-17`–`SS-20` cover >10-minute permission, other separate permissions, failure/partial state and final recommendation without false success. | P1 | blocking | Long-running, permission, failure and final-result scope | `docs/screen-map.md` `SS-17`–`SS-20`; Wireframes Sequence E; `G-03`, `G-07`, `G-09` | Permission records, failure injection, visible sequence capture and manual truthfulness review | These states decide whether work may continue or be presented as usable. |
| `QA-SS-006` | `MG-13` and `SS-21`–`SS-24` cover verified archived state, full export, repeat confirmation and whole-session deletion; no transition allows individual-reply mutation. | P0 | blocking | Archive-control scope | `docs/screen-map.md` `MG-13`, `SS-21`–`SS-24`; Wireframes Sequence F; `G-10` | Archive state trace, export comparison, negative mutation test, confirmation record and deletion verification | Archive integrity and destructive control are high-risk invariants. |
| `QA-SS-007` | General Empty, Loading/in-progress, Error, Success, Permission denied/absent, Offline/native delivery and Long content categories use the source-defined native behavior and never invent custom states. | P2 | blocking | Every applicable `SUR-01` state category | `docs/screen-map.md` General State Categories; `docs/wireframes.md` General Structural Variants; `G-12`, `G-13` | State inventory review plus representative prototype/device captures and offline/delivery observations | Missing or invented general states create unsupported behavior and misleading status. |
| `QA-SS-008` | Screen/state coverage remains complete after change: `SUR-01` 1/1, `MG-01`–`MG-13` 13/13 and `SS-01`–`SS-27` 27/27, with no untraced new surface/group/state. | P1 | blocking | Every user-visible change and pre-approval candidate | `docs/screen-map.md`; `G-01`, `G-13` | Mechanical coverage report and diff against the canonical inventories | Coverage drift can silently remove a required branch or add product scope. |
| `QA-SS-009` | `SS-25`–`SS-27` block product work during native recovery/verification, device revocation or failed room invariants; recovery keys never enter chat/log/agent context and no plaintext fallback exists. | P0 | blocking | Matrix onboarding, recovery and every protected Session start | `docs/screen-map.md` `SS-25`–`SS-27`; architecture Room Contract; `G-02`, `G-14`, `G-15` | Real device recovery/revocation evidence, crypto-store restart, room-invariant matrix and negative agent-dispatch assertions | A compromised device, missing key or unsafe room must not silently degrade security. |

Coverage index: `SUR-01` → `QA-SS-001`; `MG-01`–`MG-04`/`SS-01`–`SS-08` → `QA-SS-002`; `MG-05`–`MG-08`/`SS-09`–`SS-12` → `QA-SS-003`; `MG-09`–`MG-10`/`SS-13`–`SS-16` → `QA-SS-004`; `MG-11`–`MG-12`/`SS-17`–`SS-20` → `QA-SS-005`; `MG-13`/`SS-21`–`SS-24` → `QA-SS-006`; `SS-25`–`SS-27` → `QA-SS-009`; general categories → `QA-SS-007`.

## Wireframe Consistency Checks

| Check ID | Check | Severity | Release Effect | Applicability | Source | Evidence | Rationale |
|---|---|---|---|---|---|---|---|
| `QA-WF-001` | Sequences A–F preserve their source order and branch behavior; critical access/data/permission/command/failure blocks interrupt only the named action and appear before lower-priority progress. | P1 | blocking | Every prototype and user-visible flow | `docs/wireframes.md` Conversational Sequences A–F, Layout Structure, Content Priority Notes; `G-13` | Sequence trace with representative artifact references and branch comparison | Reordering a critical boundary can change meaning or allow an unsafe transition. |
| `QA-WF-002` | Every `MG-01`–`MG-13` message keeps its defined internal content zones and next action; no buttons, cards, forms, custom composer or unsupported control is introduced. | P2 | blocking | All product-authored message patterns | `docs/wireframes.md` Shared Patterns; `docs/design-brief.md` `P-01`–`P-10`; `G-13` | Message-by-message content audit and prototype captures | Message structure is the only product-owned interaction design inside native Element/Matrix. |
| `QA-WF-003` | Each confirmed agent reply is atomic: concrete role and `HH:MM` immediately precede the full unchanged body; a correction is a new later reply. | P1 | blocking | Every `MG-07` / `P-02` + `P-05` | `docs/wireframes.md` Atomic Agent-Reply Pattern; `PRD FR-015`–`FR-019`; `G-06` | Body hash comparison, role/time capture and correction scenario | Atomism protects provenance, order and immutability. |
| `QA-WF-004` | Final recommendation remains separate self-contained messages in the order decision → up to three actions → risk/assumption/review condition → Technical part only when needed. | P1 | blocking | `MG-12`, `P-06`, `P-07` | `docs/wireframes.md` Sequence E; `PRD FR-026`–`FR-027`; `G-09`, `G-13` | Content-schema output and manual comprehension review on mobile/desktop clients | The agreed final structure turns a long process into an actionable result. |

## UX/UI Checks

| Check ID | Check | Severity | Release Effect | Applicability | Source | Evidence | Rationale |
|---|---|---|---|---|---|---|---|
| `QA-UX-001` | Product-owned presentation uses native Element/Matrix chrome and current-client behavior; no custom colors, fonts, bubbles, elevation, composer, delivery indicators, motion or navigation is presented as product UI. | P1 | blocking | All pre-approval artifacts and user-visible implementation | `docs/design-brief.md` `DB-D01`–`DB-D03`, Colors through Shapes, Rejected Directions; `G-13` | Static/prototype review and deployed surface inventory | The validated design direction is a content system inside native Element/Matrix, not a new app shell. |
| `QA-UX-002` | `P-01`–`P-10` are all represented where applicable, and their appearance/behavior does not alter `MG`/`SS` contracts. | P2 | blocking | Representative pre-approval candidate and each affected user-visible change | `docs/design-brief.md` Component Appearance/Behavior, Message-Group Coverage, State Patterns; `G-13` | Pattern coverage matrix and source-to-artifact trace | Design patterns may clarify presentation but cannot redefine behavior. |
| `QA-UX-003` | Every product-authored block starts with one dominant decision, boundary, role or factual status; supporting context follows without decorative hierarchy or technical noise. | P2 | blocking | `P-01`, `P-03`, `P-04`, `P-06`, `P-10` | `docs/design-brief.md` Design Brief, Design Spine, Voice And Tone | Manual scan/comprehension review across representative messages | Signal-first structure lets the owner identify status and action quickly. |
| `QA-UX-004` | Canonical Ukrainian terms and exact commands are used; user copy is natural, complete and direct; `лійка продажів` replaces the calque; visible roles are concrete and never technical IDs. | P2 | blocking | All product-authored Ukrainian content | `docs/canonical-terms.md`; `PRD FR-036`; `docs/design-brief.md` Voice And Tone; `G-09`, `G-13` | Terminology scan plus manual Ukrainian language review | Terminology inconsistency can change commands, roles or trust-critical meaning. |
| `QA-UX-005` | Critical meaning and state change are explicit in text and remain understandable without color, emoji, formatting, motion or delivery icon. | P2 | blocking | Permissions, failures, risk, commands and archive controls | `docs/design-brief.md` `DB-D05`, Concern Scan, Accessibility Floor; `G-12`, `G-13` | Plain-text fallback review, formatting-disabled capture and assistive-technology reading | Native client variance must not erase safety or action meaning. |

## Visual Regression Checks

These are pre-approval design-fidelity checks under `G-13`, not visual-DoD claims against an Approved Visual Baseline. Their proposed-contract binding is immutable for this checklist revision. After approval, regenerate them as `G-16` checks with the active Baseline ID and immutable visual target hash.

### `QA-VIS-001` — Proposed contract coverage

- **Check:** The Matrix-native rendered Candidate B and any user-visible pre-approval implementation cover `SUR-01`, `MG-01`–`MG-13`, `SS-01`–`SS-27` and `P-01`–`P-10` without calling themselves approved.
- **Severity:** P2
- **Release Effect:** blocking for the candidate or pre-approval user-visible scope
- **Applicability:** every pre-approval candidate and user-visible artifact
- **Source:** `docs/design-brief.md` Prototype Mockup Candidate Directions, Design Handoff Prompt, Approved Visual Baseline; `G-13`
- **Evidence:** source-to-artifact coverage matrix, representative renders/captures and explicit `proposed` label
- **Rationale:** Candidate comparison is valid only when all directions preserve the same product/state contract.
- **Baseline ID:** not applicable before whole-design approval; no Baseline ID exists
- **Target Hash:** no immutable visual target hash exists; current proposed design contract SHA-256 is `1840c78c92d6ef665528602b70dc854d4e59e05180753c613af2671ed2a29ba4`
- **Route:** `SUR-01`
- **State:** representative coverage of `SS-01`–`SS-27` and every `MG-01`–`MG-13`
- **Viewport:** `390`, `430`, `768`, `1280`, `1440px` design stress views plus linked native-client evidence when available
- **Permitted Variance:** only native Element/Matrix/OS platform variance; behavior, body completeness, canonical order, role/time and state meaning may not vary
- **Result:** blocked — no prototype candidate evidence exists yet; this is expected before prototype generation and is not an approval claim

### `QA-VIS-002` — Native inheritance and content fidelity

- **Check:** Candidate or user-visible output inherits current Element/Matrix chrome, preserves full body/order and uses only allowed presentation emphasis; it adds no custom browser surface, chrome, control, collapse or color-only meaning.
- **Severity:** P1
- **Release Effect:** blocking
- **Applicability:** every rendered pre-approval flow and current-client comparison
- **Source:** `docs/design-brief.md` `DB-D01`–`DB-D08`, Visual Do's And Don'ts, Rejected Directions; `G-13`
- **Evidence:** render review, body hash/text comparison, surface inventory and formatting-disabled/plain-text capture
- **Rationale:** Material presentation drift can change product scope, provenance or safety meaning.
- **Baseline ID:** not applicable before whole-design approval
- **Target Hash:** no immutable visual target hash exists; proposed design contract SHA-256 is `1840c78c92d6ef665528602b70dc854d4e59e05180753c613af2671ed2a29ba4`
- **Route:** `SUR-01`
- **State:** long reply, permission, progress, failure, final series and archive control, with remaining states covered by the candidate matrix
- **Viewport:** `390`, `430`, `768`, `1280`, `1440px`, then Mac/iPhone/Samsung Flip7/Windows native clients
- **Permitted Variance:** client-native line wrap, bubble width, theme, font and delivery indicators only
- **Result:** blocked — no candidate or native-client comparison evidence exists yet

### `QA-VIS-003` — Phase truth and regeneration trigger

- **Check:** No artifact or result claims an Approved Visual Baseline before approval; after an approval receipt, this checklist is invalidated and regenerated with Baseline ID, target hash, frozen artifact references, covered states/viewports, permitted variance and overrides.
- **Severity:** P1
- **Release Effect:** blocking after any approval receipt or false approval claim
- **Applicability:** pipeline metadata, candidate reports, QA results and downstream planning
- **Source:** `docs/design-brief.md` Approved Visual Baseline; `docs/dod-evals.md` `G-13`, `G-16`; `docs/guardrails.md` Design Authority Rules
- **Evidence:** phase/status inspection now; after approval, approval receipt and regenerated checklist hash
- **Rationale:** A proposed contract and an approved immutable target have different authority and evidence requirements.
- **Baseline ID:** currently not assigned
- **Target Hash:** currently not established
- **Route:** `SUR-01`
- **State:** all affected approved states after the future receipt
- **Viewport:** all viewports frozen by the future receipt
- **Permitted Variance:** current source allows only native platform variance; future receipt may record named operator overrides
- **Result:** passed — current sources consistently state `proposed`, no Baseline ID or visual target hash exists, and this item records the regeneration trigger

## Responsive Checks

| Check ID | Check | Severity | Release Effect | Applicability | Source | Evidence | Rationale |
|---|---|---|---|---|---|---|---|
| `QA-RSP-001` | At `390`, `430`, `768`, `1280` and `1440px`, content order remains one chronology; role/`HH:MM` stays attached to its body; no two-column transcript, side panel, horizontal product composition or decorative fill appears. | P2 | blocking | Every pre-approval candidate; design stress only | `docs/design-brief.md` Responsive And Platform Behavior; `docs/wireframes.md` Responsive Structure Notes; `G-13` | Rendered captures at all five widths and layout inspection | Stress views reveal line-wrap and hierarchy failures before native-client evidence. |
| `QA-RSP-002` | Long Ukrainian text, long role names, links, lists and Technical part reflow without manual columns, ASCII tables, clipped meaning or product-added collapse; each final message remains independently understandable. | P2 | blocking | Long-content states on narrow and desktop clients | `docs/design-brief.md` Layout And Spacing, Accessibility Floor, Responsive And Platform Behavior; `SS-11`, `SS-20` | Long-content fixtures, captures, text extraction and manual reading | Full verbatim content is required, so resilience cannot rely on truncation. |
| `QA-RSP-003` | Actual text scaling and theme behavior are verified in current native clients; browser viewport success is not reported as native responsive success. | P2 | blocking | Mac, iPhone, Samsung Flip7/Android and Windows PC | `docs/design-brief.md` Concern Scan, Accessibility Floor, Responsive And Platform Behavior; `G-12`, `G-13` | Device/client matrix with app/OS versions, supported text-scale/theme settings and observed variance | Client-owned layout may differ from prototype rendering. |

## Accessibility Checks

| Check ID | Check | Severity | Release Effect | Applicability | Source | Evidence | Rationale |
|---|---|---|---|---|---|---|---|
| `QA-A11Y-001` | Product-authored content meets the WCAG 2.2 AA floor for controlled semantics: logical reading order, clear labels/instructions, meaningful links, explicit errors/permissions and no color-only meaning. | P2 | blocking | All product-authored messages and prototype evidence | `docs/design-brief.md` `DB-D08`, Accessibility Floor; `G-13` | Manual WCAG review, plain-text extraction and representative assistive-technology reading | Accessibility meaning is product-owned even when native chrome is not. |
| `QA-A11Y-002` | VoiceOver on iPhone/Mac and TalkBack on Samsung Flip7/Android announce role, `HH:MM`, status, risk, action, lists and Technical part in meaningful order; Windows flow is checked with keyboard and an available screen reader. | P2 | blocking | All four target client families | `docs/design-brief.md` Accessibility Floor and Responsive/Platform Behavior; `G-12`, `G-13` | Screen-reader recordings/transcripts, focus/reading sequence and app/OS versions | Visual order alone does not prove an accessible reading path. |
| `QA-A11Y-003` | User text scaling preserves complete content, state meaning and message order without clipping or horizontal product overflow; critical content is not relegated to secondary styling. | P2 | blocking | Current clients and proposed stress views | `docs/design-brief.md` Accessibility Floor; Responsive/Platform Behavior; `G-12`, `G-13` | Maximum supported text-scale captures, zoom/reflow review where applicable and long-content fixture | The owner must retain control and comprehension with enlarged text. |
| `QA-A11Y-004` | Dynamic state changes—accepted, waiting, replacement, failure, permission, stopped, new task, archived and deleted—are communicated in text and do not rely on motion, typing indicator or delivery icon. | P1 | blocking | `SS-08`, `SS-12`, `SS-15`–`SS-24` | `docs/design-brief.md` `DB-D05`, Motion, Accessibility Floor; `G-09`, `G-12`, `G-13` | State-change captures with motion unavailable and assistive reading evidence | Missing state communication can cause unsafe continuation or mistaken completion. |
| `QA-A11Y-005` | Native controls retain Element/Matrix/OS focus, target and input behavior; the product adds no custom focusable control and does not claim native-client conformance without current-client testing. | P2 | blocking | Composer, attachment preview and native client controls | `docs/design-brief.md` Accessibility Floor 7, Interaction Primitives; `G-12`, `G-13` | Device keyboard/touch/screen-reader observation and surface inventory | Control accessibility is platform-owned but must be honestly observed for the supported flow. |

## Interaction And State-Change Checks

| Check ID | Check | Severity | Release Effect | Applicability | Source | Evidence | Rationale |
|---|---|---|---|---|---|---|---|
| `QA-INT-001` | The verified bot-device in always-on `MatrixBridgeContainer` restores its encrypted crypto store, syncs/decrypts only the exact compliant room and sends idempotent events to one `RegistrarDO`; Matrix send receipt is not misreported as device read. | P0 | blocking | Deployed Matrix/Cloudflare integration | Architecture System Context, Room Contract, Availability; `G-02`, `G-04`, `G-07`, `G-14`, `G-15` | Bridge restart, crypto restore, room-invariant, DO state, transaction-id/outbox and real Matrix receipt evidence | Transport and crypto state must not bypass canonical truth or degrade to plaintext. |
| `QA-INT-002` | Every visible agent role maps to a current separate process lease with start/heartbeat/end status; full consilium includes the required roster and independent first pass. | P1 | blocking | Every claimed consilium participant | Architecture Modules, End-To-End Flow and Runtime Rules; `G-05` | Lease/process evidence, runtime configuration fingerprint, bounded objective and first-pass record | Labels or mocks cannot prove separate agent execution. |
| `QA-INT-003` | Every A2A draft returns through `RegistrarDO`, passes lease/generation/recipient/dedupe/policy validation, receives canonical sequence/hash and only then routes to target and visible outbox; bypass is rejected. | P1 | blocking | Every agent message and correction | Architecture Core Contracts and Runtime/A2A Rules; `G-06` | Transaction trace, bypass/duplicate/stale tests, sequence/hash chain and target/outbox correlation | One registrar is the only source of visible order and immutability. |
| `QA-INT-004` | Duplicate Matrix event, A2A envelope or outbox retry produces no duplicate Session, process work, visible reply, archive entry or cost. | P1 | blocking | Ingress, A2A, outbox, usage and recovery | `PRD NFR-009`; architecture Availability And Recovery; `G-04`, `G-06`, `G-11` | Replay/concurrency/failure-injection results and before/after counts/hashes | Retry is expected and must not multiply effects. |
| `QA-INT-005` | Monotonic timing evidence separately proves 5-second acknowledgement, 30-second first confirmed agent reply, no >60-second silent active interval and 10-minute final/permission transition under representative load. | P1 | blocking | Direct, consilium, progress and continuation paths | `PRD NFR-001`–`NFR-004`; `docs/architecture.md` timers/observability; `G-07` | Correlated ingress/registrar/runtime/outbox/device timestamps and load profile | Each threshold is an independent product requirement. |
| `QA-INT-006` | `Стоп` closes publication before cancellation attempts, revokes live leases and rejects late callbacks; `Нова задача` closes the prior generation and starts fresh leases/context. | P1 | blocking | Active Session with running or queued work | `docs/architecture.md` Runtime Model 8–9, Security Model; `G-04`, `G-08` | Atomic transition record, cancel intents/receipts, injected late callback, generation/lease/context diff | Best-effort provider cancellation cannot replace authoritative suppression. |
| `QA-INT-007` | Completion occurs only after archive encryption, write/read hash verification and manifest integrity; R2/key outage or mismatch leaves a truthful partial state without plaintext fallback. | P0 | blocking | Normal completion, archive recovery and export | Architecture Persistence, Keys And Deletion and Availability; `G-10`, `G-14` | Ciphertext inspection, wrapped-key separation, mismatch/key-outage injection, manifest recomputation and state transition | False archived success can expose or lose the canonical record. |
| `QA-INT-008` | `Витрати` reads only confirmed usage records correlated to leases/envelopes, deduplicates retries and reports missing confirmation as partial/unavailable. | P1 | blocking | All configured agent runtimes and cost periods | `docs/architecture.md` `UsageRecord`, Runtime Model 10; `G-11` | Provider/runtime usage receipts, aggregation result, replay case and unavailable path | Architecture permits no estimate to masquerade as actual cost. |
| `QA-INT-009` | Containers run with `enableInternet=false`; outbound handlers allow only homeserver, OpenAI, Anthropic and approved research gateways and inject credentials without exposing long-lived tokens to agent workspaces. | P0 | blocking | Bridge and AgentRuntime network boundary | Architecture Network And Secrets; `G-03`, `G-14` | Deployed config, denied arbitrary-host tests, agent environment scan and successful allowlisted calls | Arbitrary egress or agent-visible credentials defeat the declared isolation boundary. |

## Browser And Device Checks

| Check ID | Check | Severity | Release Effect | Applicability | Source | Evidence | Rationale |
|---|---|---|---|---|---|---|---|
| `QA-DEV-001` | The full required flow works in the current native Element/Matrix client on Mac, including long body, formatting, text scaling, VoiceOver/keyboard path and documented limitations. | P2 | blocking | Mac client | `PRD NFR-013`, `AC-010`; `docs/design-brief.md` Responsive/Platform Behavior; `G-12` | App/macOS version, device E2E capture, transcript comparison and accessibility observations | Mac is an explicitly supported client family. |
| `QA-DEV-002` | The full required flow works in the current native Element/Matrix client on iPhone, including long body, formatting, text scaling and VoiceOver. | P2 | blocking | iPhone client | Same as `QA-DEV-001` | App/iOS/device version, device E2E capture, transcript comparison and accessibility observations | iPhone is an explicitly supported client family. |
| `QA-DEV-003` | The full required flow works in the current native Element/Matrix client on Samsung Flip7/Android, including long body, formatting, text scaling and TalkBack. | P2 | blocking | Samsung Flip7/Android client | Same as `QA-DEV-001` | App/Android/device version, device E2E capture, transcript comparison and accessibility observations | Samsung Flip7/Android is an explicitly supported client family. |
| `QA-DEV-004` | The full required flow works in the current native Element/Matrix client on Windows PC, including long body, formatting, keyboard and available screen-reader path. | P2 | blocking | Windows PC client | Same as `QA-DEV-001` | App/Windows version, device E2E capture, transcript comparison and accessibility observations | Windows PC is an explicitly supported client family. |
| `QA-DEV-005` | Text, image and PDF input/output behavior is verified through Element/Matrix Client-Server API and actual clients; each material formatting or delivery difference is recorded as platform variance, not hidden by a custom fallback. | P1 | blocking | Cross-client/provider matrix | `PRD FR-003`, `FR-015`, `FR-017`–`FR-019`, `FR-034`; `G-12`, `G-15` | Provider payload/receipts linked to four-client matrix, attachment fixtures, body/order comparison and limitation log | Product readiness requires provider plus client evidence, not a browser simulation. |
| `QA-DEV-006` | A new device cannot read or start protected work before native recovery and verification; a revoked device loses the supported production path; recovery keys never appear in product content or evidence. | P0 | blocking | All owner and bot devices | `SS-25`–`SS-26`; architecture Trust Boundaries; `G-02`, `G-14`, `G-15` | Real new-device/revocation run on applicable Element clients, key-content scan and negative dispatch trace | Device trust is part of the E2EE access boundary. |

`consilium/live/*`, generated HTML and browser viewport captures may support isolated formatting inspection only. They are not a browser/device release target and cannot pass `QA-DEV-001`–`QA-DEV-005`.

## Evidence Requirements

| Check ID | Check | Severity | Release Effect | Applicability | Source | Evidence | Rationale |
|---|---|---|---|---|---|---|---|
| `QA-EVD-001` | Every executed checklist item has one persisted eval result with the complete `docs/dod-evals.md` result schema and an immutable/readable evidence reference. | P1 | blocking | Every required check and rerun | `docs/dod-evals.md` Eval Result Format, Evidence Requirements | Schema validation report and sample-link resolution | A checklist tick without scope, environment, actual result and evidence is not a result. |
| `QA-EVD-002` | Evidence lineage includes current source hashes, code revision, deployed environment/config, runtime/model/A2A/key/export identifiers and client/app/OS versions relevant to the claim, without Secrets. | P1 | blocking | Every integration, E2E, device and release claim | `G-01`; `docs/dod-evals.md` Completion Evidence Bundle | Environment fingerprint and source/hash report | Results from another source/config lineage cannot pass the current scope. |
| `QA-EVD-003` | Canonical transcript evidence links registrar sequence/body hashes to A2A target routing, Element-visible content, archive and export, including documented transport segmentation and dedupe. | P1 | blocking | Every agent-message/archive claim | `G-06`, `G-10`; `docs/guardrails.md` Verification Rules | Correlation manifest with body/order comparisons and immutable refs | Separate screenshots or logs cannot prove end-to-end verbatim integrity. |
| `QA-EVD-004` | Failure/recovery evidence shows both the injected failure and restored invariant for duplicate retry, lease loss/replacement, late callback, outbox retry, archive mismatch, key outage and incomplete usage. | P1 | blocking | Shared reliability/security contracts | `docs/dod-evals.md` Rerun And Recovery Rules; `G-04`–`G-11` | Failure-injection reports, prior/current eval IDs and recovery state | Happy-path evidence alone misses the most consequential regressions. |
| `QA-EVD-005` | Product V1 release uses one versioned real-Matrix E2E bundle covering `AC-001`–`AC-011`, all applicable hard gates and the four-client matrix, with no blocking finding. | P1 | blocking | Product V1 release claim | `G-15`; Global Definition Of Done; Release Checks | Aggregate report referencing all child evals and exact supported claims/limitations | Only the real deployed workflow is accepted as the highest readiness proof. |
| `QA-EVD-006` | Evidence is minimized: no Secret, Matrix access/recovery key, raw sensitive document, wrapping key or unnecessary verbatim user content appears in telemetry or evidence bundles. | P0 | blocking | All test, observability and review artifacts | `docs/guardrails.md` Evidence Requirements; architecture Observability; `G-03`, `G-14` | Evidence-content scan, redaction review and telemetry sample | QA evidence must not create the privacy breach it is intended to detect. |

## Evidence Limits

| Check ID | Check | Severity | Release Effect | Applicability | Source | Evidence | Rationale |
|---|---|---|---|---|---|---|---|
| `QA-LIM-001` | Static docs, source inspection, mockup, prototype, screenshot, generated HTML or local browser-preview are labeled only for the property they demonstrate and never as runtime, deployment or release evidence. | P1 | blocking | Every static/design evidence claim | `docs/guardrails.md` Evidence Requirements; `docs/dod-evals.md` Evidence Limits | Claim-to-evidence review | Static intent cannot prove Element/Matrix, Cloudflare, A2A, process, timing, archive, delivery or cost behavior. |
| `QA-LIM-002` | Element/Matrix API acceptance is not reported as delivered/read or correctly rendered; separate provider receipts and device-visible evidence are required. | P1 | blocking | Every outbound-message and timing claim | `docs/architecture.md` Integration Map; `G-07`, `G-12` | Receipt-state correlation and device capture | Transport statuses have different meanings and failure modes. |
| `QA-LIM-003` | A role label or transcript is not reported as a real agent process; current lease/start/heartbeat evidence is required for each visible role. | P1 | blocking | Every consilium claim | `G-05`; `docs/dod-evals.md` Evidence Limits | Role-to-process correlation | The core promise is actual separate execution, not presentation. |
| `QA-LIM-004` | No WCAG, security, privacy, deletion or broad compliance guarantee is claimed from this checklist or static review; claims are narrowed to tested content, environment, client and evidence. | P1 | blocking | Accessibility, security/privacy and deletion reporting | `docs/dod-evals.md` Evidence Limits; `docs/design-brief.md` Accessibility Floor | Claim-language review and exact evidence scope | Overclaiming creates legal, safety and trust risk. |

## Regression Risks

| Check ID | Check | Severity | Release Effect | Applicability | Source | Evidence | Rationale |
|---|---|---|---|---|---|---|---|
| `QA-REG-001` | Changes to auth, identity normalization, data policy, context projection or telemetry rerun `G-02`, `G-03`, `G-14`, `AC-005`, `AC-006` and all affected intake states. | P0 | blocking | Any named change | `docs/dod-evals.md` Rerun And Recovery Rules | Rerun bundle linked to the change | Shared access/data code has catastrophic blast radius. |
| `QA-REG-002` | Changes to `RegistrarDO`, envelope schema, formatter, outbox, segmentation or dedupe rerun `G-04`, `G-06`, `G-07`, affected `AC-002`–`AC-004` and transcript/archive comparisons. | P1 | blocking | Any named change | Same; `docs/architecture.md` State Integrity | Rerun bundle plus sequence/body/dedupe comparison | These contracts jointly determine visible truth and order. |
| `QA-REG-003` | Changes to runtime adapter, process image/config, routing, roster or critic rerun real-process, replacement, timing, cancellation and cost checks. | P1 | blocking | Any named change | `G-05`, `G-07`, `G-08`, `G-11` rerun rules | Real integration rerun with current fingerprints | Runtime changes can create fake roles, stale output, latency and cost drift. |
| `QA-REG-004` | Changes to Session state/generation, command parser, cancellation, queue or retry rerun duplicate, clarification, `Стоп`, `Нова задача`, late-output and context-isolation scenarios. | P1 | blocking | Any named change | `G-04`, `G-08`; `AC-004` | Replay/concurrency/cancel/generation rerun | State-priority defects can mix tasks or continue unwanted spending. |
| `QA-REG-005` | Changes to crypto, key provider, R2, manifest, archive/export/deletion or retention disclosure rerun encryption, integrity, outage, full export and confirmed deletion checks. | P0 | blocking | Any named change | `G-10`, `G-14`; `AC-008` | Security/config review plus runtime/failure E2E rerun | Archive regressions can expose data or destroy it irreversibly. |
| `QA-REG-006` | Changes to user-visible content, proposed candidate, formatting, client payload or design source rerun `G-12`, `G-13`, all affected `MG`/`SS`, responsive and accessibility checks; after approval the same change also reruns `G-16`. | P2 | blocking | Any named change | `G-12`, `G-13`, future `G-16` rerun rules | Updated matrix/captures; after approval, active baseline-bound VisualQAEvidence | Client/design drift can alter supported readability or approved interaction meaning. |

### Requirement Traceability Index

| Requirement set | Primary QA coverage |
|---|---|
| `FR-001`–`FR-006` | `QA-PA-005`–`QA-PA-006`, `QA-JRN-003`, `QA-SS-002`, `QA-INT-001`, `QA-A11Y-001`, `QA-REG-001` |
| `FR-007`–`FR-010` | `QA-PA-001`–`QA-PA-002`, `QA-JRN-001`–`QA-JRN-002`, `QA-SS-003`, `QA-INT-002`, `QA-INT-005` |
| `FR-011`–`FR-019` | `QA-PA-002`–`QA-PA-003`, `QA-WF-003`, `QA-VIS-002`, `QA-INT-003`–`QA-INT-004`, `QA-EVD-003` |
| `FR-020`–`FR-024` | `QA-PA-004`, `QA-PA-007`, `QA-SS-004`–`QA-SS-005`, `QA-INT-005`–`QA-INT-006` |
| `FR-025`–`FR-030` | `QA-PA-007`, `QA-PA-011`, `QA-JRN-004`, `QA-WF-004`, `QA-UX-003`–`QA-UX-005` |
| `FR-031`–`FR-032` | `QA-PA-008`, `QA-SS-006`, `QA-INT-007`, `QA-EVD-003`, `QA-REG-005` |
| `FR-033` | `QA-PA-009`, `QA-SS-004`, `QA-INT-008` |
| `FR-034` | `QA-PA-010`, `QA-A11Y-004`, `QA-DEV-001`–`QA-DEV-005` |
| `FR-035`–`FR-036` | `QA-PA-011`, `QA-JRN-003`–`QA-JRN-004`, `QA-UX-004`, `QA-A11Y-001` |
| `NFR-001`–`NFR-004` | `QA-PA-001`–`QA-PA-002`, `QA-PA-007`, `QA-INT-005` |
| `NFR-005`–`NFR-008` | `QA-PA-005`–`QA-PA-006`, `QA-PA-008`, `QA-INT-001`, `QA-INT-007`, `QA-EVD-006`, `QA-REG-001`, `QA-REG-005` |
| `NFR-009`–`NFR-012` | `QA-PA-003`–`QA-PA-004`, `QA-PA-007`–`QA-PA-009`, `QA-INT-003`–`QA-INT-008` |
| `NFR-013`–`NFR-015` | `QA-PA-010`–`QA-PA-011`, `QA-RSP-001`–`QA-RSP-003`, `QA-A11Y-001`–`QA-A11Y-005`, `QA-DEV-001`–`QA-DEV-005` |
| `AC-001`–`AC-011` | One-to-one `QA-PA-001`–`QA-PA-011`, aggregated by `QA-EVD-005` |

## Release Readiness

| Check ID | Check | Severity | Release Effect | Applicability | Source | Evidence | Rationale |
|---|---|---|---|---|---|---|---|
| `QA-RR-001` | Report release readiness as `passed` only when every applicable hard gate and required checklist item has fresh `passed` evidence and every blocking finding is closed; otherwise report `blocked` with named blockers. | P1 | blocking | Product V1 release and any narrower completion claim | `docs/dod-evals.md` Global DoD, Release Checks, status semantics; `docs/guardrails.md` Verification Rules | Aggregate result referencing every applicable child eval and finding | Binary readiness prevents partial or static evidence from becoming a release claim. |

Current blockers:

1. Production implementation, deployment configuration, test harness and real provider/runtime evidence do not yet exist; `G-02`–`G-15` therefore have no release-passing evidence.
2. Candidate B is selected, but no Matrix-native rendered candidate or whole-design approval exists; `G-13` and `QA-VIS-001`–`QA-VIS-002` cannot yet pass.
3. A versioned sensitive-document classification policy is unresolved; production `G-03` is blocked if an implemented classifier has no confirmed policy basis.
4. Archive treatment after `Стоп`/`Нова задача`, selected archive/export encoding and deletion-receipt/retention contract remain unresolved for the affected `G-10` paths.
5. Exact runtime models, wrapping-key/retry configuration and provider-confirmed monetary usage are not selected/evidenced; A2A v0.3.0 is selected but not deployed; affected `G-05`, `G-06`, `G-08`, `G-10`, `G-11` and `G-14` cannot pass.
6. Current-client formatting, accessibility and delivery variance have not been verified on Mac, iPhone, Samsung Flip7/Android and Windows PC; `G-12` cannot pass.

`G-16` is not applicable in the current pre-approval phase and is not a present blocker. It becomes blocking immediately after whole-design approval, at which point this checklist must be regenerated.

blocked

## Open Questions

1. Which versioned classes define an `Особливо чутливий документ`? Until resolved, an uncertain document must request separate permission; production `G-03` cannot pass an ungrounded classifier.
2. What lifecycle/archive treatment applies after `Стоп` and to the previous Session after `Нова задача`? Cancellation/isolation can be tested now, but affected archive paths cannot pass `G-10` without this policy.
3. Which archive bundle/export encoding and content-free deletion receipt/tombstone policy preserve exact body/order and disclose provider retention honestly?
4. Which exact runtime configuration, A2A profile/serialization, key provider/crypto version and retry scheduler will be named in the environment fingerprint?
5. Which provider-confirmed usage source supplies monetary amount, currency and period for every runtime without substituting estimates?
6. What current-client variance exists for native formatting, long messages, text scaling, screen-reader order and delivery on Mac, iPhone, Samsung Flip7/Android and Windows PC?
7. Which managed homeserver passes bot policy, uptime, exact room-invariant and `m.federate: false` tests? `matrix.org` remains only the conditional PoC default.
8. After whole-design approval, what Baseline ID, immutable visual target hash, frozen artifact references, covered states/viewports, permitted variance and operator overrides does the approval receipt establish?

No open question authorizes a new user surface, custom Element/Matrix chrome, simulated agent, parallel Session, unsupported attachment, hidden external action or premature approval claim.
