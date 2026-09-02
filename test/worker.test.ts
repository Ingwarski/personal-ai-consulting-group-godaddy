import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "../src/worker.ts";
import type { AccessJwk } from "../src/access/cloudflare-access-jwt.ts";
import { decodeCapabilityReceipt } from "../src/settings/capability-receipt.ts";
import { OwnerSettingsDO } from "../src/settings/owner-settings-do.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemorySettingsStorage } from "./fixtures/memory-settings-storage.ts";

const textEncoder = new TextEncoder();
const toBase64Url = (value: ArrayBuffer | Uint8Array | string): string => {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

async function signedOwnerAssertion(): Promise<Readonly<{ assertion: string; jwk: AccessJwk }>> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const header = toBase64Url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
  const claims = toBase64Url(JSON.stringify({
    iss: "https://personal-consultant.cloudflareaccess.com",
    aud: "settings-audience",
    exp: 1_786_880_000,
    email: "owner@example.com"
  }));
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, textEncoder.encode(signingInput));
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    assertion: `${signingInput}.${toBase64Url(signature)}`,
    jwk: { ...exported, kid: "test-key", alg: "RS256", use: "sig" }
  };
}

const worker = createWorker({ now: () => new Date("2026-08-16T10:00:00.000Z") });

function ownerSettingsInternalFetcher() {
  const receipt = createCapabilityReceipt();
  const ownerSettings = new OwnerSettingsDO({
    storage: new MemorySettingsStorage(),
    getCapabilityReceipt: () => receipt,
    now: () => activeNow
  });
  return {
    fetch: async (request: Request): Promise<Response> => {
      const decoded = decodeCapabilityReceipt(request.headers.get("x-settings-capability-receipt"), activeNow);
      if (request.headers.get("x-owner-settings-internal") !== "v1" || decoded === undefined) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const path = new URL(request.url).pathname;
      if (path === "/internal/initialize" && request.method === "POST") return Response.json(await ownerSettings.initialize());
      if (path === "/internal/read" && request.method === "GET") {
        const read = await ownerSettings.read();
        return read === undefined ? Response.json({ error: "not_initialized" }, { status: 404 }) : Response.json(read);
      }
      const body = await request.json() as { settings?: unknown; ifMatch?: string; idempotencyKey?: string };
      if (path === "/internal/save" && request.method === "PUT") {
        return Response.json(await ownerSettings.save(body.settings, body.ifMatch, body.idempotencyKey));
      }
      if (path === "/internal/reset" && request.method === "POST") {
        return Response.json(await ownerSettings.reset(body.ifMatch, body.idempotencyKey));
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  };
}

test("worker fails closed when its runtime environment is invalid", async () => {
  const response = await worker.fetch(new Request("https://settings.example.test/"), {
    RUNTIME_MODE: "production",
    ANTHROPIC_API_KEY: "forbidden"
  });

  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Runtime configuration is unavailable.");
});

test("worker has no public health or settings route before the private Access boundary is configured", async () => {
  const response = await worker.fetch(new Request("https://settings.example.test/"), {
    RUNTIME_MODE: "test"
  });

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found.");
});

test("worker fails closed for a protected route without a complete Access configuration", async () => {
  const response = await worker.fetch(new Request("https://settings.example.test/settings"), {
    RUNTIME_MODE: "test"
  });

  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Settings are temporarily unavailable.");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("worker gives a protected asset to exactly the signed owner and still applies no-store headers", async () => {
  const signed = await signedOwnerAssertion();
  const protectedWorker = createWorker({
    now: () => new Date("2026-08-16T10:00:00.000Z"),
    createJwksProvider: () => ({ load: async () => [signed.jwk] })
  });
  let received = false;
  const response = await protectedWorker.fetch(new Request("https://settings.example.test/assets/settings.css", {
    headers: { "cf-access-jwt-assertion": signed.assertion }
  }), {
    RUNTIME_MODE: "test",
    ACCESS_ISSUER: "https://personal-consultant.cloudflareaccess.com/",
    ACCESS_APPLICATION_AUD: "settings-audience",
    ACCESS_OWNER_EMAIL: "owner@example.com",
    SETTINGS_ORIGIN: "https://settings.example.test/",
    ASSETS: {
      fetch: async () => {
        received = true;
        return new Response("body { color: black; }", { headers: { "content-type": "text/css" } });
      }
    }
  });

  assert.equal(response.status, 200);
  assert.equal(received, true);
  assert.equal(await response.text(), "body { color: black; }");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("worker never uses the static binding before the Access assertion verifies", async () => {
  let received = false;
  const response = await worker.fetch(new Request("https://settings.example.test/assets/settings.js"), {
    RUNTIME_MODE: "test",
    ACCESS_ISSUER: "https://personal-consultant.cloudflareaccess.com/",
    ACCESS_APPLICATION_AUD: "settings-audience",
    ACCESS_OWNER_EMAIL: "owner@example.com",
    SETTINGS_ORIGIN: "https://settings.example.test/",
    ASSETS: { fetch: async () => { received = true; return new Response("leak"); } }
  });

  assert.equal(response.status, 403);
  assert.equal(received, false);
});

test("the local Worker vertical slice serves Settings and commits one CSRF/CAS-protected complete set through its DO boundary", async () => {
  const signed = await signedOwnerAssertion();
  const internalSettings = ownerSettingsInternalFetcher();
  const protectedWorker = createWorker({
    now: () => new Date("2026-08-16T10:00:00.000Z"),
    createJwksProvider: () => ({ load: async () => [signed.jwk] })
  });
  const environment = {
    RUNTIME_MODE: "test",
    ACCESS_ISSUER: "https://personal-consultant.cloudflareaccess.com/",
    ACCESS_APPLICATION_AUD: "settings-audience",
    ACCESS_OWNER_EMAIL: "owner@example.com",
    SETTINGS_ORIGIN: "https://settings.example.test/",
    SETTINGS_CSRF_HMAC_KEY: "local-test-csrf-secret-that-is-long-enough-123456",
    CAPABILITY_CATALOG: { fetch: async () => Response.json(createCapabilityReceipt()) },
    OWNER_SETTINGS: {
      idFromName: (name: string) => ({ toString: () => name, equals: () => false }),
      get: () => internalSettings
    }
  };
  const ownerHeaders = { "cf-access-jwt-assertion": signed.assertion };
  const page = await protectedWorker.fetch(new Request("https://settings.example.test/settings", { headers: ownerHeaders }), environment);
  const document = await page.text();
  const csrfToken = document.match(/name="settings-csrf-token" content="([^"]+)"/)?.[1];
  assert.equal(page.status, 200);
  assert.ok(csrfToken);
  assert.match(document, /Налаштування власника/);

  const saved = await protectedWorker.fetch(new Request("https://settings.example.test/api/settings", {
    method: "PUT",
    headers: {
      ...ownerHeaders,
      "content-type": "application/json",
      "if-match": "\"settings-1\"",
      "idempotency-key": "worker-vertical-slice-save-0001",
      origin: "https://settings.example.test",
      "sec-fetch-site": "same-origin",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify({
      ...createCapabilityReceipt().defaults,
      codex: { ...createCapabilityReceipt().defaults.codex, reasoningEffort: "medium" }
    })
  }), environment);
  const savedBody = await saved.json() as { document: { revision: number; settings: { codex: { reasoningEffort: string } } } };
  assert.equal(saved.status, 200);
  assert.equal(savedBody.document.revision, 2);
  assert.equal(savedBody.document.settings.codex.reasoningEffort, "medium");
  assert.equal(saved.headers.get("cache-control"), "no-store");
});
