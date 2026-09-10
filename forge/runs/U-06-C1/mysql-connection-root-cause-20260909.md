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

## In-process Matrix sync recovery release

The live consultation test exposed short delivery bursts accompanied by
`matrix_sidecar_not_ready` transitions. Source review found that any transient
Matrix `/sync` failure emitted a fatal sidecar event and exited the only
encrypted-store writer. The supervisor restart then introduced store-lock
contention and delayed durable outbox delivery. Commit
`f47a83201142177700aee7ebaf099d4df77b1480` keeps the exact process and store
writer alive, reports blocked readiness, waits for the existing bounded retry
delay and retries `/sync` in process. Explicit journal and startup integrity
failures remain fatal.

Authenticated GitHub run `34494531239`, attempt 1, completed successfully for
that exact commit. Its source-bound job passed the complete Node gate and two
independent network-disabled Rust release builds produced byte-identical static
stripped binaries. Artifact `10163722561` contains exactly ten files; its
38,455,583-byte ZIP SHA-256 matches GitHub at
`93d360f8d38fffbbc4e4860ec95aebbed8e8efa7a59134e2cafe81b2f7260ede`.
Independent promotion verification checked the run and repository identity,
all 47 declared source inputs, every artifact size and hash, the manifest,
checksums, builder projection, provenance and both ELF binaries. Verified
release identities are:

- manifest: `0d50f94b7717fb1aab50352a07076416cd57febddf8f16a677b3adea769a63dd`;
- sidecar: `ce148392a57f4bd391437b8eedc963bf1fd0f252b4f599cdd6dd2e45369d6984`
  (49,971,152 bytes);
- setup: `59be65ea5668d365834be5174997c68e9bd14f35a1f6850b454be35ddb3e511f`
  (44,773,232 bytes);
- prepared builder image:
  `sha256:7d0116fba48436b237b92fa1239e2ad960aa3f869bbfa1c99de288af60914cfb`.

The atomic installer accepts replacement only from the exact currently
deployed sidecar and setup hashes. Published deployment, a fresh consultation
and post-test log inspection remain the real-host acceptance gates.

After promotion, the complete application gate passed again with 963/963 tests,
build, typecheck, environment-policy validation and `git diff --check`. A fresh
canonical-root smoke test installed over the exact preceding pinned sidecar and
setup executables, then the read-only inspector revalidated both new hashes.
This proves the bounded atomic upgrade path locally; it does not replace the
remaining Published acceptance test.

## Deployment-writer orphan safety release

GoDaddy restarts can replace the Node parent without reliably terminating an
older native child immediately. The resulting old sidecar continued renewing
the single-writer MySQL lease, so the new deployment reported
`matrix_lock_contended` and could not become ready. Source commit
`9d362d0c990893ce0ef7f84b468bc73d150bba6d` adds two complementary controls:

- on Linux, the sidecar arms a parent-death signal and rechecks its parent so a
  child cannot survive the loss of the Node process that created it;
- the verified sidecar binary hash becomes a deployment generation. A different
  verified release may atomically advance the MySQL fence and supersede an old
  live writer, while a concurrent process from the same release remains blocked.
  Every lease renewal, write and release is conditioned on the active fence, so
  the superseded process cannot resume writing.

The complete Node gate passed with 964/964 tests. The Rust workspace passed
formatting, Clippy with warnings denied and 117 executable tests; 29 tests that
require an isolated MySQL service remained explicitly ignored in the
credential-free job. Repaired non-deployable verification run `34527021179`
then completed the host and static-musl checks successfully. Its first attempt
had reached and passed the static-musl tests but hit the former 45-minute job
limit while installing SBOM tools; commit
`c8b1ccca3f5c504f0851d8692484ee38d21c9de9` raised only that job timeout to 90
minutes, without weakening a check.

Authenticated immutable production run `34521582640`, attempt 1, completed
successfully for the exact source/workflow commit. Two independent
network-disabled builds produced byte-identical static stripped binaries and
the credential-free musl tests passed. Artifact `10173795555` contains exactly
ten files; its independently downloaded 38,457,987-byte ZIP SHA-256 matches
GitHub at
`251cee197a83817b478a991d57e3f6424cc95c0634d1787b02d905bbecec7501`.

The independent verifier in
`forge/runs/U-06-C1/verify-orphan-safety-release-20260910.mjs` checked the exact
repository, workflow, commit, run attempt and artifact identity; every archive
entry, manifest entry and checksum; all 47 declared source inputs against both
the exact Git commit and current checkout; full builder/provenance projection;
and both static stripped ELF binaries. Verified release identities are:

- manifest: `b8dc030b2b3dee702ed29c4d965ce62cd72b8e80fe2d018d30d20e2c8259426e`;
- sidecar: `2ca6f0a34f57401169b2433f1b442c7e31a83ab9a0350f61e9157453734a7c97`
  (49,975,248 bytes);
- setup: `a6eb8d38b9f9b8ff9c63bea60369e012bc4b7bf3b99d65187c11ce721e26e354`
  (44,777,328 bytes);
- prepared builder image:
  `sha256:0eafb505192b70ac30678b732441844b4fa62eca7e56dfd5271c5f636f33b3d3`.

The atomic installer accepts replacement only from the exact sidecar and setup
hashes currently deployed on GoDaddy; arbitrary or modified executables remain
non-replaceable. Published deployment, takeover of the existing orphan and a
fresh end-to-end Matrix consultation remain the real-host acceptance gates.

After promotion, the complete application gate passed again with 964/964 tests,
build, typecheck, environment-policy validation and `git diff --check`. A fresh
canonical-root smoke test installed the promoted release over the exact prior
sidecar and setup binaries, and the independent read-only inspection then
revalidated both installed hashes. This proves the bounded local upgrade path;
it does not replace the remaining Published acceptance test.
