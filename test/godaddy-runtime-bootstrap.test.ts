import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeBootstrap } from "../src/godaddy/runtime-bootstrap.ts";
import { ClaudeDiscoveryFailure, type GoDaddyClaudeCodeProcess } from "../src/godaddy/claude-code-process.ts";
import type { MySqlPool } from "../src/godaddy/mysql-storage.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import type { GoDaddyCodexAppServer } from "../src/godaddy/codex-app-server-process.ts";
import type { CapabilityReceipt } from "../src/settings/types.ts";

function fixture(discoverModels: GoDaddyClaudeCodeProcess["discoverModels"], failStorage = false) {
  const receipt = createCapabilityReceipt();
  let writes = 0;
  const pool: MySqlPool = {
    execute: async (statement) => {
      if (statement.startsWith('INSERT')) { writes++; if (failStorage) throw new Error('DB-SECRET'); }
      return [[], []];
    },
    getConnection: async () => { throw new Error('Unexpected connection'); }
  };
  const runtime = createRuntimeBootstrap({ environment: {}, pool, initialCatalog: receipt, now: () => activeNow,
    codex: {
      inspectSubscription: async () => ({ runtime: { readiness: 'ready', authMode: 'chatgpt_oauth', privateSingleOwner: true,
        availableModelIds: receipt.codexModels.map(m => m.productId) }, models: receipt.codexModels, defaultModelId: receipt.defaults.codex.modelId }),
      resetAuthorization: async () => { throw new Error('No reset authorized'); }, startDeviceAuthorization: async () => undefined, close: async () => {}
    },
    claude: {
      processRef: 'test-claude',
      inspectSubscription: async () => ({ processRef: 'test-claude', readiness: 'ready', authMode: 'claude_code_oauth', privateSingleOwner: true,
        bareMode: false, fastModeEnabled: false, extraUsageEnabled: false, models: receipt.claudeModels }),
      discoverModels, runCritique: async () => { throw new Error('Unexpected critique'); }
    }
  });
  return { runtime, receipt, writes: () => writes };
}

test('bootstrap preserves safe discovery failures and does not write or replace a valid catalog', async () => {
  for (const code of ['claude_auth_rejected', 'claude_access_denied', 'claude_quota_blocked', 'claude_cli_incompatible', 'claude_process_failed', 'claude_invalid_response', 'claude_models_unavailable'] as const) {
    const h = fixture(async () => { throw new ClaudeDiscoveryFailure(code); });
    assert.deepEqual(await h.runtime.refreshCatalog("claude_code"), { ok: false, code });
    assert.equal(h.writes(), 0);
    assert.deepEqual(await h.runtime.loadCatalog(), h.receipt);
  }
});

test('bootstrap distinguishes empty models, unexpected exceptions and storage failures', async () => {
  const empty = fixture(async () => []);
  assert.deepEqual(await empty.runtime.refreshCatalog("claude_code"), { ok: false, code: 'claude_models_unavailable' });
  const unexpected = fixture(async () => { throw new Error('RAW-PROVIDER-SECRET'); });
  assert.deepEqual(await unexpected.runtime.refreshCatalog("claude_code"), { ok: false, code: 'catalog_refresh_failed' });
  const storage = fixture(async () => createCapabilityReceipt().claudeModels, true);
  assert.deepEqual(await storage.runtime.refreshCatalog("claude_code"), { ok: false, code: 'catalog_storage_failed' });
  assert.equal(storage.writes(), 1);
  assert.deepEqual(await storage.runtime.loadCatalog(), storage.receipt);
});

