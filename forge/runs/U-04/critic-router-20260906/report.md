# Critic router — implementation report

Code revision: `dd37e418bfec388215ef78c83958880f01128bec`.

## Implemented

- Explicit **Claude Code / Codex** Critic selector with independent model and effort. Switching preserves each branch's preferences; it never changes the head/specialists or autosaves.
- GPT-6 Astra / Extra High support. The pinned Codex CLI is now `0.153.1`; discovery includes paginated hidden metadata for the explicitly requested Astra. A successful exact Astra/xhigh subscription probe is required before marking it available. No provider/model fallback.
- Codex-only catalog refresh, readiness and execution do not inspect, call or wait for Claude. Protected saved-settings recovery remains available when the catalog is missing or expired.
- Strict v3 settings with atomic legacy migration, preserved Claude choices, CAS/idempotency semantics and immutable historical snapshots. Unsupported legacy effort remains visibly incompatible.
- A separate Critic context uses its own model/effort and lease. The production application execution entry calls the runner and launcher using the Registrar's frozen snapshot and the shared managed-OAuth connection.
- Designated identity-bound critique receipts protect finalization. A head, specialist, forged role, changed runtime or old-generation critique cannot unlock a final recommendation. MySQL outbox validation preserves these fingerprints.
- Cancellation, late replies, partial startup, timeouts and unresponsive-process cleanup are covered. Concurrent initialization shares one handshake; owned child termination and directory cleanup were tested with a real local subprocess.

## Verification

- **597/597 tests** on Node.js **22.23.2**; build, typecheck, environment policy and diff checks passed.
- **27 real Chromium fixture checks**, including persistence, provider switching, focus, unavailable states and 320–1440px reflow. Screenshots inspected.
- The exact native `0.153.1` CLI accepted environment-disabled analysis configuration without credentials or a model turn. Its generated schema confirms the supported fields. The unsupported `readOnly.access` draft was removed; the implementation uses `environments: []`, supported read-only/network policy and disabled external-tool channels.
- Browser and provider/DB simulation evidence is explicitly local. The native protocol check does **not** prove subscription entitlement or Linux/GoDaddy enforcement.

## Not claimed or changed

This change is **not published or live-verified on GoDaddy**. Actual Astra/xhigh entitlement still needs the owner-operated Codex refresh there. Claude live verification remains unrun with the reported expired subscription.

The application execution entry handles an already-authorized active generation. The broader Matrix intake/consent/media dispatcher, approved numeric speed policy and full Matrix-to-archive journey remain separate outstanding work; this change does not secretly enable or certify them.

No HappyPro, domain, Google credential/session implementation, database schema/wipe, Matrix room/device, stateful Preview or frozen design changes. No new Unit acceptance or full security/usability/release gate is claimed.

The SDD workflow kept the current plan/baseline and separate implementation authorization binding. The promotion receipt is derived from actual Git bytes; its full-fidelity status remains blocked, including the recorded late promotion-index registration limitation. Historical receipts were preserved unchanged.

Relevant source: [Codex 0.153.1 release](https://github.com/openai/codex/releases/tag/rust-v0.153.1), [pinned tool registration](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/core/src/tools/spec_plan.rs).
