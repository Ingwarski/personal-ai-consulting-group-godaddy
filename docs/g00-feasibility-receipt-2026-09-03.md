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
| Current Preview source | Git `main`, commit `93de2a1b02d7673d1343bcbf52d8ae812e477331` |
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

GoDaddy's [Node.js Hosting FAQ](https://www.godaddy.com/en-ph/help/godaddy-nodejs-hosting-faq-42915)
requires a top-level `package.json`, a build command, a start command, runtime
packages in `dependencies`, and listening on the assigned `PORT`. Its
[Node.js Hosting concepts](https://developer.godaddy.com/en/docs/api-users/concepts/nodejs-hosting-concepts)
document separate Preview and Published variants, per-variant secret metadata,
and deployment/status polling. Those facts support the narrow runtime result
above.

The consulted official materials do not provide a contract for a private,
durable filesystem; process isolation; child-process or native-dependency
support; egress policy; cryptographic key custody; database isolation; or a
backup-and-isolated-restore workflow. Absence of those guarantees is not proof
that they are impossible, but it is insufficient evidence for the retained V1
invariants.

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
GoDaddy currently provides no verified durable writable filesystem contract for
that store, and the Git-connected Files surface is read-only. Creating a bot or
private E2EE room before resolving this would produce an unsafe, non-restart-safe
runtime rather than an integration result.

A prior Preview-only probe showed that a Node-native Matrix binding was an
unsupported production direction on this Node 22 host. It did not create a
Matrix account, room, credential, user record or application database state.

On 04.09.2026, a separate, content-free static Rust `matrix-sdk` 0.18.0 musl
binary passed a narrow Preview feasibility gate: verified binary identity,
encrypted SQLite create/reopen, wrong-passphrase rejection, Matrix HTTPS request
construction, exclusive-store locking, and synthetic-store persistence through
Preview restart and source redeploy. The temporary route, synthetic directory,
workflow and artifact were then removed; the current Preview commit above
returns `404` for that route. This proves only the native-crypto sidecar
capability. It does not prove a Published supervisor, long-running sync loop,
real Matrix device or room, credential custody, or delivery semantics.

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

## G-00 result: documented no-go for destructive migration

The Node runtime/restart contract and the Preview-only Rust crypto capability
subgate are verified, but G-00 is not complete and no destructive action is
eligible. The following evidence is still required:

1. A content-free deployed-app-to-database mapping, reconciliation of the
   historic `happypro_access_store` evidence, an encrypted backup, and an
   isolated restore/reconciliation drill.
2. A provider-supported Published process-supervision, durable-path and
   recovery design for the Rust Matrix sidecar; isolated subscription OAuth
   credentials; outbound-network policy; and application-encrypted archive
   storage across restart.
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
