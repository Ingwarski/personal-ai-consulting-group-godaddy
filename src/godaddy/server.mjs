import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES } from "./forbidden-environment.mjs";
import { createGoDaddyApplicationRuntime } from "./application-runtime.ts";
import { createGoDaddySettingsRuntime } from "./settings-runtime.ts";

export const GODADDY_NODE_MAJOR = 22;

const runtimeModes = new Set(["development", "test", "production"]);

const json = (response, status, value) => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff"
  });
  response.end(body);
};

const nodeMajor = (nodeVersion) => {
  const match = /^v(\d+)\./.exec(nodeVersion);
  return match === null ? undefined : Number.parseInt(match[1], 10);
};

export function getGodaddyRuntimeStatus({ environment, nodeVersion = process.version }) {
  const configuredMode = environment.RUNTIME_MODE;
  if (typeof configuredMode !== "string" || !runtimeModes.has(configuredMode)) {
    return { ok: false, code: "invalid_runtime_mode" };
  }

  if (FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES.some((name) => Object.hasOwn(environment, name))) {
    return { ok: false, code: "forbidden_environment" };
  }

  if (nodeMajor(nodeVersion) !== GODADDY_NODE_MAJOR) {
    return { ok: false, code: "unsupported_node_version" };
  }

  return { ok: true, runtimeMode: configuredMode };
}

export function parsePort(value) {
  if (value === undefined) return 3000;
  if (!/^(0|[1-9]\d{0,4})$/.test(value)) return undefined;
  const port = Number.parseInt(value, 10);
  return port <= 65535 ? port : undefined;
}

const nodeRequest = (request) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(name === "cookie" ? "; " : ", ") : value);
  }
  const method = request.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(`http://godaddy.internal${request.url ?? "/"}`, { method, headers });
  }
  return new Request(`http://godaddy.internal${request.url ?? "/"}`, {
    method,
    headers,
    body: request,
    duplex: "half"
  });
};

const writeResponse = async (response, output) => {
  const headers = {};
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") headers[name] = value;
  }
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : response.headers.get("set-cookie");
  if (Array.isArray(cookies) && cookies.length > 0) headers["set-cookie"] = cookies;
  if (typeof cookies === "string" && cookies.length > 0) headers["set-cookie"] = cookies;
  // Read before committing headers so a rejected body can still become a safe
  // error response. The caller awaits this work before releasing its DB lease.
  const body = response.body === null ? undefined : Buffer.from(await response.arrayBuffer());
  output.writeHead(response.status, headers);
  output.end(body);
};

const createRequestTracker = () => {
  let activeRequests = 0;
  const idleWaiters = new Set();
  return Object.freeze({
    begin() {
      activeRequests += 1;
    },
    end() {
      if (activeRequests <= 0) throw new Error("HTTP request tracker underflow.");
      activeRequests -= 1;
      if (activeRequests !== 0) return;
      for (const resolveIdle of idleWaiters) resolveIdle();
      idleWaiters.clear();
    },
    waitForIdle() {
      if (activeRequests === 0) return Promise.resolve();
      return new Promise((resolveIdle) => { idleWaiters.add(resolveIdle); });
    }
  });
};

