# Non-production record-envelope feasibility proof

Synthetic data only; no MySQL connection, credentials, Matrix account, application wiring or deployment. This crate is not the storage adapter and is not a release gate result.

## Question and finding

Can the pinned Matrix SDK's existing storage cipher protect values intended for MySQL, restore them with an external key, and reject ciphertext moved to a different record?

Yes for the tested envelope: serialize store identity, record family, record key and schema version **inside** the encrypted value, then compare all four against independently supplied expected coordinates after decryption. The cipher alone authenticates its ciphertext, not its destination SQL row. Expected coordinates must not come solely from that ciphertext.

Six tests passed locally on Rust 1.93.0 / macOS with `matrix-sdk-store-encryption = 0.18.0`:

1. Export/import under an external synthetic key preserves the cipher, lookup hashes and Unicode payload.
2. A different external key cannot import the cipher.
3. Moving ciphertext between store, family, record or schema is rejected.
4. Modified, truncated, empty or foreign-cipher ciphertext is rejected.
5. Repeated encryption of the same payload produces different ciphertext.
6. Lookup hashes are separated by record family.

The locked offline Clippy check for all targets also passed with warnings denied. No production regression suite or real-MySQL test was run for this isolated experiment.

## Reproduce

From the repository root, with Rust 1.93.0 available:

```sh
cargo test --locked --manifest-path forge/exploration/U-06-C1/record-envelope-proof/Cargo.toml
```

The initial offline resolution could not resolve an exact `serde = 1.0.228` from the installed cache. The experiment uses the SDK-compatible `1.0.228` requirement and records the resolved `1.0.229` in its own lockfile. It does not change the production Rust manifest or lockfile.

## Not proven

- Real MySQL transactions, TLS, schema, fencing or GoDaddy runtime compatibility.
- SDK crypto/state trait completeness or full pickle serialization/migration.
- Crash/restart, cursor/inbox atomicity, pending media recovery or final-response deduplication.
- Same-row historical rollback detection: an older valid ciphertext with identical coordinates still decrypts. Lease/epoch and transactional version controls are separate requirements; this proof does not solve malicious whole-database rollback.
- Production key loading/rotation or secret-memory lifetime management. Test keys are fixed synthetic fixtures only.

Do not promote this crate into production without the formal implementation gate, complete backend implementation, review and real integration tests.