function routerFixture(input: {
  verify?: GoDaddyCodexAppServer["verifyModelSelection"];
  initialCatalog?: CapabilityReceipt;
  inspectCodex?: () => Promise<void>;
  inspectClaude?: () => Promise<void>;
  runCritique?: GoDaddyClaudeCodeProcess["runCritique"];
  now?: () => Date;
  codexReadiness?: "ready" | "auth_required" | "quota_blocked" | "unavailable";
} = {}) {
  const source = input.initialCatalog ?? createCapabilityReceipt();
  const models = [...source.codexModels, { ...source.codexModels[0]!, productId: "astra-subscription-id",
    runtimeModelId: "gpt-6-astra", displayName: "GPT-6 Astra" }];
  const calls = { codex: 0, claude: 0, discovery: 0, writes: [] as CapabilityReceipt[], verified: [] as unknown[][] };
  const pool: MySqlPool = {
    execute: async (sql, values) => {
      if (sql.startsWith("INSERT")) calls.writes.push(JSON.parse(String(values[2])) as CapabilityReceipt);
      return [[], []];
    }, getConnection: async () => { throw new Error("Unexpected transaction"); }
  };
  const runtime = createRuntimeBootstrap({ environment: {}, pool, initialCatalog: source, now: input.now ?? (() => activeNow),
    codex: {
      inspectSubscription: async () => {
        calls.codex++; await input.inspectCodex?.();
        return { runtime: { readiness: input.codexReadiness ?? "ready", authMode: "chatgpt_oauth", privateSingleOwner: true,
          availableModelIds: models.map(model => model.productId) }, models, defaultModelId: source.defaults.codex.modelId };
      },
      ...(input.verify === undefined ? {} : { verifyModelSelection: async (model: string, effort: string) => {
        calls.verified.push([model, effort]); return input.verify!(model, effort);
      } }),
      resetAuthorization: async () => { throw new Error("No reset authorized"); }, startDeviceAuthorization: async () => undefined, close: async () => {}
    },
    claude: {
      processRef: "router-claude",
      inspectSubscription: async () => {
        calls.claude++; await input.inspectClaude?.();
        return { processRef: "router-claude", readiness: "ready", authMode: "claude_code_oauth", privateSingleOwner: true,
          bareMode: false, fastModeEnabled: false, extraUsageEnabled: false, models: source.claudeModels };
      },
      discoverModels: async () => { calls.discovery++; return source.claudeModels.map(model => ({ ...model, displayName: "Fresh Claude" })); },
      runCritique: input.runCritique ?? (async () => { throw new Error("Unexpected critique"); })
    }
  });
  return { runtime, source, calls };
}

test("default Codex refresh/status never call, await or probe inactive Claude", async () => {
  const h = routerFixture({ inspectClaude: async () => { throw new Error("Inactive Claude must never run"); }, verify: async () => true });
  const status = await h.runtime.status();
  assert.equal(status.codex, "ready");
  assert.equal(status.claude, "not_checked");
  const result = await h.runtime.refreshCatalog();
  assert.equal(result.ok, true);
  assert.equal(h.calls.claude, 0);
  assert.equal(h.calls.discovery, 0);
  assert.deepEqual(h.calls.verified, [["gpt-6-astra", "xhigh"]]);
  if (result.ok) {
    assert.equal(result.receipt.codexModels.at(-1)?.availability, "available");
    assert.deepEqual(result.receipt.claudeModels, h.source.claudeModels);
  }
});

const expiredReceipt = () => createCapabilityReceipt({ issuedAt: "2026-08-14T00:00:00.000Z", expiresAt: "2026-08-15T00:00:00.000Z" });
const codexOnlySettings = () => ({ ...createCapabilityReceipt().defaults,
  critic: { ...createCapabilityReceipt().defaults.critic, provider: "codex" as const,
    codex: { ...createCapabilityReceipt().defaults.codex } } });

test("unattended expired Codex catalog revalidates once for concurrent consultations without inactive Claude or unselected Astra probes", async () => {
  let release = () => {}; let entered = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const h = routerFixture({ initialCatalog: expiredReceipt(), inspectCodex: async () => { entered(); await hold; },
    inspectClaude: async () => { assert.fail("inactive Claude"); }, verify: async () => { assert.fail("unselected Astra"); } });
  const settings = codexOnlySettings(); const before = JSON.stringify(settings);
  const one = h.runtime.ensureCatalogForSettings!(settings);
  await started;
  const two = h.runtime.ensureCatalogForSettings!(settings);
  assert.equal(one, two); assert.equal(h.calls.codex, 1);
  release();
  const result = await one;
  assert.ok(result);
  assert.equal(result.catalogVersion, h.source.catalogVersion, "route renewal must preserve the immutable catalog identity");
  assert.equal(result.issuedAt, activeNow.toISOString());
  assert.deepEqual(result.defaults, h.source.defaults);
  assert.equal(result.providerReceipts?.claude_code.expiresAt, h.source.expiresAt);
  assert.equal(h.calls.claude, 0); assert.equal(h.calls.discovery, 0); assert.deepEqual(h.calls.verified, []);
  assert.equal(h.calls.writes.length, 1); assert.equal(JSON.stringify(settings), before);
  assert.deepEqual(await h.runtime.ensureCatalogForSettings!(settings), result);
  assert.equal(h.calls.codex, 1);
});

