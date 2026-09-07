import { registerMatrixWake } from "../src/godaddy/matrix-wake-registration.ts";

// Explicit --apply is required for external changes. Never print request
// bodies, Matrix tokens, pushkeys, account IDs or homeserver error bodies.
if (process.argv.slice(2).some((argument) => argument !== "--apply")) {
  process.stderr.write("Usage: node --experimental-strip-types scripts/register-matrix-wake.ts [--apply]\n");
  process.exitCode = 1;
} else {
  try {
    const result = await registerMatrixWake({ environment: process.env, apply: process.argv.includes("--apply") });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("Matrix wake configuration or registration failed. No credential details were logged. Inspect the configured bot, endpoint and dedicated pusher/rule before retrying.\n");
    process.exitCode = 1;
  }
}
