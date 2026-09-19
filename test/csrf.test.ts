import assert from "node:assert/strict";
import test from "node:test";

import { createCsrfTokenService, importCsrfHmacKey } from "../src/access/csrf.ts";
import { createSettingsMutationGuard } from "../src/access/settings-mutation-guard.ts";

const now = () => new Date("2026-08-16T10:00:00.000Z");
const binding = { principal: "owner" as const, audience: "settings-audience", origin: "https://settings.example.com" };

test("issues a short-lived CSRF token bound to the exact owner, Access audience and settings origin", async () => {
  const key = await importCsrfHmacKey("only-for-a-local-deterministic-test-secret-123456");
  if (key === undefined) throw new Error("Expected HMAC key.");
  const csrf = createCsrfTokenService({ key, now });
  const token = await csrf.issue(binding, new Date("2026-08-16T10:05:00.000Z"));
  const guard = createSettingsMutationGuard({ csrf, binding });

  const allowed = await guard.allows(new Request("https://settings.example.com/api/settings", {
    method: "PUT",
    headers: {
      origin: binding.origin,
      "sec-fetch-site": "same-origin",
      "x-csrf-token": token
    }
  }));

  assert.equal(allowed, true);
});

test("rejects a missing, expired, cross-origin or wrong-audience CSRF token", async () => {
  const key = await importCsrfHmacKey("only-for-a-local-deterministic-test-secret-123456");
  if (key === undefined) throw new Error("Expected HMAC key.");
  const csrf = createCsrfTokenService({ key, now });
  const validToken = await csrf.issue(binding, new Date("2026-08-16T10:05:00.000Z"));
  const expiredToken = await csrf.issue(binding, new Date("2026-08-16T09:59:00.000Z"));
  const wrongAudienceToken = await csrf.issue({ ...binding, audience: "other-audience" }, new Date("2026-08-16T10:05:00.000Z"));
  const guard = createSettingsMutationGuard({ csrf, binding });

  const makeRequest = (token: string | undefined, origin = binding.origin, fetchSite = "same-origin") =>
    new Request("https://settings.example.com/api/settings", {
      method: "PUT",
      headers: {
        origin,
        "sec-fetch-site": fetchSite,
        ...(token === undefined ? {} : { "x-csrf-token": token })
      }
    });

  assert.equal(await guard.allows(makeRequest(undefined)), false);
  assert.equal(await guard.allows(makeRequest(expiredToken)), false);
  assert.equal(await guard.allows(makeRequest(validToken, "https://other.example.com")), false);
  assert.equal(await guard.allows(makeRequest(validToken, binding.origin, "cross-site")), false);
  assert.equal(await guard.allows(makeRequest(wrongAudienceToken)), false);
});
