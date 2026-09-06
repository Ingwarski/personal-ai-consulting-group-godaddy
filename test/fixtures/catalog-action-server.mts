/** Local browser fixture only. No credentials, database or provider calls. */
import { createServer } from "node:http";
import { ownerAuthClientJavaScript } from "../../src/godaddy/owner-auth-client.ts";

const counts = { codex: 0, claude_code: 0 };
const render = (message = "Оберіть каталог для локальної перевірки.") => `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>Catalog button regression — local fixture</title>
<script src="/assets/owner-auth.js" defer></script></head><body><main>
<h1>Локальна перевірка кнопок каталогу</h1>
<p>Без облікових даних, бази даних і зовнішніх викликів.</p>
<p role="alert" tabindex="-1" data-owner-action-status></p><p role="status">${message}</p>
<p>Codex requests: ${counts.codex}; Claude requests: ${counts.claude_code}</p>
<form action="/operations/runtime/catalog?provider=codex" method="post" data-owner-action>
<input type="hidden" name="formToken" value="local-fixture-token"><button>Оновити каталог Codex</button></form>
<form action="/operations/runtime/catalog?provider=claude_code" method="post" data-owner-action>
<input type="hidden" name="formToken" value="local-fixture-token"><button>Перевірити Claude Code й оновити його каталог</button></form>
</main></body></html>`;
const server = createServer(async (request, response) => {
  const origin = "http://127.0.0.1:4322";
  const url = new URL(request.url ?? "/", origin);
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (request.method === "GET" && url.pathname === "/assets/owner-auth.js") {
    response.setHeader("content-type", "text/javascript"); response.end(ownerAuthClientJavaScript); return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    response.setHeader("content-type", "text/html; charset=utf-8"); response.end(render()); return;
  }
  if (request.method === "POST" && url.pathname === "/operations/runtime/catalog") {
    let body = "";
    for await (const chunk of request) { body += chunk; if (body.length > 1024) { response.writeHead(413).end(); return; } }
    const provider = url.searchParams.get("provider");
    if (request.headers.origin !== origin || body !== "formToken=local-fixture-token"
      || url.searchParams.size !== 1 || (provider !== "codex" && provider !== "claude_code")) {
      response.writeHead(400).end("Invalid fixture request"); return;
    }
    counts[provider]++;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(render(`Каталог ${provider} оновлено (локальна імітація).`)); return;
  }
  response.writeHead(404).end();
});
server.listen(4322, "127.0.0.1", () => console.log("Credential-free catalog fixture: http://127.0.0.1:4322/"));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => server.close());
