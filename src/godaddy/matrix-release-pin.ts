import type { MatrixReleaseExpectation } from "./matrix-release-install.ts";

// Authenticated GitHub run 34699403518, attempt 1; archive and every source/file
// hash independently checked in forge/runs/U-06-C1/verify-research-voice-release-20260912.mjs.
export const MATRIX_RELEASE_PIN: MatrixReleaseExpectation = Object.freeze({
  manifestSha256: "6b30be6175551d505a03f81fcc536086f73ff29310755a24de2a16d699ab7b23",
  sourceCommit: "36a2d10134862f61ada51b0387de1aa3acf24531"
});

// MySQL mode derives its executable binding from this reviewed release, never
// from a separately mutable deployment secret.
export const MATRIX_RELEASE_SIDECAR_SHA256 =
  "74da7ea448778a480551bade74a4e42836d45416a3f56d0e8b48ddf1a5ad1f91";
