import assert from "node:assert/strict";
import test from "node:test";

import { OwnerSettingsDO, type ActiveSessionSummary } from "../src/settings/index.ts";
import type { CapabilityReceipt } from "../src/settings/types.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemorySettingsStorage } from "./fixtures/memory-settings-storage.ts";

const firstKey = "settings-save-key-0001";
const secondKey = "settings-save-key-0002";

function createStore(input: Readonly<{ activeSession?: () => Promise<ActiveSessionSummary | null> }> = {}) {
  let now = new Date(activeNow);
  const storage = new MemorySettingsStorage();
  let receipt: CapabilityReceipt = createCapabilityReceipt();
  const store = new OwnerSettingsDO({
    storage,
    getCapabilityReceipt: () => receipt,
    ...(input.activeSession === undefined ? {} : { getActiveSessionSummary: input.activeSession }),
    now: () => now
  });

  return {
    store,
    storage,
    advanceClock(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
    setReceipt(next: CapabilityReceipt) {
      receipt = next;
    }
  };
}

test("initializes one complete default revision and exposes explicit effective values", async () => {
  const { store } = createStore();
  const initialized = await store.initialize();

  assert.equal(initialized.ok, true);
  if (!initialized.ok) return;
  assert.equal(initialized.document.revision, 1);
  assert.equal(initialized.etag, '"settings-1"');

  const read = await store.read();
  assert.notEqual(read, undefined);
  assert.equal(read?.document.settings.speedPreset, "збалансовано");
  assert.deepEqual(read?.effectiveForNextSession, read?.document.settings);
  assert.equal(read?.activeSessionSnapshot, null);
  assert.equal(read?.activeSessionStatus, "unavailable");
});

test("migrates a prior shared-effort document into independent provider settings without inventing a fallback", async () => {
  const { store, storage } = createStore();
  await storage.put("owner-settings:document", {
    schemaVersion: "1",
    revision: 4,
    defaultsVersion: "catalog-2026-08-16-r1",
    catalogVersion: "catalog-2026-08-16-r1",
    settings: {
      codexModelId: "codex-current-primary",
      claudeModelId: "claude-current-critic",
      reasoningDepth: "xhigh",
      speedPreset: "ретельно"
    },
    createdAt: "2026-08-16T10:00:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
    actor: "owner"
  });

  const migrated = await store.initialize();
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  assert.equal(migrated.document.schemaVersion, "3");
  assert.equal(migrated.document.revision, 5);
  assert.equal(migrated.document.settings.codex.reasoningEffort, "xhigh");
  assert.equal(migrated.document.settings.critic.claude?.reasoningEffort, "xhigh");
  assert.equal((await store.read())?.effectiveIncompatibility, "claude_reasoning_effort_unavailable");
  assert.equal(migrated.document.settings.speedPreset, "ретельно");
  const audit = await store.getAuditRecord(5);
  assert.equal(audit?.action, "migrate");
  assert.equal(audit?.actor, "system");
});

test("keeps a bounded idempotency ledger while preserving exact in-window replay", async () => {
  const { store, storage } = createStore();
  await store.initialize();
  const base = createCapabilityReceipt().defaults;
  let lastSettings = base;
  let lastKey = "";
  for (let index = 0; index < 65; index += 1) {
    lastSettings = { ...base, speedPreset: index % 2 === 0 ? "швидко" : "ретельно" };
    lastKey = `bounded-settings-key-${String(index).padStart(4, "0")}`;
    const result = await store.save(lastSettings, `"settings-${index + 1}"`, lastKey);
    assert.equal(result.ok, true);
  }

  const ledger = await storage.get<readonly { key: string }[]>("owner-settings:idempotency-ledger");
  assert.equal(ledger?.length, 64);
  assert.equal(ledger?.some((entry) => entry.key === "bounded-settings-key-0000"), false);
  const replay = await store.save(lastSettings, '"settings-1"', lastKey);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.replayed, true);
    assert.equal(replay.document.revision, 66);
  }
});

test("revalidates the stored set against the current catalog without mutating it", async () => {
  const { store, setReceipt } = createStore();
  await store.initialize();
  const before = await store.read();
  const receipt = createCapabilityReceipt();
  setReceipt(createCapabilityReceipt({
    catalogVersion: "catalog-2026-08-16-r2",
    codexModels: [
      ...receipt.codexModels.map((model) => ({ ...model, availability: "unavailable" as const })),
      {
        ...receipt.codexModels[0]!,
        productId: "codex-new-primary",
        runtimeModelId: "codex-new-runtime",
        displayName: "Codex new primary"
      }
    ],
    defaults: { ...receipt.defaults, codex: { ...receipt.defaults.codex, modelId: "codex-new-primary" } }
  }));

  const drifted = await store.read();
  assert.equal(drifted?.effectiveForNextSession, null);
  assert.equal(drifted?.effectiveIncompatibility, "codex_model_unavailable");
  assert.deepEqual(drifted?.document, before?.document);
});

