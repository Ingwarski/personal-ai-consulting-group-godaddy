import type { MatrixReleaseExpectation } from "./matrix-release-install.ts";

// Authenticated GitHub run 34411975888, attempt 1; archive and every source/file
// hash independently checked in forge/runs/U-06-C1/mysql-connection-root-cause-20260909.md.
export const MATRIX_RELEASE_PIN: MatrixReleaseExpectation = Object.freeze({
  manifestSha256: "7a9118119ac0e79b62256d794b0e9a7fb1e52d79dd09c41759f30c2f5a0f2de4",
  sourceCommit: "ea0860d0b89832a3a603743b898face2035b52a1"
});

// MySQL mode derives its executable binding from this reviewed release, never
// from a separately mutable deployment secret.
export const MATRIX_RELEASE_SIDECAR_SHA256 =
  "7ab03f29318bf789480af196bdb67f58c1dea04f824c7c768c044eb094d316c5";
