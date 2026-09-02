import assert from "node:assert/strict";
import test from "node:test";

import {
  getValidatedDefaults,
  resolveEffectiveSessionSnapshot,
  resolveSpeedPolicy,
  validateOwnerSettings
} from "../src/settings/index.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

test("accepts a complete settings set backed by both provider capability maps", () => {
  const result = validateOwnerSettings(createCapabilityReceipt().defaults, createCapabilityReceipt(), activeNow);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.codex.reasoningEffort, "high");
    assert.equal(result.value.claude.reasoningEffort, "high");
    assert.equal(result.codex.runtimeModelId, "codex-runtime-primary");
    assert.equal(result.claude.runtimeModelId, "claude-runtime-critic");
  }
});

test("rejects arbitrary model text and partial settings objects", () => {
  const receipt = createCapabilityReceipt();

  assert.deepEqual(
    validateOwnerSettings(
      { ...receipt.defaults, codex: { ...receipt.defaults.codex, modelId: "some-model-from-free-text" } },
      receipt,
      activeNow
    ),
    { ok: false, code: "unknown_codex_model" }
  );
  assert.deepEqual(
    validateOwnerSettings({ codexModelId: receipt.defaults.codex.modelId }, receipt, activeNow),
    { ok: false, code: "unexpected_settings_shape" }
  );
});

test("blocks an unavailable effort for its own provider rather than silently changing it", () => {
  const receipt = createCapabilityReceipt();
  const result = validateOwnerSettings(
    { ...receipt.defaults, claude: { ...receipt.defaults.claude, reasoningEffort: "xhigh" } },
    receipt,
    activeNow
  );

  assert.deepEqual(result, { ok: false, code: "claude_reasoning_effort_unavailable" });
});

test("fails closed for untrusted or stale capability receipts", () => {
  const receipt = createCapabilityReceipt();

  assert.deepEqual(validateOwnerSettings(receipt.defaults, { ...receipt, trusted: false }, activeNow), {
    ok: false,
    code: "catalog_untrusted"
  });
  assert.deepEqual(
    validateOwnerSettings(receipt.defaults, { ...receipt, expiresAt: "2026-08-16T11:59:59.000Z" }, activeNow),
    { ok: false, code: "catalog_stale" }
  );
});

test("validates catalog defaults through the same whole-set guard", () => {
  const receipt = createCapabilityReceipt();
  assert.equal(getValidatedDefaults(receipt, activeNow).ok, true);

  const brokenDefaults = { ...receipt, defaults: { ...receipt.defaults, claude: { ...receipt.defaults.claude, reasoningEffort: "xhigh" as const } } };
  assert.deepEqual(getValidatedDefaults(brokenDefaults, activeNow), {
    ok: false,
    code: "claude_reasoning_effort_unavailable"
  });
});

test("all speed presets retain the non-negotiable consilium invariants and forbid paid acceleration", () => {
  for (const preset of ["швидко", "збалансовано", "ретельно"] as const) {
    const policy = resolveSpeedPolicy(preset);
    assert.equal(policy.preset, preset);
    assert.equal(policy.paidAcceleration, "forbidden");
    assert.equal(policy.invariants.claudeCriticRequired, true);
    assert.equal(policy.invariants.a2aRequired, true);
    assert.equal(policy.invariants.matrixE2eeRequired, true);
    assert.equal(policy.invariants.verbatimVisibilityRequired, true);
    assert.equal(policy.invariants.safetyPrivacyRequired, true);
    assert.equal(policy.invariants.externalPermissionRequired, true);
  }
});

test("creates a deeply immutable snapshot that preserves its catalog version", () => {
  const receiptV1 = createCapabilityReceipt();
  const resolved = resolveEffectiveSessionSnapshot(
    {
      sessionId: "session-1",
      settingsRevision: 7,
      settings: receiptV1.defaults,
      capabilityReceipt: receiptV1
    },
    activeNow
  );

  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  assert.equal(resolved.value.catalogVersion, "catalog-2026-08-16-r1");
  assert.equal(resolved.value.speedPolicy.catalogVersion, "speed-policy-awaiting-production-approval-v1");
  assert.deepEqual(resolved.value.speedPolicy.concurrency, {
    status: "unresolved",
    reason: "production_approval_required"
  });
  assert.equal(Object.isFrozen(resolved.value), true);
  assert.equal(Object.isFrozen(resolved.value.settings), true);
  assert.equal(Object.isFrozen(resolved.value.speedPolicy.invariants), true);
  assert.throws(() => {
    (resolved.value.settings as { speedPreset: string }).speedPreset = "швидко";
  }, TypeError);

  const receiptV2 = createCapabilityReceipt({ catalogVersion: "catalog-2026-08-16-r2" });
  assert.equal(receiptV2.catalogVersion, "catalog-2026-08-16-r2");
  assert.equal(resolved.value.catalogVersion, "catalog-2026-08-16-r1");
});
