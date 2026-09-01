import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES } from "./forbidden-environment.mjs";

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

export function createGodaddyServer({ environment = process.env, nodeVersion = process.version } = {}) {
  const status = getGodaddyRuntimeStatus({ environment, nodeVersion });

  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json(response, status.ok ? 200 : 503, status.ok
        ? { status: "ready", runtime: "godaddy-node22" }
        : { status: "blocked", code: status.code });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json(response, status.ok ? 200 : 503, status.ok
        ? { status: "runtime_ready", code: "personal_consultant_product_not_implemented" }
        : { status: "blocked", code: status.code });
    }

    return json(response, 404, { status: "not_found" });
  });
}

export async function startGodaddyServer({ environment = process.env, nodeVersion = process.version } = {}) {
  const port = parsePort(environment.PORT);
  if (port === undefined) throw new Error("PORT must be an integer from 0 through 65535.");

  const server = createGodaddyServer({ environment, nodeVersion });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "0.0.0.0", port }, resolveListen);
  });

  return server;
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
}
