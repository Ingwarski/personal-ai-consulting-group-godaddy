import type { MatrixReleaseExpectation } from "./matrix-release-install.ts";

// Authenticated GitHub run 34060973791, attempt 1; archive and every source/file
// hash independently checked in the accompanying U-08 release verification.
export const MATRIX_RELEASE_PIN: MatrixReleaseExpectation = Object.freeze({
  manifestSha256: "a5e2f7cb1c7668cd4bce752a7a91a8e6a651c03306926a3751d9f93ff7e33c05",
  sourceCommit: "271bcb8ec973e34fe0e53a0f260991ed1a4a5373"
});