test("independent GoDaddy processes renew one immutable session route with the same catalog version", async () => {
  const source = expiredReceipt();
  const settings = codexOnlySettings();
  const first = routerFixture({ initialCatalog: source, now: () => activeNow });
  const second = routerFixture({ initialCatalog: source, now: () => new Date(activeNow.getTime() + 1_000) });

  const [one, two] = await Promise.all([
    first.runtime.ensureCatalogForSettings!(settings, source.catalogVersion),
    second.runtime.ensureCatalogForSettings!(settings, source.catalogVersion)
  ]);

  assert.ok(one); assert.ok(two);
  assert.equal(one.catalogVersion, source.catalogVersion);
  assert.equal(two.catalogVersion, source.catalogVersion);
  assert.notEqual(one.issuedAt, two.issuedAt, "the proof envelopes may be renewed independently");
});

test("unattended revalidation never revives ended subscriptions and bounds repeated failure probes", async () => {
  for (const codexReadiness of ["auth_required", "quota_blocked", "unavailable"] as const) {
    let now = activeNow;
    const h = routerFixture({ initialCatalog: expiredReceipt(), codexReadiness, now: () => now });
    assert.equal(await h.runtime.ensureCatalogForSettings!(codexOnlySettings()), undefined);
    assert.equal(await h.runtime.ensureCatalogForSettings!(codexOnlySettings()), undefined);
    assert.equal(h.calls.codex, 1); assert.equal(h.calls.writes.length, 0);
    assert.equal(await h.runtime.loadCatalog(), undefined);
    now = new Date(now.getTime() + 30_001);
    assert.equal(await h.runtime.ensureCatalogForSettings!(codexOnlySettings()), undefined);
    assert.equal(h.calls.codex, 2);
  }
});

test("unattended Claude revalidation invokes only the saved model and effort with no consultation content", async () => {
  const probes: unknown[] = [];
  const h = routerFixture({ initialCatalog: expiredReceipt(), runCritique: async input => {
    probes.push(input); return { turnRef: "synthetic-probe", body: "READY" };
  } });
  const settings = h.source.defaults;
  const result = await h.runtime.ensureCatalogForSettings!(settings);
  assert.ok(result);
  assert.equal(h.calls.claude, 1); assert.equal(h.calls.discovery, 0);
  assert.deepEqual(probes, [{ modelId: "claude-current-critic", runtimeModelId: "claude-runtime-critic",
    reasoningEffort: "high", prompt: "Reply with the single word READY. Do not use tools." }]);
  assert.deepEqual(result.claudeModels[0]?.supportedReasoningEfforts, ["high"]);
  assert.equal(result.providerReceipts?.claude_code.issuedAt, activeNow.toISOString());
  assert.deepEqual(result.defaults, settings);
});

test("unattended Claude probe failure leaves historical evidence expired and emits no raw error", async () => {
  const h = routerFixture({ initialCatalog: expiredReceipt(), runCritique: async () => { throw new Error("PRIVATE-OAUTH-MATERIAL"); } });
  assert.equal(await h.runtime.ensureCatalogForSettings!(h.source.defaults), undefined);
  assert.equal(h.calls.writes.length, 0); assert.equal(h.calls.discovery, 0);
  assert.equal(await h.runtime.loadCatalog(), undefined);
});

test("unattended revalidation refuses unknown historical choices instead of choosing defaults", async () => {
  const h = routerFixture({ initialCatalog: expiredReceipt() });
  const settings = { ...codexOnlySettings(), codex: { modelId: "new-unconfirmed-model", reasoningEffort: "high" } };
  assert.equal(await h.runtime.ensureCatalogForSettings!(settings), undefined);
  assert.equal(h.calls.codex, 0); assert.equal(h.calls.writes.length, 0);
});

test("unattended Astra renewal proves the exact saved xhigh route, never an unselected effort", async () => {
  const model = { ...expiredReceipt().codexModels[0]!, productId: "confirmed-astra", runtimeModelId: "gpt-6-astra" };
  const source = expiredReceipt();
  const old = { ...source, codexModels: [...source.codexModels, model] };
  for (const effort of ["xhigh", "high"]) {
    const h = routerFixture({ initialCatalog: old, verify: async () => true });
    const settings = { ...codexOnlySettings(), critic: { ...codexOnlySettings().critic,
      codex: { modelId: model.productId, reasoningEffort: effort } } };
    const result = await h.runtime.ensureCatalogForSettings!(settings);
    if (effort === "xhigh") {
      assert.ok(result); assert.deepEqual(h.calls.verified, [["gpt-6-astra", "xhigh"]]);
    } else { assert.equal(result, undefined); assert.deepEqual(h.calls.verified, []); }
    assert.equal(h.calls.claude, 0);
  }
});

test("shutdown drains an in-flight capability probe before provider teardown and cannot publish it afterward", async () => {
  let release = () => {}; let entered = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const h = routerFixture({ initialCatalog: expiredReceipt(), inspectCodex: async () => { entered(); await hold; } });
  const probe = h.runtime.ensureCatalogForSettings!(codexOnlySettings());
  await started;
  let closed = false;
  const stopping = h.runtime.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release();
  assert.equal(await probe, undefined); await stopping;
  assert.equal(h.calls.writes.length, 0);
  assert.equal(await h.runtime.ensureCatalogForSettings!(codexOnlySettings()), undefined);
});

