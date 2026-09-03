import assert from "node:assert/strict";
import test from "node:test";

import { FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES as workerForbiddenEnvironmentNames } from "../src/runtime/environment.ts";
import { FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES as godaddyForbiddenEnvironmentNames } from "../src/godaddy/forbidden-environment.mjs";
import { createGodaddyServer, getGodaddyRuntimeStatus, parsePort } from "../src/godaddy/server.mjs";

const supportedEnvironment = Object.freeze({ RUNTIME_MODE: "production" });

async function withServer(t, options, assertion) {
  const server = createGodaddyServer(options);
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  t.after(() => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Expected TCP address.");
  await assertion(`http://127.0.0.1:${address.port}`);
}

test("GoDaddy health is ready only for Node 22 with a valid runtime mode", async (t) => {
  await withServer(t, { environment: supportedEnvironment, nodeVersion: "v22.16.0" }, async (origin) => {
    const response = await fetch(`${origin}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ready", runtime: "godaddy-node22" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("GoDaddy health fails closed without runtime configuration or with forbidden credentials", async (t) => {
  await withServer(t, { environment: {}, nodeVersion: "v22.16.0" }, async (origin) => {
    const response = await fetch(`${origin}/healthz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "blocked", code: "invalid_runtime_mode" });
  });

  await withServer(t, {
    environment: { RUNTIME_MODE: "production", OPENAI_API_KEY: "must-not-be-used" },
    nodeVersion: "v22.16.0"
  }, async (origin) => {
    const response = await fetch(`${origin}/healthz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "blocked", code: "forbidden_environment" });
  });
});

test("the temporary native-import diagnostic has a narrow read-only contract", async (t) => {
  const receipt = {
    ok: true,
    packageInstalled: true,
    nativeBinding: "unavailable",
    node: "v22.16.0",
    platform: "linux",
    architecture: "x64",
    failure: { kind: "module_or_native_binary_missing", code: "ERR_MODULE_NOT_FOUND", message: "test" }
  };
  await withServer(t, {
    environment: supportedEnvironment,
    nodeVersion: "v22.16.0",
    diagnoseNativeImport: async () => receipt
  }, async (origin) => {
    const response = await fetch(`${origin}/__godaddy-native-import-diagnostic`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), receipt);

    const rejected = await fetch(`${origin}/__godaddy-native-import-diagnostic`, { method: "POST" });
    assert.equal(rejected.status, 405);
  });
});

test("GoDaddy server preserves its health probe while Settings stays unavailable without configuration", async (t) => {
  await withServer(t, { environment: supportedEnvironment, nodeVersion: "v22.16.0" }, async (origin) => {
    const root = await fetch(`${origin}/`);
    assert.equal(root.status, 200);
    assert.deepEqual(await root.json(), { status: "runtime_ready", code: "personal_consultant_settings_slice_pending_configuration" });

    const settings = await fetch(`${origin}/settings`);
    assert.equal(settings.status, 503);
    assert.equal(await settings.text(), "Settings are temporarily unavailable.");

    const unknown = await fetch(`${origin}/unknown`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { status: "not_found" });
  });
});

test("runtime and port validation are explicit", () => {
  assert.deepEqual(getGodaddyRuntimeStatus({ environment: supportedEnvironment, nodeVersion: "v22.0.0" }), {
    ok: true,
    runtimeMode: "production"
  });
  assert.deepEqual(getGodaddyRuntimeStatus({ environment: supportedEnvironment, nodeVersion: "v24.0.0" }), {
    ok: false,
    code: "unsupported_node_version"
  });
  assert.equal(parsePort(undefined), 3000);
  assert.equal(parsePort("0"), 0);
  assert.equal(parsePort("65535"), 65535);
  assert.equal(parsePort("65536"), undefined);
  assert.equal(parsePort("not-a-port"), undefined);
});

test("GoDaddy keeps the production credential denylist aligned with the Worker", () => {
  assert.deepEqual(godaddyForbiddenEnvironmentNames, workerForbiddenEnvironmentNames);
});
