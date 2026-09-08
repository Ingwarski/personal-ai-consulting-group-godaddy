# Matrix MySQL backend — U-06-C1

This crate implements the pinned Matrix SDK 0.18 `CryptoStore` and `StateStore`
traits directly against MySQL. The SDK encryption algorithms are unchanged.
Records, imported legacy lookup keys, pending ingress/ACKs, cursor and media are
application-encrypted. SDK event/media caches remain in memory. Local files are
private, disposable staging only in MySQL mode.

## Configuration and cutover boundary

The new selector is `MATRIX_STORE_BACKEND=mysql`. Existing `DB_HOST`, `DB_PORT`,
`DB_NAME`, `DB_USER`, `DB_PASSWORD` and `MATRIX_STORE_PASSPHRASE` are reused.
`DB_SSL_CA_FILE` is optional when the database certificate chains to an already
trusted CA. TLS verifies hostname and certificate; there is no plaintext or
accept-invalid-cert fallback. Actual GoDaddy TLS compatibility must be verified
before cutover. No additional owner secret is introduced.

`MATRIX_STORE_DIR` and `MATRIX_MEDIA_SPOOL_DIR` no longer need owner-managed
persistent folders in MySQL mode. Node creates a private per-boot temporary
spool and passes its exact path to Rust. Other Matrix identity, token, homeserver
and binary-pin configuration stays unchanged. Preview remains stateless.

Runtime startup **does not** create schema, provision an empty crypto account,
import data or activate a candidate. It requires an activated encrypted binding
and verifies the actual stored account/device key before SDK session restore.
One database-time lease fences every transaction. Loss of ownership or an
ambiguous commit requires discarding the SDK instance, not an in-memory retry.

## Explicit operations (not yet proof of Published acceptance)

Only run these after separately authorizing the target Published schema/cutover
and deploying the checksum-pinned release containing this implementation.
The operator wrapper checks the existing committed release manifest; it never
downloads a binary or bypasses the release pin.

1. Stop Matrix intake/setup and retain a verified, private backup of the exact
   old device. The two SQLite files must be standalone, checkpointed backups
   with no WAL/SHM/journal siblings. Retain the existing binding, cursor,
   in-flight checkpoint, pending/rejected journal, ACK tombstones and required
   media. Keep the original writer stopped until a cutover decision is made.
2. Provision the four additive application tables:
   `node --experimental-strip-types scripts/migrate-matrix-mysql.mjs schema`.
   This does not wipe, rename or alter unrelated tables.
3. Import the frozen private backup:
   `node --experimental-strip-types scripts/migrate-matrix-mysql.mjs import --source-store /absolute/private/backup/crypto-store --source-media /absolute/private/backup/media-spool`.
   Paths are examples to replace with the verified backup paths, not default
   production directories. Exact-source retries resume an inactive candidate;
   divergent sources or an already-active destination are refused.
   Provisioning that candidate freezes legacy authority: even an inactive
   registry row prevents a legacy worker from restarting. This does not stop
   an already-running old deployment; step 1 is still required.
4. Check the candidate receipt, SDK identity, counts, cursor/ACK replay and
   pending media. Complete isolated restart/restore proof before activation.
5. Activate explicitly:
   `node --experimental-strip-types scripts/migrate-matrix-mysql.mjs activate --source-store /absolute/private/backup/crypto-store --source-media /absolute/private/backup/media-spool`.
   Use the same frozen source and media as import. Activation revalidates their
   complete contents and the destination while holding the read-only source
   lock continuously through the activation commit; changed source is refused.
   Binding, migration receipt, public account fingerprint and active marker
   commit together. Missing original store/key is a blocker, not permission
   to create replacement keys.
6. Run Published with Settings closed. Verify one actual Owner message through
   consultation and Critic to one delivered response. Repeat after process
   restart, redeployment and temporary database interruption. Record exact
   source/binary/schema/device evidence and duplicate/accepted-event lineage.

After activation, compatible MySQL code rollback is possible; stale SQLite
rollback is rejected by Node starting at candidate provisioning, not just
activation. Retained legacy files must remain private. Their
deletion, a device replacement, or reverse migration is not an automatic cleanup
step and is not authorized by this implementation.

## Verification

Use `scripts/test-matrix-mysql-runtime.mjs` and its companion documentation for
an isolated real-MySQL runtime. The ordinary suite never uses production DB
credentials. Run SDK contract tests with `--features integration-tests` and
`--include-ignored`; ignored live-DB tests are not passed tests. Tests cover
crypto/state contracts, lease/fencing, atomicity, wrong key/context/tamper,
legacy codecs and immutable reads, ingress/ACK/cursor recovery, and media.
Injected lost-commit-response proof is labelled as a test hook, not an observed
real network packet loss. Local passes and a binary build are not Published
acceptance or a completed U-06-C1.
