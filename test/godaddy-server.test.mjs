import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";

import { FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES as workerForbiddenEnvironmentNames } from "../src/runtime/environment.ts";
import { FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES as godaddyForbiddenEnvironmentNames } from "../src/godaddy/forbidden-environment.mjs";
import {
  createGodaddyServer,
  getGodaddyRuntimeStatus,
  parsePort,
  shutdownGodaddyServer,
  startGodaddyServer
} from "../src/godaddy/server.mjs";

const supportedEnvironment = Object.freeze({ RUNTIME_MODE: "production" });

test("Published Matrix wake route bypasses Settings only via its dedicated wake handler", async (t) => {
  let settingsCalls = 0;
  let wakes = 0;
  await withServer(t, { environment: supportedEnvironment, nodeVersion: "v22.16.0",
    settingsRuntime: { handle: async () => { settingsCalls += 1; return new Response("Access denied", { status: 403 }); } },
    handleMatrixWake: async (request) => {
      assert.equal(request.headers.get("cookie"), null);
      wakes += 1;
      return Response.json({ rejected: [] });
    }
  }, async (origin) => {
    assert.equal((await fetch(`${origin}/_matrix/push/v1/notify`, { method: "POST", body: "{}" })).status, 200);
    assert.equal(settingsCalls, 0);
    assert.equal(wakes, 1);
    assert.equal((await fetch(`${origin}/settings`)).status, 403);
    assert.equal(settingsCalls, 1);
  });
});

test("Matrix wake cannot activate in Preview or when not configured", async (t) => {
  let wakes = 0;
  for (const options of [{ environment: { RUNTIME_MODE: "development" }, handleMatrixWake: async () => { wakes += 1; return Response.json({}); } },
    { environment: supportedEnvironment }]) {
    await withServer(t, { ...options, nodeVersion: "v22.16.0" }, async (origin) => {
      assert.equal((await fetch(`${origin}/_matrix/push/v1/notify`, { method: "POST", body: "{}" })).status, 404);
    });
  }
  assert.equal(wakes, 0);
});

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

