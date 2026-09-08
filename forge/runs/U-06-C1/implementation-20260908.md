# U-06-C1 implementation evidence — 2026-09-08

Status: local implementation and isolated verification; **unit open, Published acceptance not run**.

Authority: `forge/implementation-prompt-U-06-C1-20260908.json`, later explicit user instruction after the validated plan. Plan SHA-256: `cc9025beb72c6aed349246995126723ae235f9af84dfa951994689c258fbf144`. Starting source commit: `bf514b1`; the implementation is bound to the Git commit containing this report, not the historical Published revision. No frozen design files or formal product requirements were rewritten. The pipeline skill preserved the implementation/cutover boundary; the UX skill guided only the existing Matrix utility panel's recovery text and controls.

## Implemented

1. Pinned SDK 0.18 direct Rust MySQL crypto/state stores, four dedicated additive tables, AEAD records, strict TLS identity verification, existing secrets, database-time leases and transaction fencing. Runtime opening never provisions a schema/account or substitutes SQLite.
2. Durable pending ingress, rejection/ACK tombstones, authoritative sync cursor and encrypted chunked pending media. Lost/unknown database outcomes discard the SDK instance. Transient errors retry; corrupt identity/records and schema failures remain blocked.
3. Immutable pinned-schema SQLite import, original identity validation, complete destination inventory digest, read-back, interrupted candidate retry, and explicit activation. Missing original keys cannot be repaired by this implementation. Candidate provisioning freezes legacy startup; activation reimports/revalidates the frozen source while retaining the same source lock through cutover.
4. Explicit Node child environment and per-boot private media staging. MySQL setup checks pinned programs and the existing migrated device; it does not offer new-device provisioning or the obsolete timed Preview folder ceremony. Existing legacy files are retained, not declared safe or deleted.
5. Automatic current-model capability revalidation after expiry, single-flight with failed-probe cooldown. Saved selections/defaults and inactive provider evidence are preserved; no new login, provider fallback or paid acceleration. Dead Codex subprocesses can relaunch from their existing encrypted credential vault.
6. Migration operator commands, isolated MySQL harness and regression tests. Release verification includes the new workspace library and accepts only that exact in-tree source-bound crate in the dependency inventory.

## Observed local evidence

These are observed execution results in this task, not merely prepared tests. Tool output remains in the task; full raw streams are not duplicated into this document.

| Check | Result and scope |
|---|---|
| `sdd_check.py --project . --before implementation` | Passed; no issues/warnings; validates declared artifact integrity and the current implementation gate, not product readiness. |
| `npm run check` | Final rerun: 928 tests passed, zero failed/skipped, plus build/typecheck/environment policy, including candidate-freeze and packaging changes. Node 24.16 locally; production Node 22 is a separate CI check. |
| MySQL store suite, feature `integration-tests`, `--include-ignored --test-threads=1` | 94 passed, zero failed/ignored: 76 SDK/library/import/classification, 14 backend contracts, four fault tests. |
| Full sidecar suite, `--include-ignored --test-threads=1` through the isolated harness | 117 passed, zero failed/ignored: 105 library, six executable, six media integration/local-negative tests. |
| Final cutover-race regression after full-suite review | Two focused Rust tests passed, zero ignored (one extends the existing full migration test). Changed sources and held writer locks reject activation; the same lock remains exclusive immediately before/after commit; source files remain unchanged; missing/relative/duplicate CLI source arguments reject before DB access. Execution: 69.45 seconds against isolated MySQL. Candidate NULL/fingerprint denial also passed five Node binding cases and the final full application suite. |
| Release packaging tests | 12 passed, zero skipped. Actual locally resolved Cargo graph also passed dependency evidence generation: 390 production/build packages, both exact application workspace crates recognized. This is not a Linux binary build. |
| Chrome synthetic setup screen | Desktop and 390×844 phone viewport inspected. Phone document/viewport widths both 390; buttons 48.39 and 72.39 px high; long Ukrainian label wraps, no horizontal overflow; keyboard focus has visible solid outline. No real user-task or assistive-technology claim. |
| Operator invalid invocation / diff checks | Invalid operation fails with content-free guidance; `node --check` and `git diff --check` passed. |

The database tests used generated synthetic identities/data in a separate loopback MySQL 8.0.35 process with its own private temporary datadir, generated database/user/password and TLS certificate/CA. Hostname verification was enabled; wrong CA rejected. Existing local or Published databases were not used. Test configuration/credentials are excluded from Git and this report.

Fault evidence includes a real killed database connection before commit, bounded lock-wait failure without partial writes, stale-writer fencing, closed-backend journal/media/cursor recovery, and a **test-hook-simulated lost response after a real commit** (not an observed network packet-loss experiment). Full migration rejects missing non-account records/media chunks, divergent sources and active reimport; repaired candidates require complete re-verification. The 20 MiB media roundtrip uses five encrypted chunks. Official SDK store contract tests execute against MySQL rather than only an in-memory fake.

## Remaining acceptance / operational boundary

- No production database/secret/app configuration, Matrix device, homeserver rule, pusher or deployment changed in this task. No HappyPro access or destructive cleanup.
- Before live cutover: verify exact Published DB certificate/hostname compatibility, pinned Linux candidate, usable original private store/key and an isolated restoration of that actual backup. Missing keys or incompatible TLS block cutover; no insecure fallback.
- Separately authorize the exact Published additive schema/import/activation. Activation must use the same frozen source paths; no legacy writer may remain running. Retained old files remain private and cannot be silently resumed or deleted.
- Verify actual homeserver pusher/rule registration and cold-process wake. Existing same-app wake code and unit tests are not proof of real homeserver delivery.
- On the same deployed source/binary/schema/device, with Settings closed: one Owner message → Head → specialists → selected Critic → one actual delivered result; repeat after restart, redeployment and temporary DB interruption, checking accepted-event and duplicate lineage. Only then evaluate QA-INT-019–024, QA-CNS-007/008/009/010 and applicable release gates as complete.
- The existing Astra contract requires an exact `xhigh` proof. Automatic renewal intentionally fails closed for another selected Astra effort rather than running an unselected effort. This limitation is not disguised as universal unattended model support.

No U-06-C1 completion or Product V1 readiness is asserted by the local tests, commit, push, or candidate build.
