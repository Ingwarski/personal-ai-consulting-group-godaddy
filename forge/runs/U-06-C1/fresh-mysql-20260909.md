# Explicit fresh MySQL setup — 2026-09-09

User authorized discarding missing test state and implementing fresh initialization. No existing data is deleted by this change.

## Behavior

- Published owner setup exposes an explicit new-device action after pinned binary preparation.
- Rust permits fresh MySQL creation only through setup, never ordinary runtime startup.
- Before provisioning, Matrix whoami must match configured bot/device and the device must have no published encryption keys. Existing Element/device tokens cannot be reused to overwrite keys.
- Schema provisioning is additive. Namespace insertion is create-only; existing or partially initialized namespaces are rejected, not overwritten.
- The SDK creates and persists its account directly through MySQL. A new committed cursor is initialized and the account identity is checked before atomic activation of its binding and fingerprint.
- Existing-store resume, device verification, owner authorization, private temporary files and normal runtime gates remain in place.

## Evidence

- SDD before-implementation checker passed.
- Node build/typecheck/tests/environment check: 934 passed, zero failures/skips.
- Rust cargo check (locked, offline, Rust 1.93.0): passed.
- Rust library tests: 97 passed, zero failures, 10 ignored integration tests. These are not live MySQL or Published evidence.
- Strict Clippy attempted; blocked by existing collapsible-if warnings in mysql-store legacy_crypto.rs/state.rs. No broad unrelated lint rewrite performed.

## Remaining release/operational work

New Linux setup binary must be built and promoted with updated release pins before this source change is operational. Existing packaged binary does not support this feature.

Use a newly issued dedicated bot session/device and its token, not the old device whose keys were lost. Configure Published MySQL backend, new executable path/hash and provision setup mode; then prepare, explicitly initialize and verify the device. No unrelated database wipe is needed.

Failures after namespace creation remain inactive and fail closed; they are not automatically erased or retried as an empty identity. Successful initialization resumes through the existing-store action. End-to-end fresh initialization and restart persistence still require Published verification.
