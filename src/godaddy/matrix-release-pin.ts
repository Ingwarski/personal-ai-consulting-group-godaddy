import type { MatrixReleaseExpectation } from "./matrix-release-install.ts";

// Authenticated GitHub run 34494531239, attempt 1; archive and every source/file
// hash independently checked in forge/runs/U-06-C1/mysql-connection-root-cause-20260909.md.
export const MATRIX_RELEASE_PIN: MatrixReleaseExpectation = Object.freeze({
  manifestSha256: "0d50f94b7717fb1aab50352a07076416cd57febddf8f16a677b3adea769a63dd",
  sourceCommit: "f47a83201142177700aee7ebaf099d4df77b1480"
});

// MySQL mode derives its executable binding from this reviewed release, never
// from a separately mutable deployment secret.
export const MATRIX_RELEASE_SIDECAR_SHA256 =
  "ce148392a57f4bd391437b8eedc963bf1fd0f252b4f599cdd6dd2e45369d6984";
