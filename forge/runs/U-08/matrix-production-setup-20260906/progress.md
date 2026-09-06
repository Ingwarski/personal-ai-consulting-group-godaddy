# Matrix production setup — bounded implementation evidence

Recorded: 2026-09-06T20:00:24Z. This is evidence recording time, not an invented user-message timestamp.

## Authority and scope

The user authorized the existing application's production Matrix setup in `forge/matrix-production-setup-authorization-20260906.json`. This adds setup-only functionality needed by the already authorized Matrix consultation connection; it does not declare Product V1 or the full development plan complete. Canonical development-plan and approved design bytes were not changed.

## Implemented and locally checked

- Immutable source-bound Linux/musl build and packaging workflow, with two clean byte-compared builds and manifest/artifact hashes. No runtime compilation, mutable download, production secrets, or paid service added.
- Owner-session, same-origin and purpose-CSRF protected `/operations/matrix` setup page and action endpoint. Published must explicitly enable `MATRIX_SETUP_MODE=provision`; consultation workers remain stopped during setup. Preview cannot start setup.
- Exact pinned bundle installation into private directories, no-follow ownership/mode/hash checks, and separate Published/Preview HTTP-isolation checks before a credential-bearing child may start. Existing state is not overwritten.
- Bounded native setup subprocess, strict status parsing and secret-free error vocabulary; device verification remains an explicit human comparison. A final response arriving after process exit but before stdout close is no longer discarded.
- Recovery of the precise interrupted fresh-provisioning state requires the existing matching private intent and known snapshot. Wrong passphrases, identities, bindings or unknown state remain quarantined. SQLite pools are closed before inventory; neither keys nor state are reset.
- Both cross-signing subkeys remain required; the unused private master key is no longer unnecessarily required. Verified identities and final room policy remain enforced.
- Browser-discovered named-control collision fixed: a hidden `action` field no longer shadows the form's destination URL. The browser fixture reproduces native form-property shadowing in regression tests.
- Asynchronous consultation tests now await durable completion and worker idleness with a monotonic deadline, rather than a fixed count of event-loop turns. The real delayed-WebCrypto regression is retained.

## Verification and limits

- `npm run check`, Node 22.23.2: passed; build, typecheck, 745 tests, forbidden-runtime-environment check.
- Native all-target tests: 93 passed; Clippy with warnings denied and formatting check passed.
- `git diff --check`: passed.
- Real in-app browser, synthetic loopback-only setup fixture: rendered device/SAS information, keyboard submission, DOM replacement and focus return to heading verified. Initial form destination failure reproduced before repair, and the same action passed after repair. No real credential, Matrix session, or trust action was used. This is not live E2EE proof or full accessibility acceptance.
- First GitHub Linux run `34055863579`, source `077c4d797cbedd47c001aff3997ce40298dd0c44`: failed three timing-sensitive Node tests before the Rust build. It is not a release artifact. The timing repair is included in the subsequent candidate.
- Replacement run [34056704369](https://github.com/Ingwarski/personal-ai-consulting-group-godaddy/actions/runs/34056704369), source `ca68054232227788194d2d5e13a8a5beb4724da4`: Linux Node verification passed; immutable Rust build in progress at this observation. No successful artifact or digest is claimed yet. The setup source and tests are committed and pushed on `codex/matrix-connection-20260906`.
- SDD `--before implementation`: 13 artifacts checked, passed with no issues or warnings. This metadata/integrity result does not convert unrun live or full-product checks into passes.
- Matrix.org's public login discovery currently advertises `m.login.password`, SSO and token login. No credential-bearing login request was made.

## Still required before operation

1. Successful immutable Linux build; authenticate its GitHub run/artifact identity and verify every file before adding the real release pin. The pin is intentionally unset until then.
2. Scoped Published setup deployment and live directory-isolation check.
3. User-only credential entry and access to the bot's existing trusted Element session or recovery material; explicit device-code comparison. Keep existing devices, room, messages and crypto state.
4. Confirm `joined` room history visibility, final native policy, disable setup mode, publish normal workers, and observe one harmless message through consultation, Critic review and encrypted delivery.

Current live-tool handoff: opening the existing Element application returned that the Mac is locked and automatic unlock failed. The user has been asked to unlock it and identify whether the existing bot session or recovery material is available, without sending any credentials. This is a new current lock observation, not a claim that the earlier historical lock persisted unchanged.

No production deployment, room change, token creation, database change, crypto reset, or delivered live consultation is claimed by this record. Other repository and domain boundaries remain unchanged. Full release checks and previously unrun QA remain unrun.
