# GoDaddy Preview Matrix Capability Probe — 03.09.2026

## Scope

`317571d` temporarily added a content-free route and pulled it into Preview only. After a cold-start failure, `8991a2b` restored it and `38aa221` corrected an initial filesystem-reporting defect. It tested the last Node 22-compatible Matrix Rust crypto binding (`@matrix-org/matrix-sdk-crypto-nodejs@0.4.0`), local writable storage, restart persistence, a child process and HTTPS access to `matrix.org`.

The route had no Matrix credentials, account, room, user data, MySQL access or Published deployment. It created only two fixed, content-free marker files while testing and deleted exactly those directories after the result was read.

## Observed GoDaddy evidence

- GoDaddy accepted Preview source commit `38aa221`; its dashboard reported build state `healthy`, Node.js 22 and the Preview variant.
- The initial `317571d` probe attempt was blocked by a cold start. A later healthy Preview instance answered the corrected route.
- `POST` reported `nativeCrypto: false`, `childProcess: true`, `matrixHttps: true`, and writable `app` and `tmp` fixed directories.
- After a Preview-only restart, `GET` reported `survivedRestart: true` for both fixed directories. This proves restart persistence only; it does not prove persistence across a new deployment.
- The native module did not load in GoDaddy's Node 22 runtime, so no Matrix SQLite crypto store was created or reopened.
- Published was not restarted, republished or otherwise changed.

## Result

`no_go: matrix_e2ee_native_crypto_unavailable`.

GoDaddy Preview has usable writable storage across a restart, child processes and outbound Matrix HTTPS. It cannot load the required native Matrix crypto binding on the supplied Node 22 runtime. That blocks a secure, restart-safe Matrix E2EE integration on this hosting product. The latest Matrix Rust crypto package requires Node 24; Node 22 permits only the older `0.4.0` line, which failed to load here.

## Cleanup

The probe's `DELETE` request removed its two fixed directories before this cleanup commit. This commit removes the temporary route, test files and native dependency from GitHub. It must be pulled into Preview only; it must not be published.
