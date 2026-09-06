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
  const runtime = createRuntimeBootstrap({ environment: {}, pool, initialCatalog: source, now: () => activeNow,
    codex: {
      inspectSubscription: async () => {
        calls.codex++; await input.inspectCodex?.();
        return { runtime: { readiness: "ready", authMode: "chatgpt_oauth", privateSingleOwner: true,
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
      runCritique: async () => { throw new Error("Unexpected critique"); }
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
