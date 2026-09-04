# G-00 feasibility receipt — 03–04.09.2026

## Scope

This receipt records non-destructive verification of the existing GoDaddy
Node.js app `wy2v0putg6`. The 04.09.2026 update adds the current Preview
deployment, read-only schema metadata and the retired Rust Matrix capability
gate. It does not authorize legacy cleanup, secret rotation, database
import/export, schema mutation, domain changes or a HappyPro repository action.

## Redacted environment inventory

| Item | Observed result |
| --- | --- |
| Provider application | GoDaddy Node.js app `wy2v0putg6` (`Personal AI Consulting Group`) |
| Published storage-gate lineage | Initial `e72e7bc`, redeploy marker `cb6dd38`, cleanup `c70f1e4` |
| Published runtime | Node.js 22, Europe region |
| Published status | GoDaddy dashboard reported infrastructure and site status as operational |
| Database resource | One GoDaddy hosted MySQL resource |
| Database variant boundary | GoDaddy states that Preview and Published use the same database |
| Secret handling observed | The dashboard labels values encrypted and runtime-only; no value was viewed, copied or recorded |

## Controlled Published restart

1. Before the restart, `GET /healthz` returned HTTP 200 with the Node runtime
   readiness response.
2. The Published restart control was invoked in the GoDaddy dashboard.
3. GoDaddy returned the success notice: Published application restarted.
4. Immediately after that notice, `GET https://wy2v0putg6.c35.airoapp.ai/healthz`
   returned HTTP 200 with `cache-control: no-store` and the expected Node 22
   readiness response.

This proves the narrow Node build/start/`PORT`/health/restart contract for the
Published revision above. It does not prove persistence of product state,
rollback, a backup or any untested provider capability.

## Provider documentation check

