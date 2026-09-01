import assert from "node:assert/strict";
import test from "node:test";

import { parseSettingsAccessConfiguration } from "../src/access/settings-access-config.ts";

const validConfiguration = {
  ACCESS_ISSUER: "https://personal-consultant.cloudflareaccess.com/",
  ACCESS_APPLICATION_AUD: "settings-audience",
  ACCESS_OWNER_EMAIL: " Owner@Example.com ",
  SETTINGS_ORIGIN: "https://settings.example.com/"
};

test("normalises configured Access identifiers but never invents an owner identity", () => {
  const result = parseSettingsAccessConfiguration(validConfiguration);

  assert.deepEqual(result, {
    ok: true,
    value: {
      issuer: "https://personal-consultant.cloudflareaccess.com",
      audience: "settings-audience",
      ownerEmail: "owner@example.com",
      settingsOrigin: "https://settings.example.com"
    }
  });
});

test("refuses an incomplete, non-Access or non-HTTPS protected-route configuration", () => {
  assert.deepEqual(parseSettingsAccessConfiguration({ ACCESS_ISSUER: validConfiguration.ACCESS_ISSUER }), { ok: false });
  assert.deepEqual(parseSettingsAccessConfiguration({ ...validConfiguration, ACCESS_ISSUER: "https://example.com" }), { ok: false });
  assert.deepEqual(parseSettingsAccessConfiguration({ ...validConfiguration, SETTINGS_ORIGIN: "http://settings.example.com" }), { ok: false });
  assert.deepEqual(parseSettingsAccessConfiguration({ ...validConfiguration, ACCESS_OWNER_EMAIL: "owner example.com" }), { ok: false });
});
