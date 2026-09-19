import assert from "node:assert/strict";
import test from "node:test";

import { createCsrfTokenService, importCsrfHmacKey } from "../src/access/csrf.ts";
import { createVerifiedSettingsGateway } from "../src/settings/gateway.ts";
import { OwnerSettingsDO } from "../src/settings/owner-settings-do.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemorySettingsStorage } from "./fixtures/memory-settings-storage.ts";

const binding = { principal: "owner" as const, audience: "settings-audience", origin: "https://settings.example.test" };

async function gatewayHarness() {
  const receipt = createCapabilityReceipt();
  const ownerSettings = new OwnerSettingsDO({
    storage: new MemorySettingsStorage(),
    getCapabilityReceipt: () => receipt,
    now: () => activeNow
  });
  const key = await importCsrfHmacKey("only-for-a-local-deterministic-test-secret-123456");
  if (key === undefined) throw new Error("Expected HMAC key.");
  const csrf = createCsrfTokenService({ key, now: () => activeNow });
  return {
    ownerSettings,
    csrf,
    gateway: createVerifiedSettingsGateway({
      ownerSettings,
      getCapabilityReceipt: () => receipt,
      csrf,
      csrfBinding: binding,
      now: () => activeNow
    })
  };
}

test("one verified local gateway wires the settings page and API to the same durable settings object", async () => {
  const { gateway, csrf, ownerSettings } = await gatewayHarness();
  const page = await gateway.handle(new Request(`${binding.origin}/settings`));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Налаштування власника/);
  assert.equal(page.headers.get("cache-control"), "no-store");

  const read = await gateway.handle(new Request(`${binding.origin}/api/settings`));
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("etag"), '"settings-1"');

  const token = await csrf.issue(binding, new Date("2026-08-16T12:05:00.000Z"));
  const saved = await gateway.handle(new Request(`${binding.origin}/api/settings`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "if-match": '"settings-1"',
      "idempotency-key": "settings-gateway-key-0001",
      origin: binding.origin,
      "sec-fetch-site": "same-origin",
      "x-csrf-token": token
    },
    body: JSON.stringify({
      ...createCapabilityReceipt().defaults,
      codex: { ...createCapabilityReceipt().defaults.codex, reasoningEffort: "medium" }
    })
  }));
  assert.equal(saved.status, 200);
  assert.equal((await ownerSettings.read())?.document.settings.codex.reasoningEffort, "medium");
});

test("the verified gateway still refuses an unsafe mutation and unsupported method", async () => {
  const { gateway } = await gatewayHarness();
  const forbidden = await gateway.handle(new Request(`${binding.origin}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createCapabilityReceipt().defaults)
  }));
  assert.equal(forbidden.status, 403);

  const notAllowed = await gateway.handle(new Request(`${binding.origin}/settings`, { method: "POST" }));
  assert.equal(notAllowed.status, 405);
});

test("an Access-verified same-origin request can renew CSRF without persisting or auto-using the token", async () => {
  const { gateway, ownerSettings } = await gatewayHarness();
  const denied = await gateway.handle(new Request(`${binding.origin}/api/settings/csrf`, {
    method: "POST",
    headers: { origin: "https://other.example.test", "sec-fetch-site": "cross-site" }
  }));
  assert.equal(denied.status, 403);

  const issued = await gateway.handle(new Request(`${binding.origin}/api/settings/csrf`, {
    method: "POST",
    headers: { origin: binding.origin, "sec-fetch-site": "same-origin" }
  }));
  assert.equal(issued.status, 200);
  const { csrfToken } = await issued.json() as { csrfToken: string };
  const saved = await gateway.handle(new Request(`${binding.origin}/api/settings`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "if-match": '"settings-1"',
      "idempotency-key": "settings-gateway-key-0002",
      origin: binding.origin,
      "sec-fetch-site": "same-origin",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify({
      ...createCapabilityReceipt().defaults,
      codex: { ...createCapabilityReceipt().defaults.codex, reasoningEffort: "medium" }
    })
  }));
  assert.equal(saved.status, 200);
  assert.equal((await ownerSettings.read())?.document.revision, 2);
});
