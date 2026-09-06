import type { MatrixReleaseExpectation } from "./matrix-release-install.ts";

// Replaced only with independently verified output of the immutable release job.
// Absence is intentional fail-closed state, never a synthetic release receipt.
export const MATRIX_RELEASE_PIN: MatrixReleaseExpectation | undefined = undefined;
