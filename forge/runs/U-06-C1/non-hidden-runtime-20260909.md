# U-06-C1 non-hidden runtime correction — 2026-09-09

## Scope

Explicit user authorization: implement the non-hidden runtime approach. Treat GoDaddy removing hidden directories as an operating assumption, not a proven provider behavior. This corrects the existing U-06-C1 implementation without changing its approved design.

## Implemented

- Move the unchanged pinned Linux bundle from `.runtime-release/matrix` to `runtime-release/matrix`.
- Install verified executable copies under `runtime/matrix`, outside `public`, with private directory permissions and read/execute-only executable permissions.
- Automatically prepare that runtime before MySQL-backed service startup, after confirming the existing database identity. Reject mismatched paths, hashes or invalid bundles before spawning.
- Deny HTTP access to both new and former runtime path prefixes, including encoded paths, before application handlers.
- Restore Codex vault credentials into a private temporary `codex-home` rather than `.codex`; remove it on close. Claude already uses non-hidden temporary configuration.
- Preserve legacy recovery paths and existing data. No device creation, reset, schema activation, production secret changes or deployment was performed.

Durable Matrix state remains the MySQL adapter's responsibility; runtime directories are reconstructable, not backups. Secrets retain encryption keys. Renaming directories does not recover missing old encryption state.

## Verification

- `npm run check`: build, typecheck, 933 tests passed, zero failures/skips, environment policy passed.
- `git diff --check`: passed.
- SDD `sdd_check.py --project . --before implementation`: passed using the bundled supported Python interpreter.
- Actual pinned bundle prepared and inspected in an isolated temporary fixture, then reconstructed after deleting disposable runtime; checks passed without executing Linux binaries on macOS.
- Synthetic tests cover repeated reconstruction, refusal of hidden-bundle fallback, permissions, invalid-release startup rejection, fresh Codex credential homes and HTTP denial.
- Rust source and binary bytes unchanged; no new native build or real database test was necessary for these path/startup changes.

## Deployment boundary

Not verified on Published: provider routing, restart/redeployment recovery, or migration of the missing original state. Do not mark the production consultation operational from local results.

When deploying the MySQL-backed configuration, the executable settings are:

```dotenv
MATRIX_SIDECAR_PATH=/app/runtime/matrix/personal-consultant-matrix-sidecar
MATRIX_SIDECAR_SHA256=08e414426e03fd0eb36601108126a4ddd570f496cfcd1c538f804a9105354966
```

`MATRIX_STORE_BACKEND=mysql` requires the existing identity to be validly migrated and activated first. Preserve existing passphrases and credentials. Do not switch the backend merely to bypass a missing-binding error.

This removes active hidden runtime layout dependencies; it does not claim dependencies never generate dotfiles. Legacy recovery locations intentionally remain supported.