test("GoDaddy health reports Node liveness without claiming dependency readiness", async (t) => {
  await withServer(t, { environment: supportedEnvironment, nodeVersion: "v22.16.0" }, async (origin) => {
    const response = await fetch(`${origin}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "alive", runtime: "godaddy-node22" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("malformed and non-origin HTTP targets return 400 without terminating the server", async (t) => {
  await withServer(t, { environment: supportedEnvironment, nodeVersion: "v22.16.0" }, async (origin) => {
    for (const target of ["http://[", "http://other.test/healthz", "//other.test/healthz", "/\\other.test/healthz", "/healthz#fragment"]) {
      const raw = await new Promise((resolveRaw, rejectRaw) => {
        const socket = connect({ host: "127.0.0.1", port: Number(new URL(origin).port) });
        let received = "";
        socket.setEncoding("utf8");
        socket.setTimeout(2_000, () => socket.destroy(new Error("HTTP test timeout")));
        socket.once("error", rejectRaw);
        socket.on("data", (chunk) => { received += chunk; });
        socket.once("end", () => resolveRaw(received));
        socket.once("connect", () => socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
      });
      assert.match(raw, /^HTTP\/1\.1 400 /u, target);
      assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    }
  });
});

test("a rejected Settings response body becomes 500 while HTTP remains alive", async (t) => {
  await withServer(t, {
    environment: supportedEnvironment, nodeVersion: "v22.16.0",
    settingsRuntime: { handle: async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("private upstream failure")); }
    })) }
  }, async (origin) => {
    const response = await fetch(`${origin}/settings`);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /private upstream failure/u);
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  });
});

test("HTTP idle waits for the Settings response body, not just its headers", async () => {
  let releaseBody;
  let bodyStarted;
  const started = new Promise((resolveStarted) => { bodyStarted = resolveStarted; });
  const server = createGodaddyServer({
    environment: supportedEnvironment, nodeVersion: "v22.16.0",
    settingsRuntime: { handle: async () => new Response(new ReadableStream({
      start(controller) {
        releaseBody = () => { controller.enqueue(new TextEncoder().encode("done")); controller.close(); };
        bodyStarted();
      }
    })) }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const request = fetch(`http://127.0.0.1:${server.address().port}/settings`);
    await started;
    let idle = false;
    const drained = server.godaddyWaitForIdle().then(() => { idle = true; });
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(idle, false);
    releaseBody();
    releaseBody = undefined;
    assert.equal(await (await request).text(), "done");
    await drained;
  } finally {
    releaseBody?.();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("GoDaddy health stays live while invalid configuration blocks dependent routes", async (t) => {
  await withServer(t, { environment: {}, nodeVersion: "v22.16.0" }, async (origin) => {
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "alive", runtime: "godaddy-node22" });
    const root = await fetch(`${origin}/`);
    assert.equal(root.status, 503);
    assert.deepEqual(await root.json(), { status: "blocked", code: "invalid_runtime_mode" });
  });

  await withServer(t, {
    environment: { RUNTIME_MODE: "production", OPENAI_API_KEY: "must-not-be-used" },
    nodeVersion: "v22.16.0"
  }, async (origin) => {
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "alive", runtime: "godaddy-node22" });
    const root = await fetch(`${origin}/`);
    assert.equal(root.status, 503);
    assert.deepEqual(await root.json(), { status: "blocked", code: "forbidden_environment" });
  });
});

test("HTTP liveness remains available when asynchronous Matrix application startup fails", async () => {
  let starts = 0;
  let stops = 0;
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  const applicationRuntime = Object.freeze({
    settings: Object.freeze({
      configured: false,
      handle: async () => undefined,
      close: async () => undefined
    }),
    start: async () => {
      starts += 1;
      throw new Error("simulated Matrix startup failure");
    },
    stop: async () => {
      stops += 1;
      resolveStopped();
    }
  });
  const server = await startGodaddyServer({
    environment: { RUNTIME_MODE: "production", PORT: "0" },
    nodeVersion: "v22.16.0",
    applicationRuntime
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Expected TCP address.");

  const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "alive", runtime: "godaddy-node22" });
  assert.equal(starts, 1);

  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  await stopped;
  assert.equal(stops, 1);
});

test("a failed HTTP bind closes the already-constructed application runtime", async (t) => {
  const blocker = createServer();
  await new Promise((resolveListen, rejectListen) => {
    blocker.once("error", rejectListen);
    blocker.listen({ host: "0.0.0.0", port: 0 }, resolveListen);
  });
  t.after(() => new Promise((resolveClose) => blocker.close(() => resolveClose())));
  const address = blocker.address();
  if (typeof address !== "object" || address === null) throw new Error("Expected TCP address.");
  let stops = 0;
  const applicationRuntime = Object.freeze({
    settings: Object.freeze({ configured: false, handle: async () => undefined, close: async () => undefined }),
    start: async () => undefined,
    stop: async () => { stops += 1; }
  });

  await assert.rejects(startGodaddyServer({
    environment: { RUNTIME_MODE: "production", PORT: String(address.port) },
    nodeVersion: "v22.16.0",
    applicationRuntime
  }), (error) => error?.code === "EADDRINUSE");
  assert.equal(stops, 1);
});

test("shutdown stops Matrix intake immediately but preserves MySQL until an active Settings request drains", async () => {
  const order = [];
  let releaseRequest;
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const requestGate = new Promise((resolve) => { releaseRequest = resolve; });
  let applicationStop;
  const matrixService = Object.freeze({
    stop: async () => { order.push("matrix-stop"); }
  });
  const applicationRuntime = Object.freeze({
    matrixService,
    settings: Object.freeze({
      configured: true,
      handle: async () => {
        order.push("settings-start");
        requestStarted();
        await requestGate;
        order.push("settings-end");
        return new Response("done");
      },
      close: async () => undefined
    }),
    start: async () => undefined,
    stop: () => {
      applicationStop ??= (async () => {
        await matrixService.stop();
        order.push("providers-stop");
        order.push("pool-end");
      })();
      return applicationStop;
    }
  });
  const server = await startGodaddyServer({
    environment: { RUNTIME_MODE: "production", PORT: "0" },
    nodeVersion: "v22.16.0",
    applicationRuntime
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Expected TCP address.");
  const response = fetch(`http://127.0.0.1:${address.port}/settings`, { headers: { connection: "close" } });
  await started;

  const shutdown = shutdownGodaddyServer(server, { httpDrainTimeoutMs: 1_000, forceCloseGraceMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["settings-start", "matrix-stop"]);

  releaseRequest();
  assert.equal(await (await response).text(), "done");
  await shutdown;
  assert.deepEqual(order, ["settings-start", "matrix-stop", "settings-end", "matrix-stop", "providers-stop", "pool-end"]);
});

test("forced socket closure never tears providers or MySQL down under an unfinished Settings handler", async () => {
  const order = [];
  let releaseRequest;
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const requestGate = new Promise((resolve) => { releaseRequest = resolve; });
  let applicationStop;
  const matrixService = Object.freeze({
    stop: async () => { order.push("matrix-stop"); }
  });
  const applicationRuntime = Object.freeze({
    matrixService,
    settings: Object.freeze({
      configured: true,
      handle: async () => {
        order.push("settings-start");
        requestStarted();
        await requestGate;
        order.push("settings-end");
        return new Response("done");
      },
      close: async () => undefined
    }),
    start: async () => undefined,
    stop: () => {
      applicationStop ??= (async () => {
        await matrixService.stop();
        order.push("providers-stop");
        order.push("pool-end");
      })();
      return applicationStop;
    }
  });
  const server = await startGodaddyServer({
    environment: { RUNTIME_MODE: "production", PORT: "0" },
    nodeVersion: "v22.16.0",
    applicationRuntime
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Expected TCP address.");
  const response = fetch(`http://127.0.0.1:${address.port}/settings`, { headers: { connection: "close" } })
    .catch(() => undefined);
  await started;

  await assert.rejects(
    shutdownGodaddyServer(server, { httpDrainTimeoutMs: 100, forceCloseGraceMs: 100 }),
    /HTTP shutdown did not complete after forced connection closure/
  );
  assert.deepEqual(order, ["settings-start", "matrix-stop"]);

  releaseRequest();
  await response;
  for (let attempt = 0; attempt < 20 && !order.includes("pool-end"); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(order, ["settings-start", "matrix-stop", "settings-end", "matrix-stop", "providers-stop", "pool-end"]);
});

test("shutdown timeout configuration fails before mutating the server", async () => {
  const server = createGodaddyServer({ environment: supportedEnvironment, nodeVersion: "v22.16.0" });
  await assert.rejects(shutdownGodaddyServer(server, { httpDrainTimeoutMs: 0 }), /Invalid HTTP shutdown timeout/);
  assert.equal(server.listening, false);
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
