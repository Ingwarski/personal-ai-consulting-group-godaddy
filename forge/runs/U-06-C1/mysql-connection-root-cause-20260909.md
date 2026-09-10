# Matrix MySQL connection root cause — 2026-09-09

## Published evidence

The authenticated, secret-free diagnostic route on Published reported:

- `nodeDatabaseReachable: true`;
- `nodeSessionEncrypted: false`;
- `nodeExtraCaConfigured: false`;
- `nodeAdditionalSystemCaActive: false`;
- `secureTransportRequired: false`;
- `verifiedTlsConnection: connected`.

The ordinary Node/mysql2 pool therefore reaches the configured database, and a
separate Node connection completes TLS with certificate verification. The
database does not require secure transport, but the Matrix store continues to
require it. These observations rule out an unreachable host/port, rejected
database credentials, absent server TLS and dependence on an operator-provided
Node CA override. No connection coordinates, credentials, certificate bodies
or raw provider errors were retained.

The deployed static Rust executable failed before Matrix state access while
SQLx 0.8.6 used `tls-rustls-ring` with `MySqlSslMode::VerifyIdentity`. SQLx's
official FAQ documents `HandshakeFailure`/`CorruptMessage` interoperability
failures on its Rustls path and recommends the corresponding native-TLS backend
when the server and Rustls cannot agree. Given the same Published database and
credentials succeed through Node's OpenSSL-backed verified-TLS connection, the
remaining failure boundary is the SQLx/Rustls MySQL TLS handshake rather than
database reachability, authentication or Matrix state.

## Contract-preserving repair

Source commit `bea5323cb18885e4a16daec37c792e3f486cf1d3` changes only SQLx's MySQL TLS
backend to `tls-native-tls`. It retains `MySqlSslMode::VerifyIdentity`; there is
no plaintext, accept-invalid-certificate or hostname-verification fallback.
The Linux/musl release activates vendored OpenSSL and records the exact added
build inputs, prepared-image identity and Dockerfile hash. The final executable
must remain a stripped static ELF produced by two byte-identical offline builds.

Local verification before release: full Node check passed with 939 tests; the
Rust workspace passed 117 executable tests with zero failures and retained 28
explicit isolated-MySQL tests as ignored locally; release packaging passed 12
tests. These results verify source behavior, not Published acceptance.

## Release and Published acceptance

Release run: https://github.com/Ingwarski/personal-ai-consulting-group-godaddy/actions/runs/34396505206

Run 34396505206 completed successfully for exact source/workflow commit
`bea5323cb18885e4a16daec37c792e3f486cf1d3`, attempt 1. The source-bound build
step passed 117 credential-free tests, retained 28 explicit database-dependent
tests as ignored, and produced two byte-identical static optimized binaries in
44m25s and 44m45s. Artifact `10125649179` contains exactly ten files; its
independently downloaded ZIP SHA-256 matches GitHub at
`085f64bb1f4436ac3c56268ea39589f27d43f630af7c0288b4e2b58d95392634`.

Independent promotion verification checked every artifact size/hash, all 47
source inputs against the exact commit, native tree identity, source/workflow/run
binding, full builder projection, prepared image and Dockerfile hashes, SBOM
presence of SQLx/native-tls/OpenSSL, declared build inputs and both static ELF
binaries. Verified identities:

- manifest: `025366d7ac8c5e081bdbc973ceb387d77d6f2f2e77ce2138276180046c2a83a5`;
- sidecar: `6c61d18dc723cea1af3ff82ec8e694dcb1e7cffb40965670a3205fff0d297e93`
  (49,971,152 bytes);
- setup: `b348beda852c6f67fa0d0a440a354c99a1d7518dc88d6a1347e359bb48752775`
  (44,773,232 bytes);
- prepared builder image:
  `sha256:560d64eaab3091555ed2e7375817fffa95ebb1b69e5a80388791b1c7caa37247`.

After promotion, the full application check passed again with 939/939 tests and
the environment policy check passed. The production installer then installed
the exact promoted bundle into a fresh canonical application root and its
read-only inspector independently revalidated both installed executables with
the pinned manifest, source commit and binary hashes.

The first Published preparation exposed `matrix_release_conflict` before any
database or Matrix operation. Its atomic upgrade allowlist still named the
release preceding the one actually deployed on Published. The repair updates
that guard to the exact immediately preceding manifest's sidecar
`30958a7c049a009c38ff8abb70b2ed3a0c409b61613185576eef8891ed5a58cf`
and setup
`f93f4c61f87cf2102963a8a48eddaa15d421afd2bfe3c6d0b4b7953516d1d6e6`.
Arbitrary or modified executables remain non-replaceable.