test("distinguishes no active session from an unavailable provider and exposes only a pinned safe summary", async () => {
  const noActive = createStore({ activeSession: async () => null });
  await noActive.store.initialize();
  assert.equal((await noActive.store.read())?.activeSessionStatus, "none");

  const pinned: ActiveSessionSummary = {
    settingsRevision: 1,
    catalogVersion: "catalog-2026-08-16-r1",
    startedAt: "2026-08-16T12:00:00.000Z",
    effectiveSettings: createCapabilityReceipt().defaults
  };
  const active = createStore({ activeSession: async () => pinned });
  await active.store.initialize();
  await active.store.save({ ...pinned.effectiveSettings, speedPreset: "ретельно" }, '"settings-1"', firstKey);
  const read = await active.store.read();
  assert.equal(read?.document.revision, 2);
  assert.deepEqual(read?.activeSessionSnapshot, pinned);
  assert.equal(read?.activeSessionStatus, "active");
  assert.equal(read?.activeSessionSnapshot?.settingsRevision, 1);
});

test("writes exactly one full validated revision with an If-Match precondition", async () => {
  const { store, advanceClock } = createStore();
  await store.initialize();
  advanceClock(1_000);
  const saved = await store.save(
    {
      codex: { modelId: "codex-current-primary", reasoningEffort: "medium" },
      critic: { provider: "claude_code", claude: { modelId: "claude-current-critic", reasoningEffort: "medium" }, codex: null },
      speedPreset: "ретельно"
    },
    '"settings-1"',
    firstKey
  );

  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.replayed, false);
  assert.equal(saved.document.revision, 2);
  assert.equal(saved.document.settings.speedPreset, "ретельно");
  assert.equal(saved.etag, '"settings-2"');

  const audit = await store.getAuditRecord(2);
  assert.equal(audit?.action, "save");
  assert.equal(audit?.actor, "owner");
  assert.equal(audit?.revision, 2);
  assert.match(audit?.requestHash ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(audit).includes("codex-current-primary"), false);
});

test("rejects a stale revision without changing any persisted setting", async () => {
  const { store } = createStore();
  await store.initialize();
  const before = await store.read();
  const rejected = await store.save(
    { ...before?.document.settings, speedPreset: "швидко" },
    '"settings-0"',
    firstKey
  );

  assert.deepEqual(rejected, { ok: false, code: "revision_conflict" });
  const after = await store.read();
  assert.equal(after?.document.revision, before?.document.revision);
  assert.equal(after?.document.settings.speedPreset, "збалансовано");
});

test("returns an idempotent replay, but rejects the same key with a different body", async () => {
  const { store } = createStore();
  await store.initialize();
  const settings = {
    codex: { modelId: "codex-current-primary", reasoningEffort: "medium" },
    critic: { provider: "claude_code", claude: { modelId: "claude-current-critic", reasoningEffort: "medium" }, codex: null },
    speedPreset: "швидко"
  } as const;
  const first = await store.save(settings, '"settings-1"', firstKey);
  const replay = await store.save(settings, '"settings-1"', firstKey);
  const conflict = await store.save({ ...settings, speedPreset: "ретельно" }, '"settings-1"', firstKey);

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.replayed, true);
    assert.equal(replay.document.revision, 2);
  }
  assert.deepEqual(conflict, { ok: false, code: "idempotency_conflict" });
});

test("reset is explicit, revalidates defaults and creates a single new revision", async () => {
  const { store } = createStore();
  await store.initialize();
  await store.save(
    {
      codex: { modelId: "codex-current-primary", reasoningEffort: "medium" },
      critic: { provider: "claude_code", claude: { modelId: "claude-current-critic", reasoningEffort: "medium" }, codex: null },
      speedPreset: "швидко"
    },
    '"settings-1"',
    firstKey
  );
  const reset = await store.reset('"settings-2"', secondKey);

  assert.equal(reset.ok, true);
  if (!reset.ok) return;
  assert.equal(reset.document.revision, 3);
  assert.equal(reset.document.settings.codex.reasoningEffort, "high");
  assert.equal(reset.document.settings.critic.claude?.reasoningEffort, "high");
  assert.equal(reset.document.settings.speedPreset, "збалансовано");
  const audit = await store.getAuditRecord(3);
  assert.equal(audit?.action, "reset");
  assert.equal(audit?.actor, "owner");
  assert.match(audit?.requestHash ?? "", /^[a-f0-9]{64}$/u);
});
