# GoDaddy Preview Matrix Capability Probe — 03.09.2026

## Scope

`317571d` temporarily added a content-free route and pulled it into Preview only. It was designed to test the last Node 22-compatible Matrix Rust crypto binding (`@matrix-org/matrix-sdk-crypto-nodejs@0.4.0`), local writable storage, restart-safe reopening of a synthetic SQLite crypto store, a child process and HTTPS access to `matrix.org`.

The route had no Matrix credentials, account, room, user data, MySQL access or Published deployment. It was never invoked successfully.

## Observed GoDaddy evidence

- GoDaddy accepted Preview source commit `317571d`; its dashboard reported build state `healthy`, Node.js 22 and the Preview variant.
- Opening the protected Preview URL twice triggered its automatic wake sequence. Both attempts remained on GoDaddy's `Starting up` page for the full advertised cold-start window and ended with `Taking longer than expected`.
- A direct, protected `GET` request to the probe route received the same GoDaddy wake page and never reached the Node process.
- GoDaddy Preview runtime logs were unavailable/disabled while the instance remained inactive.
- Published was not restarted, republished or otherwise changed.

## Result

`blocked: preview_runtime_did_not_start`.

This is not evidence that local storage, native crypto, child processes or Matrix HTTPS work on GoDaddy. No probe marker or SQLite crypto store was created, and no Matrix request was made.

The latest Matrix Rust crypto package requires Node 24; Node 22 permits only the older `0.4.0` line. Until GoDaddy provides Node 24 or successfully starts a controlled Node 22 Preview runtime, a restart-safe Matrix E2EE deployment remains a no-go.

## Cleanup

The next commit removes the temporary route, test files and native dependency from GitHub. It must be pulled into Preview only; it must not be published.
