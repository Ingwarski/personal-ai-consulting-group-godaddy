import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeBootstrap } from "../src/godaddy/runtime-bootstrap.ts";
import { ClaudeDiscoveryFailure, type GoDaddyClaudeCodeProcess } from "../src/godaddy/claude-code-process.ts";
import type { MySqlPool } from "../src/godaddy/mysql-storage.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

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
    assert.deepEqual(await h.runtime.refreshCatalog(), { ok: false, code });
    assert.equal(h.writes(), 0);
    assert.deepEqual(await h.runtime.loadCatalog(), h.receipt);
  }
});

test('bootstrap distinguishes empty models, unexpected exceptions and storage failures', async () => {
  const empty = fixture(async () => []);
  assert.deepEqual(await empty.runtime.refreshCatalog(), { ok: false, code: 'claude_models_unavailable' });
  const unexpected = fixture(async () => { throw new Error('RAW-PROVIDER-SECRET'); });
  assert.deepEqual(await unexpected.runtime.refreshCatalog(), { ok: false, code: 'catalog_refresh_failed' });
  const storage = fixture(async () => createCapabilityReceipt().claudeModels, true);
  assert.deepEqual(await storage.runtime.refreshCatalog(), { ok: false, code: 'catalog_storage_failed' });
  assert.equal(storage.writes(), 1);
  assert.deepEqual(await storage.runtime.loadCatalog(), storage.receipt);
});
