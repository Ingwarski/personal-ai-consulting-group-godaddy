import type { MatrixReleaseExpectation } from "./matrix-release-install.ts";

// Authenticated GitHub run 34396505206, attempt 1; archive and every source/file
// hash independently checked in forge/runs/U-06-C1/mysql-connection-root-cause-20260909.md.
export const MATRIX_RELEASE_PIN: MatrixReleaseExpectation = Object.freeze({
  manifestSha256: "025366d7ac8c5e081bdbc973ceb387d77d6f2f2e77ce2138276180046c2a83a5",
  sourceCommit: "bea5323cb18885e4a16daec37c792e3f486cf1d3"
});

// MySQL mode derives its executable binding from this reviewed release, never
// from a separately mutable deployment secret.
export const MATRIX_RELEASE_SIDECAR_SHA256 =
  "6c61d18dc723cea1af3ff82ec8e694dcb1e7cffb40965670a3205fff0d297e93";
