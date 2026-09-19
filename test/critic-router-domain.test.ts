import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { OwnerSettingsDO, parseOwnerSettings, readCompatibleSettingsDocument, resolveEffectiveSessionSnapshot, validateOwnerSettings } from "../src/settings/index.ts";
import { parseCapabilityReceipt } from "../src/settings/capability-receipt.ts";
import type { CapabilityReceipt, OwnerSettings, SettingsStorage } from "../src/settings/index.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemorySettingsStorage } from "./fixtures/memory-settings-storage.ts";

function codexRoute(): OwnerSettings {
  const old = createCapabilityReceipt().defaults;
  return { ...old, critic: { provider: "codex", claude: old.critic.claude,
    codex: { modelId: "gpt-6-astra", reasoningEffort: "xhigh" } } };
}

function independentReceipt(): CapabilityReceipt {
  const base = createCapabilityReceipt();
  const current = { schemaVersion: "1" as const, status: "ready" as const, catalogVersion: "codex-receipt-2",
    issuedAt: base.issuedAt, expiresAt: base.expiresAt, trusted: true };
  return { ...base, codexModels: [...base.codexModels, {
    ...base.codexModels[0]!, productId: "gpt-6-astra", runtimeModelId: "gpt-6-astra", displayName: "GPT-6 Astra"
  }], claudeModels: [], providerReceipts: { codex: current, claude_code: {
    ...current, catalogVersion: "claude-receipt-1", status: "unavailable", trusted: false,
    issuedAt: "2026-08-14T00:00:00.000Z", expiresAt: "2026-08-15T00:00:00.000Z"
  } } };
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const oldDocument = () => ({ schemaVersion: "2", revision: 7, defaultsVersion: "historical-defaults",
  catalogVersion: "historical-catalog", settings: { codex: { modelId: "codex-current-primary", reasoningEffort: "high" },
    claude: { modelId: "retired-claude-model", reasoningEffort: "max" }, speedPreset: "ретельно" },
  actor: "owner", createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z" });

test("Codex critic validates Astra xhigh independently of the head and unavailable Claude", () => {
  const receipt = independentReceipt();
  const settings = codexRoute();
  const result = validateOwnerSettings(settings, receipt, activeNow);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.codex.runtimeModelId, "codex-runtime-primary");
  assert.equal(result.critic.runtimeModelId, "gpt-6-astra");
  assert.equal(result.value.critic.codex?.reasoningEffort, "xhigh");
  assert.equal(result.value.codex.reasoningEffort, "high");
  assert.deepEqual(result.value.critic.claude, settings.critic.claude);
  assert.equal(validateOwnerSettings(receipt.defaults, receipt, activeNow).ok, false);
  assert.notEqual(parseCapabilityReceipt(receipt, activeNow), undefined);
  assert.equal(validateOwnerSettings(settings, { ...receipt, providerReceipts: undefined } as unknown as CapabilityReceipt, activeNow).ok, true);
});

test("selected Claude requires Claude evidence; head Codex and critic Codex each need exact effort support", () => {
  const receipt = independentReceipt();
  assert.deepEqual(validateOwnerSettings(receipt.defaults, receipt, activeNow), { ok: false, code: "claude_catalog_unavailable" });
  const missingAstra = { ...receipt, codexModels: receipt.codexModels.filter((model) => model.productId !== "gpt-6-astra") };
  assert.deepEqual(validateOwnerSettings(codexRoute(), missingAstra, activeNow), { ok: false, code: "unknown_codex_model" });
  const unsupported = { ...receipt, codexModels: receipt.codexModels.map((model) => model.productId !== "gpt-6-astra" ? model :
    { ...model, supportedReasoningEfforts: ["high"], reasoningMappings: { high: "high" } }) };
  assert.deepEqual(validateOwnerSettings(codexRoute(), unsupported, activeNow), { ok: false, code: "codex_reasoning_effort_unavailable" });
  const unavailableHead = { ...receipt, codexModels: receipt.codexModels.map((model) => model.productId === "gpt-6-astra" ? model :
    { ...model, availability: "unavailable" as const }) };
  assert.deepEqual(validateOwnerSettings(codexRoute(), unavailableHead, activeNow), { ok: false, code: "codex_model_unavailable" });
});

test("active provider expiry fails closed while the inactive receipt does not affect Codex", () => {
  const receipt = independentReceipt();
  const expired = { ...receipt, providerReceipts: { ...receipt.providerReceipts!, codex: {
    ...receipt.providerReceipts!.codex, expiresAt: "2026-08-16T11:59:59.000Z" } } };
  assert.deepEqual(validateOwnerSettings(codexRoute(), expired, activeNow), { ok: false, code: "catalog_stale" });
  assert.equal(parseCapabilityReceipt({ ...receipt, providerReceipts: { codex: receipt.providerReceipts!.codex } }, activeNow), undefined);
});

test("strict branch structure rejects partial active settings and extra inactive privileges", () => {
  const settings = codexRoute();
  assert.deepEqual(parseOwnerSettings({ ...settings, critic: { ...settings.critic, codex: null } }), { ok: false, code: "critic_settings_required" });
  assert.deepEqual(parseOwnerSettings({ ...settings, critic: { ...settings.critic, provider: "automatic" } }), { ok: false, code: "invalid_critic_provider" });
  assert.deepEqual(parseOwnerSettings({ ...settings, critic: { ...settings.critic, claude: { ...settings.critic.claude, bypass: true } } }),
    { ok: false, code: "unexpected_settings_shape" });
  assert.equal(parseOwnerSettings({ ...settings, critic: { ...settings.critic, claude: null } }).ok, true);
  assert.deepEqual(parseOwnerSettings(oldDocument().settings), { ok: false, code: "unexpected_settings_shape" });
});

test("new immutable snapshot pins selected critic settings and all inactive preferences", () => {
  const settings = codexRoute();
  const result = resolveEffectiveSessionSnapshot({ sessionId: "critic-session", settingsRevision: 9,
    settings, capabilityReceipt: independentReceipt() }, activeNow);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(Object.isFrozen(result.value.settings.critic), true);
  assert.equal(Object.isFrozen(result.value.settings.critic.codex), true);
  assert.throws(() => { (result.value.settings.critic as { provider: string }).provider = "claude_code"; }, TypeError);
  assert.equal(result.value.speedPolicy.invariants.criticRequired, true);
  assert.equal(result.value.settings.critic.codex?.reasoningEffort, "xhigh");
});

test("v2 migration preserves unavailable historical Claude and exact values, then permits explicit Codex save", async () => {
  const storage = new MemorySettingsStorage();
  const historical = oldDocument();
  await storage.put("owner-settings:document", historical);
  await storage.put("immutable-active-snapshot", { settings: historical.settings });
  await storage.put("owner-settings:audit:7", { historical: true });
  const store = new OwnerSettingsDO({ storage, getCapabilityReceipt: independentReceipt, now: () => activeNow });
  const migration = await store.initialize();
  assert.equal(migration.ok, true);
  if (!migration.ok) return;
  assert.equal(migration.document.schemaVersion, "3");
  assert.equal(migration.document.revision, 8);
  assert.equal(migration.document.defaultsVersion, historical.defaultsVersion);
  assert.equal(migration.document.catalogVersion, historical.catalogVersion);
  assert.deepEqual(migration.document.settings.critic, { provider: "claude_code", claude: historical.settings.claude, codex: null });
  const read = await store.read();
  assert.equal(read?.effectiveIncompatibility, "claude_catalog_unavailable");
  assert.equal(read?.defaultsIncompatibility, "claude_catalog_unavailable");
  assert.deepEqual(await storage.get("immutable-active-snapshot"), { settings: historical.settings });
  assert.deepEqual(await storage.get("owner-settings:audit:7"), { historical: true });
  const saved = await store.save(codexRoute(), migration.etag, "critic-router-save-0001");
  assert.equal(saved.ok, true);
  assert.equal((await store.read())?.effectiveIncompatibility, null);
  const reset = await store.reset('"settings-9"', "critic-router-reset-0001");
  assert.deepEqual(reset, { ok: false, code: "claude_catalog_unavailable" });
  const restarted = await store.initialize();
  assert.equal(restarted.ok && restarted.document.revision, 9);
  assert.equal(restarted.ok && restarted.replayed, true);
});

test("historical save replay preserves body identity and ledger bytes even after migration and expiry", async () => {
  const storage = new MemorySettingsStorage();
  const historical = oldDocument();
  const ledger = [{ key: "critic-historical-key-0001", bodyHash: hash({ action: "save", settings: historical.settings }),
    document: historical, expiresAt: "2026-08-17T00:00:00.000Z" }];
  await storage.put("owner-settings:document", historical);
  await storage.put("owner-settings:idempotency-ledger", ledger);
  const store = new OwnerSettingsDO({ storage, getCapabilityReceipt: independentReceipt, now: () => activeNow });
  await store.initialize();
  const replay = await store.save(historical.settings, '"settings-6"', ledger[0]!.key);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.replayed, true);
  assert.equal(replay.document.revision, 7);
  assert.equal(replay.etag, '"settings-7"');
  assert.deepEqual(replay.document.settings.critic.claude, historical.settings.claude);
  assert.deepEqual(await storage.get("owner-settings:idempotency-ledger"), ledger);
  assert.equal((await store.read())?.document.revision, 8);
  assert.deepEqual(await store.save({ ...historical.settings, speedPreset: "швидко" }, '"settings-6"', ledger[0]!.key),
    { ok: false, code: "idempotency_conflict" });
  assert.deepEqual(await store.save(historical.settings, '"settings-8"', "new-key-old-body-0001"),
    { ok: false, code: "unexpected_settings_shape" });
});

test("historical reset replay uses its original confirmed operation rather than today's default availability", async () => {
  const storage = new MemorySettingsStorage();
  const historical = oldDocument();
  await storage.put("owner-settings:document", historical);
  const ledger = [{ key: "historical-reset-key-0001", bodyHash: hash({ action: "reset", settings: historical.settings }),
    document: historical, expiresAt: "2026-08-17T00:00:00.000Z" }];
  await storage.put("owner-settings:idempotency-ledger", ledger);
  const store = new OwnerSettingsDO({ storage, getCapabilityReceipt: independentReceipt, now: () => activeNow });
  await store.initialize();
  const replay = await store.reset('"settings-6"', ledger[0]!.key);
  assert.equal(replay.ok && replay.replayed, true);
  assert.equal(replay.ok && replay.document.revision, 7);
  assert.deepEqual(await storage.get("owner-settings:idempotency-ledger"), ledger);
});

test("unknown schemas and malformed v1 settings are never overwritten by initialization", async () => {
  for (const historical of [{ ...oldDocument(), schemaVersion: "4" }, { ...oldDocument(), schemaVersion: "1" }]) {
    const storage = new MemorySettingsStorage();
    await storage.put("owner-settings:document", historical);
    const store = new OwnerSettingsDO({ storage, getCapabilityReceipt: createCapabilityReceipt, now: () => activeNow });
    assert.deepEqual(await store.initialize(), { ok: false, code: "not_initialized" });
    assert.deepEqual(await storage.get("owner-settings:document"), historical);
  }
});

test("v1 historical reader retains unsupported shared depth instead of defaulting or substituting models", () => {
  const historical = { ...oldDocument(), schemaVersion: "1", settings: {
    codexModelId: "retired-codex", claudeModelId: "retired-claude", reasoningDepth: "xhigh", speedPreset: "ретельно" } };
  const before = structuredClone(historical);
  const projected = readCompatibleSettingsDocument(historical);
  assert.deepEqual(projected?.settings.codex, { modelId: "retired-codex", reasoningEffort: "xhigh" });
  assert.deepEqual(projected?.settings.critic.claude, { modelId: "retired-claude", reasoningEffort: "xhigh" });
  assert.deepEqual(historical, before);
});

class AtomicTestStorage implements SettingsStorage {
  values = new Map<string, unknown>();
  failAudit = false;
  #queue: Promise<void> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async transaction<T>(operation: (storage: SettingsStorage) => Promise<T>): Promise<T> {
    const prior = this.#queue;
    let unlock = () => {};
    this.#queue = new Promise<void>((resolve) => { unlock = resolve; });
    await prior;
    const draft = new Map(structuredClone(this.values));
    const transaction: SettingsStorage = {
      get: async <V>(key: string) => structuredClone(draft.get(key)) as V | undefined,
      put: async <V>(key: string, value: V) => {
        if (this.failAudit && key.startsWith("owner-settings:audit:")) throw new Error("audit fault");
        draft.set(key, structuredClone(value));
      },
      transaction: async <V>(nested: (storage: SettingsStorage) => Promise<V>) => nested(transaction)
    };
    try { const result = await operation(transaction); this.values = draft; return result; }
    finally { unlock(); }
  }
}

test("migration is atomic on audit failure and concurrent initialization migrates once", async () => {
  const storage = new AtomicTestStorage();
  const historical = oldDocument();
  await storage.put("owner-settings:document", historical);
  const store = new OwnerSettingsDO({ storage, getCapabilityReceipt: independentReceipt, now: () => activeNow });
  storage.failAudit = true;
  await assert.rejects(store.initialize(), /audit fault/u);
  assert.deepEqual(await storage.get("owner-settings:document"), historical);
  assert.equal(await store.getAuditRecord(8), undefined);
  storage.failAudit = false;
  const initialized = await Promise.all([store.initialize(), store.initialize()]);
  assert.equal(initialized.filter((result) => result.ok && !result.replayed).length, 1);
  assert.equal(initialized.every((result) => result.ok && result.document.revision === 8), true);
  assert.equal((await store.getAuditRecord(8))?.action, "migrate");
});
