# U-06-C1 — pinned Matrix SDK storage feasibility

Date: 2026-09-08. Read-only source investigation; no production service accessed or code changed. This document is implementation guidance, not a passing adapter or release receipt.

## Outcome

Direct MySQL storage is supported through custom `CryptoStore` and `StateStore` implementations. It is not an SDK configuration toggle. The pinned 0.18.0 traits declare **46 crypto methods and 42 state methods**, including lifecycle/default methods. A successful connection or account round-trip alone does not prove a correct implementation.

Replace the `.sqlite_store(...)` call in `native/matrix-sidecar/src/store.rs` with `.store_config(StoreConfig::new(cross_process_lock_config).crypto_store(crypto).state_store(state))`. Keep the existing encryption/trust configuration and `restore_session` unchanged. `StoreConfig` and the client builder accept custom stores without replacing Matrix encryption algorithms.

## Smallest complete storage design

- One Rust MySQL pool shared by both stores and the app-specific inbox/cursor store. Dedicated application-prefixed InnoDB tables, not modifications to Node-owned settings/job/registrar tables.
- A store registry row binds homeserver, user, device, schema version, encrypted cipher export and migration state. It must distinguish absent/new identity from established identity with missing records. No automatic recreation of an established missing account.
- A lease row has holder, expiry and monotonic fencing epoch. Every state-changing transaction locks/checks the lease row and epoch **inside that transaction** before changes. SDK `try_take_leased_lock` alone does not fence an already-running obsolete process. Avoid relying on a connection-scoped MySQL advisory lock across an arbitrary pool.
- Use encrypted record families with fixed binary hashed lookup keys and explicit secondary indexes for room/sender/type/order. Keep related updates in one transaction. SQL identifiers are static; values are bound parameters; binary IDs avoid collation/truncation problems.
- `save_changes` serializes/pickles all inputs before opening the transaction, then atomically applies them. Serialize concurrent crypto saves before the first pickle await, as SQLite does: concurrent mutable session pickles otherwise overwrite newer state.
- No successful return after a failed commit; no plaintext/keys in error messages. On ambiguous commit/disconnection, reconnect/reload durable state rather than continue with potentially divergent in-memory crypto state.

## Required semantics, not optional empty stubs

| Store | Coverage |
| --- | --- |
| Crypto identity | Account pending saves, private cross-signing identity, own device/static account data, tracked users, public user identities/device additions/changes/deletions |
| Crypto sessions | Olm sessions by sender key; inbound sessions by room/session and stable device batches; outbound room sessions; message-hash replay protection |
| Crypto backup/requests | Backup key/version/count/status, dehydration key, sent and unsent outgoing secret requests, secret inbox, withheld-room keys |
| Crypto room metadata | Room settings, received historical key bundles, pending-room bundle state, rooms with completed backup downloads |
| Crypto infrastructure | Custom values, lease contract, to-device next-batch token, lifecycle and size reporting |
| State sync | Typed KV including sync token; presence; normal/stripped state; room info; member profiles and deletion; membership indexes; display-name ambiguity; global/room account data; receipts; redactions |
| State durable operations | Custom values with previous-value return; room removal; ordered send queue and dependent queue CRUD/status; rooms with unsent requests; thread subscriptions with bump-stamp ordering |

The SDK tests exercise details such as stripped versus full state, redaction, receipt replacement, send ordering and backup flags. Delegating reads to an empty memory store or returning `Ok(())` for unsupported writes would falsely satisfy compilation while losing state.

## Public serialization seams

- `Account::pickle()` / `Account::from_pickle(...)`.
- `PrivateCrossSigningIdentity::pickle().await` / `from_pickle(...)`.
- `Session::pickle().await` / `Session::from_pickle(own_device_keys, pickle)`; loading the account/own device is a prerequisite.
- `InboundGroupSession::pickle().await` / `from_pickle(...)`.
- Outbound session pickle/unpickle APIs; retain own-device/account context required by the SDK implementation.
- Public device/identity/room/receipt/queue data types are serializable individually. `Changes`, `PendingChanges`, `StateChanges` themselves do **not** derive Serialize; do not assume a single `serde_json::to_vec(changes)` implements persistence.
- `matrix-sdk-store-encryption = "=0.18.0"` supplies `StoreCipher::{new, export_with_key, import_with_key, hash_key, encrypt_value, decrypt_value}`. Cipher export may live in MySQL encrypted under the existing external 32-byte store key; the external key must not live there.
- If using `StoreCipher`, include family/store/key/schema identity inside the encrypted payload and validate it on read, because its value API does not accept caller AAD. That prevents accepting a valid ciphertext transplanted into another record context.
- The SQLite `EncryptableStore` helper is **private**. Its value convention mixes MessagePack and JSON: outbound/withheld/raw JSON paths differ from other pickles. Do not blindly decode every SQLite value as JSON or every value as MessagePack.

## Event/media caches and app-specific durable data