The following setup attempt then reached `matrix_configuration_invalid`: the
runtime configuration duplicated the executable path and checksum in GoDaddy
secrets, so the stale prior checksum rejected the newly pinned release. MySQL
mode now derives both values from the canonical application root and committed
release pin; the verified release inspection supplies the same binding during
provisioning. Existing stale path/hash secrets are ignored and can be retired
later without a destructive edit during this recovery. SQLite compatibility
continues to require its explicit path and checksum values.

The exact bundle and runtime pin are promoted in the same repository change as
this evidence. Exact GoDaddy Published revision and post-deployment MySQL/Matrix
result must still be appended before this repair is called complete.

The executable-binding repair passed the complete local project gate: build,
typecheck, 940 tests, environment policy and diff whitespace validation. This
does not replace the required Published provisioning result.

Published commit `33b0f8b5d8f998a9e2744840ddba82e0f22d4b61` removed the
configuration error and started the native setup process. Its first strict
SQLx/native-tls attempt returned `mysql_tls_failed` while the same Published
screen still reported the separate Node certificate-verified connection as
`connected`. The remaining distinction is trust-root discovery: Node uses its
active bundled CA set, while native-tls delegates to `openssl-probe`, whose
fixed Linux file/dir search is not a guarantee on the GoDaddy application host.
The correction writes Node's active public CA roots to a private per-process
bundle and supplies it to the static child through `SSL_CERT_FILE`. Hostname and
certificate verification remained enabled in that attempt; no owner secret or
permissive TLS fallback was added. Published commit
`f51d9fa4bf2a98c686382fb196be6dbe15e022f0` still returned
`mysql_tls_failed`, so trust-root discovery alone was not the complete cause.

## Certificate-identity isolation and compatibility repair

Review of mysql2's actual TLS implementation found that `rejectUnauthorized`
validates the CA chain, while hostname verification is a separate
`verifyIdentity` option that mysql2 leaves disabled by default. The original
Node diagnostic therefore overstated equivalence with SQLx `VerifyIdentity`.

Published commit `ea0860d0b89832a3a603743b898face2035b52a1` added two
otherwise identical probes. On the exact GoDaddy Published database it reports:

- CA-chain verification: `connected`;
- CA-chain plus server-name identity verification: `certificate_rejected`.

Because only the identity check differs, these sequential probes isolate
server-name verification as the failing check. The normalized result remains a
diagnostic inference because mysql2 wraps pre-secure TLS errors.
The Rust store now uses SQLx `VerifyCa`: encryption remains mandatory and the
certificate chain must validate, but the provider-incompatible hostname check
is omitted. There is no plaintext or accept-invalid-certificate fallback. The
diagnostic normalizes mysql2's wrapped identity error on the next deployment so
the owner page will report `server_identity_rejected` without exposing a host,
certificate, account, schema or raw error.

The immutable production release for this Rust change is GitHub run
`34411975888`, attempt 1. Both jobs completed successfully for exact source
`ea0860d0b89832a3a603743b898face2035b52a1`. The source-bound build passed its
credential-free tests and produced two byte-identical static binaries. Artifact
`10130411789` contains exactly ten files; its independently downloaded
38,456,084-byte ZIP SHA-256 matches GitHub at
`8b193d7d5145dd6566c8c6ddc7b2d82a7765bb25a0d2ebf8015820fa78f08638`.

Independent promotion verification checked every artifact size/hash, checksum
entry, all 47 declared source inputs against the exact commit, native tree,
source/workflow/run binding, prepared image and Dockerfile identity, and both
static stripped ELF binaries. Verified identities:

- manifest: `7a9118119ac0e79b62256d794b0e9a7fb1e52d79dd09c41759f30c2f5a0f2de4`;
- sidecar: `7ab03f29318bf789480af196bdb67f58c1dea04f824c7c768c044eb094d316c5`
  (49,971,152 bytes);
- setup: `4ebf7ef697d87f8b5f3989a5388d167729252f00a2678f49e270f18378b90454`
  (44,773,232 bytes);
- prepared builder image:
  `sha256:d192369354a786a4e271992f59b5a54b8d2a10eab2173836ec64f9cb1a2d7bf3`;
- native-TLS Dockerfile:
  `3a05b3288f1abd892601288853fb90272bb9b4e02627fa04cf2a72a78b285fda`.

The complete verified bundle and matching release pin are promoted together.
The installer permits an atomic replacement only from the exact binaries
currently deployed on GoDaddy; arbitrary or modified executables remain
non-replaceable. Final Published deployment and Matrix provisioning are the
remaining acceptance evidence.

After promotion, the complete application gate passed with 944/944 tests plus
build, typecheck and environment-policy validation; `git diff --check` also
passed. These checks validate the committed candidate, not the remaining live
Published setup.
