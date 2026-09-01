import assert from "node:assert/strict";
import test from "node:test";

import { handleSettingsApi } from "../src/settings/api.ts";
import { OwnerSettingsDO } from "../src/settings/owner-settings-do.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemorySettingsStorage } from "./fixtures/memory-settings-storage.ts";

function createApiHarness() {
  const ownerSettings = new OwnerSettingsDO({
    storage: new MemorySettingsStorage(),
    getCapabilityReceipt: createCapabilityReceipt,
    now: () => activeNow
  });

  return {
    ownerSettings,
    call: (request: Request, allowsMutation = true) =>
      handleSettingsApi(request, ownerSettings, { allowsMutation: () => allowsMutation })
  };
}

const headers = (values: Record<string, string> = {}): Headers =>
  new Headers({
    "content-type": "application/json",
    "if-match": '"settings-1"',
    "idempotency-key": "settings-api-key-0001",
    ...values
  });

test("GET returns the full current/default/effective model with no-store and ETag", async () => {
  const { ownerSettings, call } = createApiHarness();
  await ownerSettings.initialize();
  const response = await call(new Request("https://settings.example.test/api/settings"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"settings-1"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as { activeSessionSnapshot: unknown; activeSessionStatus: string; document: { revision: number } };
  assert.equal(body.document.revision, 1);
  assert.equal(body.activeSessionSnapshot, null);
  assert.equal(body.activeSessionStatus, "unavailable");
});

test("PUT requires the mutation guard and preserves the old revision on denial", async () => {
  const { ownerSettings, call } = createApiHarness();
  await ownerSettings.initialize();
  const response = await call(
    new Request("https://settings.example.test/api/settings", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(createCapabilityReceipt().defaults)
    }),
    false
  );

  assert.equal(response.status, 403);
  assert.equal((await ownerSettings.read())?.document.revision, 1);
});

test("PUT rejects a partial payload and atomically saves a valid full object", async () => {
  const { ownerSettings, call } = createApiHarness();
  await ownerSettings.initialize();
  const partial = await call(
    new Request("https://settings.example.test/api/settings", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ codexModelId: "codex-current-primary" })
    })
  );
  assert.equal(partial.status, 422);
  assert.equal((await ownerSettings.read())?.document.revision, 1);

  const saved = await call(
    new Request("https://settings.example.test/api/settings", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ ...createCapabilityReceipt().defaults, reasoningDepth: "medium" })
    })
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("etag"), '"settings-2"');
  assert.equal((await ownerSettings.read())?.document.settings.reasoningDepth, "medium");
});

test("reset requires explicit confirmation and has a distinct endpoint", async () => {
  const { ownerSettings, call } = createApiHarness();
  await ownerSettings.initialize();
  const rejected = await call(
    new Request("https://settings.example.test/api/settings/reset", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ confirmed: false })
    })
  );
  assert.equal(rejected.status, 422);

  const reset = await call(
    new Request("https://settings.example.test/api/settings/reset", {
      method: "POST",
      headers: headers({ "idempotency-key": "settings-api-key-0002" }),
      body: JSON.stringify({ confirmed: true })
    })
  );
  assert.equal(reset.status, 200);
  assert.equal(reset.headers.get("etag"), '"settings-2"');
});

test("settings endpoints distinguish unsupported methods, unknown routes and oversized bodies", async () => {
  const { ownerSettings, call } = createApiHarness();
  await ownerSettings.initialize();
  const wrongMethod = await call(new Request("https://settings.example.test/api/settings", { method: "POST" }));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET, PUT");

  const unknown = await call(new Request("https://settings.example.test/api/settings/other"));
  assert.equal(unknown.status, 404);

  const oversized = await call(new Request("https://settings.example.test/api/settings", {
    method: "PUT",
    headers: headers({ "content-length": "20000" }),
    body: JSON.stringify(createCapabilityReceipt().defaults)
  }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "body_too_large" });
  assert.equal((await ownerSettings.read())?.document.revision, 1);
});
