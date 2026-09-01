import assert from "node:assert/strict";
import test from "node:test";

import { preflightSubscriptionRuntimes } from "../src/runtime/provider-preflight.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

function validInput() {
  const capabilityReceipt = createCapabilityReceipt();
  return {
    environment: { RUNTIME_MODE: "test" },
    settings: capabilityReceipt.defaults,
    capabilityReceipt,
    codex: {
      authMode: "chatgpt_oauth" as const,
      readiness: "ready" as const,
      privateSingleOwner: true,
      availableModelIds: ["codex-current-primary"]
    },
    claude: {
      authMode: "claude_code_oauth" as const,
      readiness: "ready" as const,
      privateSingleOwner: true,
      availableModelIds: ["claude-current-critic"],
      fastModeEnabled: false,
      extraUsageEnabled: false
    },
    now: activeNow
  };
}

test("allows only private subscription OAuth runtimes with the selected available models", () => {
  const result = preflightSubscriptionRuntimes(validInput());
  assert.deepEqual(result, { ok: true, catalogVersion: "catalog-2026-08-16-r1" });
});

test("fails closed for API/PAYG environment material and paid Claude acceleration", () => {
  assert.deepEqual(
    preflightSubscriptionRuntimes({ ...validInput(), environment: { RUNTIME_MODE: "test", OPENAI_API_KEY: "forbidden" } }),
    { ok: false, code: "forbidden_environment" }
  );
  assert.deepEqual(
    preflightSubscriptionRuntimes({ ...validInput(), claude: { ...validInput().claude, fastModeEnabled: true } }),
    { ok: false, code: "claude_paid_acceleration_forbidden" }
  );
});

test("fails closed for auth, quota and runtime-model availability problems", () => {
  assert.deepEqual(
    preflightSubscriptionRuntimes({ ...validInput(), codex: { ...validInput().codex, readiness: "auth_required" } }),
    { ok: false, code: "codex_auth_required" }
  );
  assert.deepEqual(
    preflightSubscriptionRuntimes({ ...validInput(), claude: { ...validInput().claude, readiness: "quota_blocked" } }),
    { ok: false, code: "claude_quota_blocked" }
  );
  assert.deepEqual(
    preflightSubscriptionRuntimes({ ...validInput(), codex: { ...validInput().codex, availableModelIds: [] } }),
    { ok: false, code: "codex_model_not_available" }
  );
});

test("does not accept alternate auth modes or a non-private usage boundary", () => {
  assert.deepEqual(
    preflightSubscriptionRuntimes({ ...validInput(), codex: { ...validInput().codex, authMode: "other" } }),
    { ok: false, code: "codex_auth_mode_invalid" }
  );
  assert.deepEqual(
    preflightSubscriptionRuntimes({ ...validInput(), claude: { ...validInput().claude, privateSingleOwner: false } }),
    { ok: false, code: "private_boundary_failed" }
  );
});
