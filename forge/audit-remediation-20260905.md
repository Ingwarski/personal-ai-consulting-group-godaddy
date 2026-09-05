# Audit remediation — 5 September 2026

Status: seven code defects repaired and locally verified; SDD reconciliation awaits the Owner's authentication decision. Linux Node 22 verification passed; Linux Rust/musl verification is still running as of 2026-09-05T02:04:57Z. This is not a release approval or a replacement development plan.

Scope: repair the audited implementation and provenance defects. No U08 work, production deployment, credential change, live Matrix/database mutation, destructive cleanup, or HappyPro change is authorized by this remediation.

## Fix-by-fix record

| Finding | Change | Verification and limit |
|---|---|---|
| Malformed HTTP requests or failed response streams could escape the listener and terminate service | Reject invalid request targets with 400; catch asynchronous request failures; wait for response-body work before considering requests idle | Raw TCP malformed-target regressions, successful subsequent health request, failed stream and delayed-body tests pass on Node 22.16.0. Not a live GoDaddy proxy test |
| Transcript reads could exhaust the bounded MySQL pool queue | Read ordered transcript rows sequentially within the existing transaction instead of launching one query per message | Actual mysql2 queue fixture: 128 messages alongside 32 competing reads with four connections. No live DB used |
| A lost Matrix send response could permanently stop recovery or release an uncertain lease | Keep the supervisor and reconciliation loop running; retain the fence on ambiguous acceptance; retry the same deterministic transaction ID | Lost-acceptance → recovery → transient failure → success regression; no duplicate visible event in the fixture. Live Matrix acceptance/restart test remains unrun |
| The lifetime frame cap could kill a healthy long-running sidecar | Planned authenticated generation rollover before the defensive cap, with drain/exit checks and unACKed ingress replay | 7,000 requests across multiple generations, replay protection, failed drain, stale response and explicit-stop regressions pass. Replay memory remains bounded |
| Permanently invalid encrypted media could poison sync indefinitely | Distinguish invalid media from retryable transport/storage errors; persist a content-free rejection before cursor advancement; preserve explicit rejection reason across Rust and Node | Shared invalid-media fixture, durable rejection/reopen/replay checks, and a following valid text event. Full homeserver E2EE media round trip remains unrun |
| Cached Matrix policy could authorize a send after room/device policy changed | Fresh bounded room/directory/device checks; transient lookup failures retry instead of terminal denial; serialize SDK state updates against checked encryption/member/history state and the complete send; explicitly restrict keys to trusted devices | All five real pinned-SDK/mock HTTP regressions pass, including stale third member, unencrypted-cache negative control, and an in-flight encrypted send versus concurrent sync. Rust suite 83/83, format and Clippy pass. These tests isolate the cache boundary; they are not live cross-signing/E2EE acceptance |
| Owner authentication did not meet its persistence, revocation, throttling and expiry contract | Persist hashed challenge/session records in an isolated existing MySQL namespace; atomic one-use challenges; throttling across fresh forms/restarts; idle and absolute expiry; logout and credential-generation revocation | Node 22 regressions include restart, replay, logout, credential rotation, concurrent attempts, throttled bursts, and expiry while waiting for DB. No schema migration. Deployment requires a fresh owner sign-in because old cookies are intentionally invalid |
| Tests ran on a different Node version and Linux packaging was only planned | Run the complete suite on official, checksum-verified Node 22.16.0; add credential-free Linux Node 22 and static musl tests to the non-deployable workflow | Node suite: 360/360 plus TypeScript/build and environment policy pass on both macOS arm64 and Linux x86_64. Linux Rust build/tests are still in progress; see `linux-remediation-evidence-20260905.json` |
| Plan, requirements and progress metadata contradicted implementation/history | Product-idea and PRD owner corrections restore separate provider settings and version/order requirements; preserve superseded requirements and the original receipt; invalidate unsupported exact-plan authorization and premature next-unit progression | Original user prompt predates the exact plan it purportedly approved. Evidence is in `authorization-correction-20260905.json`. PRD checker intentionally blocks on the existing MFA decision; downstream owner reconciliation is pending |

## Required before the next unit

1. Resolve the existing password-only/MFA requirement conflict through the Owner; then reconcile the remaining affected SDD documents in owner/dependency order. The current request is authority to repair defects, not retroactive approval of a later plan.
2. Finish actual Linux/musl verification; host Rust regressions now pass 83/83, with format and Clippy clean. Preserve the distinction between host tests, target-artifact evidence, and live integration.
3. Do not treat U06 as product-accepted until separately authorized final-path non-retrievability, real Matrix encrypted send/receive/recovery, and applicable MySQL integration checks pass. No credentials may be provisioned merely because local tests are green.

The exact GoDaddy persistent crypto/spool paths are inside `public/assets/.personal-consultant-matrix-v1`, while the architecture still describes storage outside public output. No leak has been demonstrated here. This contradiction and the exact-path non-retrievability gate remain open; a retired synthetic host probe does not settle them.

## Verification discipline

Focused regressions run during patching; an integrated gate runs against final source. Early checkpoints are explicitly superseded after source changes. No production result, security compliance, approval timestamp, or historical owner invocation is reconstructed from a passing test suite.

Changes are isolated on `codex/audit-remediation-20260905`, not the connected `main` or `staging` branches. Any CI artifact is marked NON-DEPLOYABLE.

Code revision: `6ec608a1ff9617cf9fd5e6f49c2d4f12f66d7b77`. Evidence: `node22-remediation-evidence-20260905.json`, `rust-remediation-evidence-20260905.json`, and `linux-remediation-evidence-20260905.json`. The local macOS release build passed but is not a Linux deployment artifact.

At the pause, the PRD post-check and full SDD audit correctly return blocked. Eleven downstream artifacts are explicitly invalidated pending their owner reconciliation; their prior source hashes and invocation records are preserved. No current full-unit acceptance or U08 progression is claimed. The existing frozen design and original approval/implementation receipts are unchanged.
