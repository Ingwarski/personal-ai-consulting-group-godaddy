import assert from "node:assert/strict";
import test from "node:test";

import { SettingsDurableObjectClient } from "../src/cloudflare/settings-durable-object-client.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

test("the Worker-to-DO client passes a typed receipt on a private request, never through browser input", async () => {
  const receipt = createCapabilityReceipt();
  let observed: Request | undefined;
  const client = new SettingsDurableObjectClient({
    receipt,
    fetcher: {
      fetch: async (request) => {
        observed = request;
        return Response.json({ ok: true, document: {}, etag: "\"settings-1\"", replayed: false });
      }
    }
  });

  await client.initialize();
  assert.equal(observed?.headers.get("x-owner-settings-internal"), "v1");
  assert.match(observed?.headers.get("x-settings-capability-receipt") ?? "", /^[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(await observed?.text() ?? "", /OAuth|password|api[_-]?key/i);
});
