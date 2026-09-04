# G-00 Published Rust storage gate

## Purpose

Resolve the remaining GoDaddy-specific Matrix crypto feasibility question with
synthetic data only. This gate is temporary production-host verification, not a
Matrix bot, room, identity, session or product feature.

## Fixed safety boundary

- Runs only when `RUNTIME_MODE=production` and
  `GODADDY_STATE_DATABASE_ROLE=published` already identify the Published app.
- Has no HTTP control route and does not change the application UI.
- Imports no MySQL adapter and performs no database query or schema operation.
- Uses the checksum-pinned x86-64 musl artifact previously verified in Preview.
- Owns exactly `/public/assets/godaddy-rust-matrix-probe-v1`.
- Uses only a public synthetic test passphrase and no Matrix account, token,
  recovery key, room, message, user data or subscription credential.
- Emits one bounded `G00_PUBLISHED_RUST_STORAGE_GATE` JSON log line without a
  filesystem path, secret, credential or content payload.

## Pass sequence

1. Publish deployment marker `published-g00-a` and require a passing receipt
   with `store_created`, `store_reopened`, `wrong_key_rejected`, `matrix_https`,
   `binary_verified` and `lock_contention` all true.
2. Request the exact synthetic marker URL at both candidate public roots and
   require HTTP 404 with no marker bytes:
   - `/assets/godaddy-rust-matrix-probe-v1/probe-receipt.json`
   - `/public/assets/godaddy-rust-matrix-probe-v1/probe-receipt.json`
3. Restart Published without changing the marker and require
   `survived_restart=true`.
4. Publish a second commit containing marker `published-g00-b` and require
   `survived_redeploy=true`.
5. Publish the exact cleanup operation and require `removed=true`.
6. Retire the gate source, artifact and startup hook, publish that clean commit,
   and require the ordinary `/healthz` response plus 404 at the two candidate
   marker URLs.

Any missing or malformed receipt, non-404 marker response, restart/redeploy
failure or cleanup failure is a no-go. It must not be worked around with MySQL,
a public download route or real Matrix credentials.

## Result — passed and retired on 04.09.2026

| Check | Published evidence |
| --- | --- |
| Initial boot (`e72e7bc`) | `ok=true`, `store_created=true`, `store_reopened=true`, `wrong_key_rejected=true`, `matrix_https=true`, `binary_verified=true`, `lock_contention=true` |
| Public retrieval | Both candidate marker URLs returned HTTP 404 and the ordinary `not_found` body |
| Published restart | `store_created=false`, `survived_restart=true` under marker `published-g00-a` |
| Source redeploy (`cb6dd38`) | `store_created=false`, `survived_restart=true`, `survived_redeploy=true` under marker `published-g00-b` |
| Exact cleanup (`c70f1e4`) | `phase=cleanup`, `ok=true`, `removed=true` |

The result proves the GoDaddy host capability needed by the selected design:
one Published Node 22 process can launch and stop a checksum-pinned static Rust
child, while an encrypted Matrix SDK SQLite store in the provider-designated
persistent path stays private at the tested HTTP roots and survives restart and
redeploy. It does not claim that a real Matrix identity, room, sync loop,
credential or delivery flow exists. The temporary gate source, artifact and
startup hook were removed after the cleanup receipt.
