# Matrix setup preflight follow-up

Observed: 2026-09-06T21:17:00Z. Existing authorized setup scope only; no Published deployment or credential creation in this observation.

- GitHub run `34056704369`, attempt 1, still builds source `ca68054232227788194d2d5e13a8a5beb4724da4`. Its Node job passed. Safari's live job log shows the first optimized release build completed in 35m24s; the second has not yet reported completion. Current native/build inputs are byte-unchanged from that source commit. No release artifact is claimed.
- Published `/healthz` responds 200. GoDaddy's authenticated overview confirmed Preview was inactive; opening its existing Preview woke the stateless application. The browser showed the expected runtime-ready root response. No Preview secrets, database role or code were changed.
- Preliminary absent-file requests: all six Published paths returned 404; Preview's two `/assets/` paths returned 404, while its two `/public/assets/` and two `/.runtime/` paths returned 401 before the GoDaddy login boundary. The existing authenticated Preview browser displayed `{"status":"not_found"}` for the alternate crypto-store path. These absent-file observations do not prove isolation of existing final storage files and do not satisfy the exact-path credential gate. No authentication/share token is recorded here.
- Inspection found a setup projection defect: a failed repeat preparation revoked the internal execution permission but retained the old `prepared` view. Preparation now resets the view before verification. The two fixed HTTP-isolation error codes now survive the content-free error filter instead of becoming an unhelpful generic failure. No isolation requirement was weakened or bypass added.
- Regression checks under Node 22.23.2: focused setup tests 6/6 passed; full `npm run check` passed asset build, typecheck, 747 tests, and forbidden-runtime-environment checks. The Python helper's synthetic tests remain included. `git diff --check` passed. These are local results, not Linux release or live delivery proof.

Next: finish/authenticate the immutable build, verify and pin its artifact, deploy setup-only mode, then establish exact-file HTTP isolation before the user-operated new-device credential step. Preview authentication is an evidence limitation to resolve, not a privacy pass. Existing Matrix sessions, messages and crypto state remain preserved.

## Completed run diagnosis and builder correction

Recorded: 2026-09-06T21:23:56Z, after fetching the completed GitHub job log.

Run `34056704369` failed in the native test stage, not the optimized release builds. Its first build completed at `20:38:34Z` in 35m24s and the second at `21:13:53Z` in 35m17s. The script reached `container("test", builds[0])` only after both binaries passed static/stripped ELF and byte-equality checks. Safari's previously observed search/scroll position had not exposed the second completion line; the completed log supersedes that incomplete progress observation.

The exact failure was `couldn't read src/../../../test/fixtures/matrix-invalid-media.json` at `client.rs:1472` and `client.rs:1556`. The native crate was mounted at `/source`, but its shared Node/Rust test fixture was not mounted at the resolved `/test/fixtures/` path. No artifact was uploaded and no failed output was promoted.

The builder now mounts that exact fixture read-only, includes it in source-input hashes and workflow change triggers, checks source mounts before the expensive build, checks fixture readability inside the container, and runs native tests before the two optimized builds. A regression test resolves both actual Rust `include_str!` references against the declared mounts and checks the shared provenance/trigger wiring. Native application source, production optimization, immutable image, offline compilation, separate target directories and byte-equality requirements are unchanged.

Local verification: release-package tests 11/11, complete Node 22.23.2 `npm run check` 748/748 plus build/typecheck/environment checks, shell syntax, `git diff --check`, and SDD before-implementation 13 artifacts/no issues/no warnings passed. Successful Linux tests and a new release artifact still require the replacement run.

Replacement: [run 34060973791](https://github.com/Ingwarski/personal-ai-consulting-group-godaddy/actions/runs/34060973791), exact source `271bcb8ec973e34fe0e53a0f260991ed1a4a5373`, confirmed in progress after push. The failed run's artifact API reports `total_count: 0`. No failed or missing output is pinned or deployed. No scheduled/background follow-up has been created; the GitHub job itself continues remotely.

Follow-up recorded at 2026-09-06T21:30:12Z after the user's next `go`: the replacement Node job passed; the Rust job remains in progress. The Codex app confirmed creation of the temporary current-task heartbeat `finish-matrix-build-verification`, checking every ten minutes and staying quiet on unchanged build state. It may continue only the already authorized setup after verified build success and must pause on failure or the first required user credential/device-comparison action. No automatic build retries, credential creation or trust confirmations are authorized. This supersedes the earlier absence of scheduled follow-up, not the build/deployment evidence.
