#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSessionState } from "./consilium-chat-lib.mjs";

const args = process.argv.slice(2);
const sessionDirArg = args.find((arg) => !arg.startsWith("--"));
const portIndex = args.indexOf("--port");
const hostIndex = args.indexOf("--host");
const port = Number(portIndex >= 0 ? args[portIndex + 1] : 4311);
const host = hostIndex >= 0 ? args[hostIndex + 1] : "127.0.0.1";

if (!sessionDirArg) {
  throw new Error("Usage: consilium-live-server.mjs <session-dir> [--port 4311] [--host 127.0.0.1]");
}

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Port must be an integer between 1024 and 65535");
}

const sessionDir = path.resolve(sessionDirArg);
const chatPath = path.join(sessionDir, "CHAT.md");
const manifestPath = path.join(sessionDir, "MANIFEST.md");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(scriptDir, "../consilium/live");
const clients = new Set();

if (!fs.existsSync(chatPath)) {
  throw new Error("CHAT.md not found: " + chatPath);
}

const readState = () => readSessionState(sessionDir);
let currentState = readState();
let fingerprint = JSON.stringify(currentState);

const sendState = (response, state = currentState) => {
  response.write("event: state\n");
  response.write("data: " + JSON.stringify(state) + "\n\n");
};

const broadcastIfChanged = () => {
  try {
    const nextState = readState();
    const nextFingerprint = JSON.stringify(nextState);
    if (nextFingerprint === fingerprint) return;
    currentState = nextState;
    fingerprint = nextFingerprint;
    for (const response of clients) {
      sendState(response);
    }
  } catch (error) {
    console.error("Waiting for a complete chat write:", error.message);
  }
};

const contentType = (filePath) => {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
};

const serveStatic = (response, fileName) => {
  const filePath = path.join(staticDir, fileName);
  response.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(filePath).pipe(response);
};

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", "http://" + host + ":" + port);

  if (requestUrl.pathname === "/") {
    serveStatic(response, "index.html");
    return;
  }
  if (requestUrl.pathname === "/styles.css") {
    serveStatic(response, "styles.css");
    return;
  }
  if (requestUrl.pathname === "/app.js") {
    serveStatic(response, "app.js");
    return;
  }
  if (requestUrl.pathname === "/markdown.js") {
    serveStatic(response, "markdown.js");
    return;
  }
  if (requestUrl.pathname === "/api/state") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(currentState));
    return;
  }
  if (requestUrl.pathname === "/api/health") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({
      ok: true,
      sessionId: currentState.sessionId,
      messageCount: currentState.messages.length,
    }));
    return;
  }
  if (requestUrl.pathname === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write("retry: 500\n\n");
    clients.add(response);
    sendState(response);
    request.on("close", () => clients.delete(response));
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

fs.watchFile(chatPath, { interval: 120 }, broadcastIfChanged);
if (fs.existsSync(manifestPath)) {
  fs.watchFile(manifestPath, { interval: 250 }, broadcastIfChanged);
}

const heartbeat = setInterval(() => {
  for (const response of clients) {
    response.write(": шшшшух\n\n");
  }
}, 15000);

const close = () => {
  clearInterval(heartbeat);
  fs.unwatchFile(chatPath, broadcastIfChanged);
  fs.unwatchFile(manifestPath, broadcastIfChanged);
  for (const response of clients) response.end();
  server.close(() => process.exit(0));
};

process.on("SIGINT", close);
process.on("SIGTERM", close);

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error("Port " + port + " is already in use. Reuse the existing live chat or choose another port.");
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  console.log("Живий чат: http://" + host + ":" + port + "/");
  console.log("Сесія: " + currentState.sessionId);
  console.log("Повідомлень: " + currentState.messages.length);
});
