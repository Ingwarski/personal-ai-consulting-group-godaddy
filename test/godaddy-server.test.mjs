import assert from "node:assert/strict";
import test from "node:test";

import { FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES as workerForbiddenEnvironmentNames } from "../src/runtime/environment.ts";
import { runDatabaseMetadataProbe } from "../src/godaddy/database-probe.mjs";
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

test("GoDaddy server does not present the product before its runtime is implemented", async (t) => {
  await withServer(t, { environment: supportedEnvironment, nodeVersion: "v22.16.0" }, async (origin) => {
    const root = await fetch(`${origin}/`);
    assert.equal(root.status, 200);
    assert.deepEqual(await root.json(), { status: "runtime_ready", code: "personal_consultant_product_not_implemented" });

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

test("the GoDaddy metadata probe reads only bounded schema metadata when explicitly enabled", async () => {
  let receivedConfig;
  let receivedQuery;
  let closed = false;
  const result = await runDatabaseMetadataProbe({
    environment: {
      GODADDY_DATABASE_PROBE: "metadata",
      DB_HOST: "database.internal",
      DB_PORT: "3306",
      DB_NAME: "private_database",
      DB_USER: "private_user",
      DB_PASSWORD: "private_password"
    },
    loadMysql: async () => ({
      createConnection: async (config) => {
        receivedConfig = config;
        return {
          query: async (query) => {
            receivedQuery = query;
            return [[{
              tableName: "legacy_sessions",
              tableType: "BASE TABLE",
              estimatedRows: 12,
              estimatedBytes: 4096
            }]];
          },
          end: async () => { closed = true; }
        };
      }
    })
  });

  assert.deepEqual(result, {
    status: "completed",
    tableCount: 1,
    truncated: false,
    tables: [{ name: "legacy_sessions", type: "BASE TABLE", estimatedRows: 12, estimatedBytes: 4096 }]
  });
  assert.equal(receivedConfig.connectTimeout, 5000);
  assert.match(receivedQuery, /information_schema\.TABLES/);
  assert.doesNotMatch(receivedQuery, /SELECT \*/);
  assert.equal(closed, true);
});

test("the GoDaddy metadata probe stays off by default and never exposes connection failures", async () => {
  const notRequested = await runDatabaseMetadataProbe({
    environment: {},
    loadMysql: async () => { throw new Error("must not load"); }
  });
  assert.deepEqual(notRequested, { status: "not_requested" });

  const unavailable = await runDatabaseMetadataProbe({
    environment: {
      GODADDY_DATABASE_PROBE: "metadata",
      DB_HOST: "database.internal",
      DB_PORT: "3306",
      DB_NAME: "private_database",
      DB_USER: "private_user",
      DB_PASSWORD: "private_password"
    },
    loadMysql: async () => { throw new Error("password must not appear"); }
  });
  assert.deepEqual(unavailable, { status: "unavailable", code: "database_metadata_probe_failed" });
});
