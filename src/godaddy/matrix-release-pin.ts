import type { MatrixReleaseExpectation } from "./matrix-release-install.ts";

// Authenticated GitHub run 34538409177, attempt 1; archive and every source/file
// hash independently checked in forge/runs/U-06-C1/verify-orphan-safety-release-20260910.mjs.
export const MATRIX_RELEASE_PIN: MatrixReleaseExpectation = Object.freeze({
  manifestSha256: "4762de6819951e2847aa6dedd4d948233503c2013794bee2fc41954b2464d99c",
  sourceCommit: "ff8a4a5f142a005d38fe2f1a0361b65aaa06d60b"
});

// MySQL mode derives its executable binding from this reviewed release, never
// from a separately mutable deployment secret.
export const MATRIX_RELEASE_SIDECAR_SHA256 =
  "1344e3ee2dfffc2ac1f3b6b3705dc2d8d234f54254d83a45ff2c9ed27031f547";
