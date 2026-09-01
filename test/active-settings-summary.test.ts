import assert from "node:assert/strict";
import test from "node:test";

import { createActiveSessionSummaryProvider } from "../src/session/active-settings-summary.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { RegistrarDO } from "../src/session/registrar-do.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";

test("maps an active Registrar generation to a content-free immutable Settings summary", async () => {
  const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
  const emptyProvider = createActiveSessionSummaryProvider(registrar);
  assert.equal(await emptyProvider(), null);

  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({
    sessionId: "active-summary-session",
    settingsRevision: 7,
    settings: receipt.defaults,
    capabilityReceipt: receipt
  }, activeNow);
  if (!snapshot.ok) throw new Error("Expected snapshot.");
  await registrar.startSession({ sessionId: "active-summary-session", settingsSnapshot: snapshot.value });

  const summary = await emptyProvider();
  assert.deepEqual(summary, {
    settingsRevision: 7,
    catalogVersion: receipt.catalogVersion,
    startedAt: activeNow.toISOString(),
    effectiveSettings: receipt.defaults
  });
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(JSON.stringify(summary).includes("active-summary-session"), false);
});