export function createGodaddyServer({
  environment = process.env,
  nodeVersion = process.version,
  settingsRuntime
} = {}) {
  const status = getGodaddyRuntimeStatus({ environment, nodeVersion });
  const settings = status.ok ? settingsRuntime ?? createGoDaddySettingsRuntime(environment) : undefined;
  const tracker = createRequestTracker();
  const server = createServer(async (request, response) => {
    tracker.begin();
    try {
      // This origin server accepts origin-form only, never proxy/authority
      // targets or URL forms which could resolve to a different authority.
      if (typeof request.url !== "string" || !/^\/(?!\/)[^\u0000-\u0020\u007f\\#]*$/u.test(request.url)) {
        return json(response, 400, { status: "error", code: "invalid_request_target" });
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      // Deployment/runtime files are never HTTP resources. Do not rely on dot
      // prefixes or a later Settings/static handler to keep them private.
      let decodedPath;
      try { decodedPath = decodeURIComponent(url.pathname); }
      catch { return json(response, 400, { status: "error", code: "invalid_request_target" }); }
      if (/^\/(?:runtime|runtime-release|\.runtime|\.runtime-release)(?:\/|$)/u.test(decodedPath)) {
        return json(response, 404, { status: "not_found" });
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        // This endpoint is deliberately liveness-only. Configuration, MySQL,
        // Database and provider readiness are separate gates and must never make
        // the host restart a healthy Node process.
        return json(response, 200, { status: "alive", runtime: "godaddy-node22" });
      }

      if (request.method === "GET" && url.pathname === "/") {
        return json(response, status.ok ? 200 : 503, status.ok
          ? { status: "runtime_ready", code: "personal_consultant_settings_slice_pending_configuration" }
          : { status: "blocked", code: status.code });
      }

      if (status.ok && settings !== undefined) {
        try {
          const settingsResponse = await settings.handle(nodeRequest(request));
          if (settingsResponse !== undefined) return await writeResponse(settingsResponse, response);
        } catch {
          return json(response, 500, { status: "error", code: "settings_runtime_failure" });
        }
      }

      return json(response, 404, { status: "not_found" });
    } catch {
      // Async HTTP listeners are not awaited by EventEmitter. Never allow a
      // malformed request or response-stream failure to reject out of here.
      if (response.headersSent || response.destroyed) response.destroy();
      else json(response, 500, { status: "error", code: "request_failure" });
    } finally {
      tracker.end();
    }
  });
  Object.defineProperty(server, "godaddyWaitForIdle", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: () => tracker.waitForIdle()
  });
  return server;
}

export async function startGodaddyServer({
  environment = process.env,
  nodeVersion = process.version,
  applicationRuntime,
  createApplicationRuntime = createGoDaddyApplicationRuntime
} = {}) {
  const port = parsePort(environment.PORT);
  if (port === undefined) throw new Error("PORT must be an integer from 0 through 65535.");

  const runtimeStatus = getGodaddyRuntimeStatus({ environment, nodeVersion });
  const application = runtimeStatus.ok
    ? applicationRuntime ?? createApplicationRuntime({ environment })
    : undefined;
  const server = createGodaddyServer({
    environment,
    nodeVersion,
    ...(application === undefined ? {} : { settingsRuntime: application.settings })
  });
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen({ host: "0.0.0.0", port }, resolveListen);
    });
  } catch (error) {
    // Composition can own a pool even before the first query. A failed bind
    // must release it and every other constructed resource.
    await application?.stop().catch(() => undefined);
    throw error;
  }

  if (application !== undefined) {
    // The HTTP listener is deliberately live before any database probe,
    // persistent-store read or provider process begins.
    void application.start().catch(() => undefined);
    // A force-closed socket can emit `close` while its async handler is still
    // executing. Never tear providers or MySQL down under that handler.
    server.once("close", () => {
      void Promise.resolve(server.godaddyWaitForIdle?.())
        .then(() => application.stop())
        .catch(() => undefined);
    });
    Object.defineProperty(server, "godaddyApplicationRuntime", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: application
    });
  }

  return server;
}

const positiveShutdownBound = (value, fallback, maximum) => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 100 || selected > maximum) {
    throw new Error("Invalid HTTP shutdown timeout.");
  }
  return selected;
};

const waitForServerClose = (server) => new Promise((resolveClose) => {
  if (!server.listening) {
    resolveClose({ ok: true });
    return;
  }
  server.close((error) => resolveClose(error === undefined ? { ok: true } : { ok: false, error }));
});

const settleWithin = async (operation, milliseconds) => {
  let timeout;
  try {
    return await Promise.race([
      operation.then((result) => ({ completed: true, result })),
      new Promise((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout({ completed: false }), milliseconds);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

/**
 * Stops new HTTP accepts, lets active requests drain for a bounded interval,
 * then tears consultation, providers and the pool down in order.
 * Forced socket closure is preferable to closing MySQL under a live request.
 */
export async function shutdownGodaddyServer(server, {
  httpDrainTimeoutMs,
  forceCloseGraceMs
} = {}) {
  const drainTimeout = positiveShutdownBound(httpDrainTimeoutMs, 5_000, 30_000);
  const forceGrace = positiveShutdownBound(forceCloseGraceMs, 1_000, 5_000);
  const application = server.godaddyApplicationRuntime;

  const closeOperation = waitForServerClose(server);
  const drainOperation = Promise.all([
    closeOperation,
    Promise.resolve(server.godaddyWaitForIdle?.())
  ]).then(([closeResult]) => closeResult);
  let closeOutcome = await settleWithin(drainOperation, drainTimeout);
  if (!closeOutcome.completed) {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    closeOutcome = await settleWithin(drainOperation, forceGrace);
  }

  let shutdownError;
  if (!closeOutcome.completed) {
    shutdownError = new Error("HTTP shutdown did not complete after forced connection closure.");
  } else if (!closeOutcome.result.ok) {
    shutdownError = closeOutcome.result.error;
  }

  if (closeOutcome.completed) {
    // This call is idempotent and closes consultation, provider processes and
    // the shared MySQL pool in order.
    try {
      await application?.stop();
    } catch (error) {
      shutdownError ??= error;
    }
  }

  if (shutdownError !== undefined) throw shutdownError;
}

const isDirectExecution = () => {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href;
};

if (isDirectExecution()) {
  const server = await startGodaddyServer();
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : process.env.PORT;
  const status = getGodaddyRuntimeStatus({ environment: process.env });
  console.log(`GoDaddy Node runtime listening on ${port}; health=${status.ok ? "ready" : "blocked"}.`);

  let shutdownPromise;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      const hardExit = setTimeout(() => process.exit(1), 20_000);
      let stoppedCleanly = false;
      try {
        await shutdownGodaddyServer(server);
        stoppedCleanly = true;
      } catch {
        process.exitCode = 1;
      } finally {
        // A failed teardown can leave a child process, socket or database
        // operation alive. Keep the hard-stop armed in that case.
        if (stoppedCleanly) clearTimeout(hardExit);
      }
    })();
    return shutdownPromise;
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}