`StoreConfig::new(...)` explicitly defaults event cache and media cache to memory. Keeping these defaults is a supported minimal approach **only when** event history is reconstructible and app-owned accepted work is durable independently. That avoids implementing another 17 event-cache and 14 media-store methods merely to persist disposable cache.

But these current files are not disposable SDK caches:

- `ingress.rs`: `pending-ingress`, `rejected-ingress`, `ingress-ack-tombstones`, durable ordering and receipt identity.
- `sync_checkpoint.rs`: previous-token checkpoint, committed cursor and room-event anchor. Existing checkpoint deliberately rolls the SDK token back after interruption before inbox processing completed.
- `media_spool.rs`: boot-scoped attachments referenced by pending journal entries. Accepted pending attachments must survive redeployment, or preserve a durable encrypted retrieval descriptor and demonstrate reliable re-download; a temporary file handle alone is insufficient.
- `store.rs`: device binding/provisioning intent and exclusive-writer ownership.

Move these accepted-work records to MySQL too. Keep a separate **application committed sync cursor** until all ingress events are durably journaled; SDK state-store sync-token commit happens before all application processing, so simply persisting SDK tokens can skip messages. Transaction boundaries between crypto save, state save and application inbox are separate SDK calls, not automatically one giant transaction.

## Lossless SQLite import limit

Public `CryptoStore` getters do **not** offer complete enumeration of all message hashes, arbitrary custom keys, all Olm sender keys or all sent secret requests. State custom keys/typed KV also have no universal dump API. Room-key export is not account/device identity, trust, replay protection or full state migration.

A complete offline importer must therefore be **pinned-schema aware** (0.18.0 SQLite migrations and encryption layouts) or use a separately reviewed SDK export extension. Open a verified backup, check the exact schema version, decrypt each supported table's values and preserve hashed-key/cipher relationships while converting. Reject unknown schema/tables rather than claim a complete import. Some encrypted indexes are irreversible hashes, so rebuilding them requires original key material from decrypted records or preserving the compatible original cipher/index family. Do not assume getters reconstruct every lookup key.

Freeze old writes before snapshot/import, verify identity and row-family counts/digests, import into a non-active namespace, then atomically activate the registry pointer. Refuse activation if source changed or target already has post-cutover writes. A stale SQLite store is not a safe rollback target once MySQL accepts new crypto state.

## Dependencies and first proof

Existing exact Matrix versions remain 0.18.0. Add direct dependencies only as needed: `async-trait = "=0.1.89"`, `matrix-sdk-store-encryption = "=0.18.0"`, and a reviewed/pinned Rust MySQL driver. A concrete candidate is `sqlx = "=0.8.6"` with `default-features = false`, features `runtime-tokio`, `tls-rustls-ring`, `mysql`; resolve/build and confirm host TLS behavior before adopting it. Driver compatibility was not compiled in this read-only investigation. SDK crypto types are already reachable through `matrix-sdk-base::crypto`; direct `matrix-sdk-crypto = "=0.18.0"` is useful for its test macro.

Tests need `matrix-sdk-base` and `matrix-sdk-crypto` `testing` features, `matrix-sdk-test = "=0.18.0"`, `matrix-sdk-common = "=0.18.0"`, `assert_matches`, and matching `ruma = "=0.16.0"` as referenced by macro expansion. Invoke `cryptostore_integration_tests!`, `cryptostore_integration_tests_time!`, and `statestore_integration_tests!` against independently namespaced real MySQL stores, not a mocked SQL engine. Time tests cover lease timing. Confirm full macro dependency resolution during compile.

Beyond SDK suites: process-kill/reopen with stable device keys, stale-holder writes after takeover, transaction rollback/fault injection, ambiguous commit reconnect, wrong cipher/row transplant, Unicode IDs, inbox/cursor crash boundaries, attachment replay, two-writer contention, migration interruption, and post-cutover rollback refusal.

## Source references inspected

Registry root: Cargo's local `matrix-sdk-*` 0.18.0 sources, corresponding to pinned lockfile dependencies, not a latest-version assumption.

- `matrix-sdk-crypto/src/store/traits.rs:47-434`; `store/types.rs`; `store/integration_tests.rs`.
- `matrix-sdk-base/src/store/traits.rs:71-542`; `store/mod.rs:540-587,789-870`; `store/integration_tests.rs:2177`.
- `matrix-sdk-base/src/event_cache/store/traits.rs`; `media/store/traits.rs`.
- `matrix-sdk-sqlite/src/crypto_store.rs:1078-1420`; `utils.rs:628-726` (private encryption codec).
- `matrix-sdk-store-encryption/src/lib.rs` public cipher APIs.
- `matrix-sdk/src/client/builder/mod.rs:330` custom StoreConfig seam.
- Application: `native/matrix-sidecar/{Cargo.toml,src/store.rs,src/client.rs,src/ingress.rs,src/sync_checkpoint.rs,src/media_spool.rs}`.
