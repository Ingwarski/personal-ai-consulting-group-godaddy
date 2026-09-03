# GoDaddy Preview Matrix Capability Probe — 03.09.2026

## Scope

`317571d` temporarily added a content-free route and pulled it into Preview only. After a cold-start failure, `8991a2b` restored it and `38aa221` corrected an initial filesystem-reporting defect. It tested the last Node 22-compatible Matrix Rust crypto binding (`@matrix-org/matrix-sdk-crypto-nodejs@0.4.0`), local writable storage, restart persistence, a child process and HTTPS access to `matrix.org`. `964e6b8` temporarily added a read-only loader diagnostic to identify the native-import failure exactly.

The route had no Matrix credentials, account, room, user data, MySQL access or Published deployment. It created only two fixed, content-free marker files while testing and deleted exactly those directories after the result was read.

## Observed GoDaddy evidence

- GoDaddy accepted Preview source commits `38aa221` and `964e6b8`; its dashboard reported build state `healthy`, Node.js 22 and the Preview variant.
- The initial `317571d` probe attempt was blocked by a cold start. A later healthy Preview instance answered the corrected route.
- `POST` reported `nativeCrypto: false`, `childProcess: true`, `matrixHttps: true`, and writable `app` and `tmp` fixed directories.
- After a Preview-only restart, `GET` reported `survivedRestart: true` for both fixed directories. This proves restart persistence only; it does not prove persistence across a new deployment.
- The loader diagnostic reported Node `v22.23.2`, Linux x64, `packageInstalled: true`, and `ERR_DLOPEN_FAILED`: the downloaded `matrix-sdk-crypto.linux-x64-musl.node` required `ld-linux-x86-64.so.2`, which is absent in GoDaddy's musl runtime.
- This is not a failed npm install or a missing lifecycle hook. The `0.4.0` package tarball contains no native binary; the installed musl-named asset proves its post-install download ran. Independent inspection of that exact public asset found the `ld-linux-x86-64.so.2` dependency and `GLIBC_*` symbol references.
- No Matrix SQLite crypto store was created or reopened.
- Published was not restarted, republished or otherwise changed.

## Result

`no_go: matrix_e2ee_native_crypto_unavailable`.

GoDaddy Preview has usable writable storage across a restart, child processes and outbound Matrix HTTPS. The blocking cause is a native ABI mismatch: the `0.4.0` release's musl-named binary depends on the glibc loader that GoDaddy's musl runtime does not provide. That blocks a secure, restart-safe Matrix E2EE integration on this hosting product.

The vendor's newer lines require Node 24, while GoDaddy supplies Node 22. Therefore an upgrade is not a supported repair. A viable future path requires either a GoDaddy Node 24/glibc-compatible runtime or a vendor-supported musl native binding that supports Node 22. Shipping an unverified custom crypto binary would not be an acceptable security workaround.

## Cleanup

The probe's `DELETE` request removed its two fixed directories before the first cleanup commit. The diagnostic was read-only and created no files. This cleanup commit removes the temporary diagnostic route, tests and native dependency from GitHub. It must be pulled into Preview only; it must not be published.