GoDaddy's [Node.js Hosting deployment guide](https://www.godaddy.com/en-uk/help/deploy-my-cursor-or-claude-app-with-godaddy-nodejs-hosting-42908)
explicitly directs applications that need files to persist between deployments
to write them under `/public/assets/`. Its
[Node.js Hosting launch reference](https://www.godaddy.com/resources/ca/news/godaddy-nodejs-hosting-launch)
describes Published as a real persistent Node.js 22 process rather than a
serverless invocation. The
[Node.js Hosting FAQ](https://www.godaddy.com/en-ph/help/godaddy-nodejs-hosting-faq-42915)
also requires a top-level `package.json`, a build command, a start command,
runtime packages in `dependencies`, and listening on the assigned `PORT`. Its
[Node.js Hosting concepts](https://developer.godaddy.com/en/docs/api-users/concepts/nodejs-hosting-concepts)
document separate Preview and Published variants, per-variant secret metadata,
and deployment/status polling. Those facts support the narrow runtime result
above.

The official materials establish a provider-designated durable path and a
persistent Published Node process. Public-path isolation and native child
execution were then checked on the actual Published app as recorded below.
GoDaddy's public documentation still does not establish cryptographic key
custody, database isolation or a backup-and-isolated-restore workflow; those
remain separate design and recovery obligations.

## Matrix readiness and runtime boundary

On 03.09.2026 the Owner confirmed the Matrix owner setup is ready. Per the
setup contract, this is limited to a `matrix.org` owner account, Secure Backup,
and one verified Mac device. No Matrix ID, recovery key, password, access token,
bot account, or room identifier was collected or recorded.

The current Node app has no Matrix client dependency or startup path. The
official [Matrix JavaScript SDK](https://github.com/matrix-org/matrix-js-sdk)
states that Node E2EE without a persistent store creates a new device after a
restart. The official
[`matrix-sdk-crypto-nodejs` binding](https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs/blob/main/src/machine.rs)
persists crypto state through an encrypted SQLite store at a filesystem path.
GoDaddy documents `/public/assets/` as its persistence location, while the
Git-connected Files surface remains read-only. The Published check below proved
that the selected exact subdirectory survives restart and redeploy without
becoming retrievable at either tested public URL root.

A prior Preview-only probe showed that a Node-native Matrix binding was an
unsupported production direction on this Node 22 host. It did not create a
Matrix account, room, credential, user record or application database state.

Earlier on 04.09.2026, a separate, content-free static Rust `matrix-sdk` 0.18.0 musl
binary passed a narrow Preview feasibility gate: verified binary identity,
encrypted SQLite create/reopen, wrong-passphrase rejection, Matrix HTTPS request
construction, exclusive-store locking, and synthetic-store persistence through
Preview restart and source redeploy. The temporary route, synthetic directory,
workflow and artifact were then removed; the current Preview commit above
returns `404` for that route. This proves only the native-crypto sidecar
capability.

## Published Rust Matrix storage and process gate

On 04.09.2026 the same checksum-pinned static artifact was exercised through a
temporary startup-only Published gate with no HTTP control route. It used no
Matrix account, room, token, recovery key, message, subscription credential or
MySQL call.

1. Published commit `e72e7bc` emitted a passing receipt for binary integrity,
   Node child-process supervision, exclusive lock contention, encrypted SQLite
   create/reopen, wrong-passphrase rejection and Matrix HTTPS.
2. The exact marker returned HTTP 404 with the normal `not_found` response at
   both `/assets/godaddy-rust-matrix-probe-v1/probe-receipt.json` and
   `/public/assets/godaddy-rust-matrix-probe-v1/probe-receipt.json` while the
   store was known to exist.
3. A dashboard Published restart emitted `store_created=false` and
   `survived_restart=true` under marker `published-g00-a`.
4. Published redeploy commit `cb6dd38` emitted `store_created=false`,
   `survived_restart=true` and `survived_redeploy=true` under marker
   `published-g00-b`.
5. Published cleanup commit `c70f1e4` emitted `phase=cleanup`, `ok=true` and
   `removed=true` for the one fixed synthetic directory.

This passes the GoDaddy-specific process/durable-private-path feasibility gate
for a future Node-supervised Rust Matrix crypto sidecar. It does not prove a
real long-running sync loop, Matrix identity, private room, verified device,
credential custody or delivery semantics. Those remain controlled integration
work, not hosting-capability uncertainty.

## Preview safety decision

The provider's shared-MySQL statement means Preview is not an isolated
persistence environment. The Node adapter therefore retains the existing
fail-closed boundary: storage requires the exact Published state role, and
Preview must remain stateless. Shared tables, a different app variant, or a
dashboard table list are not database isolation.

No Preview *product* state was created or inspected during this verification.
The temporary Rust gate created only its fixed synthetic encrypted store and
removed it after the receipt. No database row, schema object, export or import
was changed.

## Read-only database and recovery inventory

On 04.09.2026, the GoDaddy read-only table browser returned exactly three base
tables in the shared hosted database:

| Table | Read-only schema metadata |
| --- | --- |
| `personal_consultant_state` | `state_namespace`, `state_key` (composite primary key), `state_value`, `updated_at` |
| `personal_consultant_archives` | `archive_id` (primary key), `lifecycle`, `created_at`, `manifest`, `iv_base64`, `ciphertext_base64` |
| `personal_consultant_archive_tombstones` | `archive_id` (primary key), `deleted_at`, `plaintext_sha256` |

No table data was opened. The current visible schema metadata is:

| Table | Column metadata |
| --- | --- |
| `personal_consultant_state` | `state_namespace varchar(64)`, `state_key varchar(191)` (composite primary key), `state_value json`, `updated_at timestamp(6)` |
| `personal_consultant_archives` | `archive_id varchar(196)` (primary key), `lifecycle enum('staged','committed')`, `created_at varchar(64)`, `manifest json`, `iv_base64 varchar(32)`, `ciphertext_base64 longtext` |
| `personal_consultant_archive_tombstones` | `archive_id varchar(196)` (primary key), `deleted_at varchar(64)`, `plaintext_sha256 char(64)` |

The browser still does not provide the needed metadata-only catalog of views,
triggers, events, object sizes, row counts or privileges. No secret, export,
import or schema mutation was read or performed.

The isolated repository's historical migration record establishes that legacy
HappyPro persistence used `happypro_access_store`, including certificate PDF
payload and integrity-digest evidence. It does not map that historical runtime
to the currently attached GoDaddy database. The current three-table inventory
therefore cannot prove that the old state was recovered, absent, or exclusive
to this app.

Exporting the currently attached database would only create a backup of this
unreconciled current state, not a recovery backup of the historical HappyPro
state. No export or restore was performed, because no isolated recovery target
has been evidenced.

## G-00 result: Matrix host gate passed; destructive migration still blocked

The Node runtime/restart contract and the Published Rust crypto host subgate are
verified. G-00 is still incomplete for destructive migration, and no legacy
deletion is eligible. The following evidence is still required:

1. A content-free deployed-app-to-database mapping, reconciliation of the
   historic `happypro_access_store` evidence, an encrypted backup, and an
   isolated restore/reconciliation drill.
2. The production sidecar implementation and controlled real-Matrix evidence
   must retain isolated subscription OAuth credentials, bounded private IPC,
   outbound-network policy and application-encrypted archive storage.
3. An action-time destructive manifest naming the exact legacy source routing,
   each secret entry, database-object allowlist, upstream revoke/rotate steps,
   post-action absence checks, and a fresh owner confirmation.

Until those gates are evidenced, preserve the legacy source and all secrets and
database state. No later unit may be represented as a production cutover or
destructive migration claim.

## Recovery boundary

The shared Preview/Published database makes it unsuitable as an isolated restore
target. Exporting it now would create a backup only of the unreconciled current
state, not proof of historical HappyPro recovery. No export or restore was
performed. A future backup/restore drill requires a separate owner-approved
encrypted-backup custody mechanism and an independently isolated recovery
target; it must precede any legacy wipe, source deletion, secret deletion or
database mutation.
