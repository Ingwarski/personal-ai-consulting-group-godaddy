import type { MatrixReleaseExpectation } from "./matrix-release-install.ts";

// Authenticated GitHub run 34521582640, attempt 1; archive and every source/file
// hash independently checked in forge/runs/U-06-C1/verify-orphan-safety-release-20260910.mjs.
export const MATRIX_RELEASE_PIN: MatrixReleaseExpectation = Object.freeze({
  manifestSha256: "b8dc030b2b3dee702ed29c4d965ce62cd72b8e80fe2d018d30d20e2c8259426e",
  sourceCommit: "9d362d0c990893ce0ef7f84b468bc73d150bba6d"
});

// MySQL mode derives its executable binding from this reviewed release, never
// from a separately mutable deployment secret.
export const MATRIX_RELEASE_SIDECAR_SHA256 =
  "2ca6f0a34f57401169b2433f1b442c7e31a83ab9a0350f61e9157453734a7c97";