test("fresh catalog does not invoke a probe and expired selected-provider receipt does", async () => {
  const fresh = routerFixture();
  assert.deepEqual(await fresh.runtime.ensureCatalogForSettings!(codexOnlySettings()), fresh.source);
  assert.equal(fresh.calls.codex, 0);
  const historical = expiredReceipt();
  const old = { schemaVersion: "1" as const, status: "ready" as const, catalogVersion: historical.catalogVersion,
    issuedAt: historical.issuedAt, expiresAt: historical.expiresAt, trusted: true };
  const h = routerFixture({ initialCatalog: createCapabilityReceipt({ providerReceipts: { codex: old, claude_code: old } }) });
  assert.ok(await h.runtime.ensureCatalogForSettings!(codexOnlySettings()));
  assert.equal(h.calls.codex, 1);
});

test("Astra verification absent, rejected or throwing keeps other Codex models and marks only Astra unavailable", async () => {
  for (const verify of [undefined, async () => false, async () => { throw new Error("PRIVATE-PROBE-ERROR"); }]) {
    const h = routerFixture(verify === undefined ? {} : { verify });
    const result = await h.runtime.refreshCatalog();
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.receipt.codexModels[0]?.availability, "available");
    assert.equal(result.receipt.codexModels.at(-1)?.availability, "unavailable");
    assert.equal(JSON.stringify(result).includes("PRIVATE-PROBE"), false);
    assert.equal(h.calls.claude, 0);
    assert.equal(h.calls.writes.length, 1);
  }
});

test("partial Codex refresh retains expired inactive evidence and historical default selection", async () => {
  const source = createCapabilityReceipt({ issuedAt: "2026-08-14T00:00:00.000Z", expiresAt: "2026-08-15T00:00:00.000Z" });
  const h = routerFixture({ initialCatalog: source, verify: async () => true });
  assert.equal(await h.runtime.loadCatalog(), undefined);
  const result = await h.runtime.refreshCatalog();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.receipt.defaults, source.defaults);
  assert.deepEqual(result.receipt.claudeModels, source.claudeModels);
  assert.equal(result.receipt.providerReceipts?.claude_code.expiresAt, source.expiresAt);
  assert.notEqual(result.receipt.expiresAt, source.expiresAt);
  assert.equal(h.calls.claude, 0);
});

test("concurrent Claude and Codex refreshes serialize and preserve the most recent inactive Claude receipt", async () => {
  let release = () => {};
  let started = () => {};
  const entered = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const h = routerFixture({ verify: async () => true, inspectCodex: async () => {
    if (first) { first = false; started(); await hold; }
  } });
  const claudeRefresh = h.runtime.refreshCatalog("claude_code");
  await entered;
  const codexRefresh = h.runtime.refreshCatalog();
  await Promise.resolve();
  assert.equal(h.calls.codex, 1);
  release();
  const [claude, codex] = await Promise.all([claudeRefresh, codexRefresh]);
  assert.equal(claude.ok, true);
  assert.equal(codex.ok, true);
  assert.equal(h.calls.claude, 1);
  assert.equal(h.calls.discovery, 1);
  assert.equal(h.calls.writes.length, 2);
  if (claude.ok && codex.ok) {
    assert.deepEqual(codex.receipt.providerReceipts?.claude_code, claude.receipt.providerReceipts?.claude_code);
    assert.deepEqual(codex.receipt.claudeModels, claude.receipt.claudeModels);
    assert.equal(codex.receipt.claudeModels[0]?.displayName, "Fresh Claude");
  }
});

test("subscription inspection exceptions return safe unavailable status or refresh failure", async () => {
  const h = routerFixture({ inspectCodex: async () => { throw new Error("PRIVATE-CODEX-ERROR"); } });
  assert.deepEqual(await h.runtime.status(), { codex: "unavailable", claude: "not_checked" });
  assert.deepEqual(await h.runtime.refreshCatalog(), { ok: false, code: "catalog_refresh_failed" });
  assert.equal(h.calls.writes.length, 0);
  const claude = routerFixture({ inspectClaude: async () => { throw new Error("PRIVATE-CLAUDE-ERROR"); } });
  assert.equal((await claude.runtime.status("claude_code")).claude, "unavailable");
  assert.deepEqual(await claude.runtime.refreshCatalog("claude_code"), { ok: false, code: "catalog_refresh_failed" });
});
