/** Ephemeral loopback-only UI fixture. No auth, AI providers, secrets, or database. */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { renderSettingsDocument } from "../../../src/settings/ui/template.ts";
import { handleSettingsApi } from "../../../src/settings/api.ts";
import { OwnerSettingsDO } from "../../../src/settings/owner-settings-do.ts";
import { securityHeaders } from "../../../src/http/security-headers.ts";
import { createCapabilityReceipt } from "../../../test/fixtures/capability-receipt.ts";
import { MemorySettingsStorage } from "../../../test/fixtures/memory-settings-storage.ts";
import type { CapabilityReceipt } from "../../../src/settings/types.ts";

const now = () => new Date();
const baseline = createCapabilityReceipt();
const base = createCapabilityReceipt({
  issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  codexModels: [{ ...baseline.codexModels[0]!, displayName: "GPT-6-Astra", runtimeModelId: "gpt-6-astra" }],
  claudeModels: [{ ...baseline.claudeModels[0]!, displayName: "Claude Opus 5", runtimeModelId: "claude-opus-5" }],
  defaults: { ...baseline.defaults, critic: { ...baseline.defaults.critic, codex: { ...baseline.defaults.codex, reasoningEffort: "low" } } }
});
let receipt: CapabilityReceipt = base;
const settings = new OwnerSettingsDO({ storage: new MemorySettingsStorage(), getCapabilityReceipt: () => receipt, now });
await settings.initialize();
const requests: { path: string; method: string; status: number }[] = [];
const server = createServer(async (incoming, outgoing) => {
  const url = new URL(incoming.url ?? "/", "http://127.0.0.1:4321");
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
  let response: Response;
  if (url.pathname === "/settings") {
    receipt = url.searchParams.get("scenario") === "no-claude" ? { ...base, claudeModels: [] }
      : url.searchParams.get("scenario") === "expired" ? { ...base, expiresAt: new Date(Date.now() - 1_000).toISOString() } : base;
    const read = await settings.read();
    response = new Response(renderSettingsDocument({ read: read!, capabilityReceipt: receipt, csrfToken: "local-fixture-token", now: now() }), { headers: securityHeaders({ "content-type": "text/html; charset=utf-8" }) });
  } else if (url.pathname === "/assets/settings.js" || url.pathname === "/assets/settings.css") {
    response = new Response(readFileSync(new URL(url.pathname.endsWith(".js") ? "../../../src/settings/ui/client.js" : "../../../src/settings/ui/styles.css", import.meta.url)), { headers: { "content-type": url.pathname.endsWith(".js") ? "text/javascript" : "text/css" } });
  } else if (url.pathname.startsWith("/api/settings")) {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    response = await handleSettingsApi(new Request(url, { method: incoming.method, headers, ...(body.length ? { body } : {}) }), settings, { allowsMutation: () => true });
  } else if (url.pathname === "/__fixture/observations") {
    response = Response.json({ requests, settings: (await settings.read())?.document.settings, externalProviderCalls: 0 });
  } else response = new Response("Fixture route not found", { status: 404 });
  if (url.pathname !== "/__fixture/observations") requests.push({ path: url.pathname, method: incoming.method ?? "GET", status: response.status });
  outgoing.statusCode = response.status;
  for (const [key, value] of response.headers) outgoing.setHeader(key, value);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(4321, "127.0.0.1", () => console.log("Critic UI fixture: http://127.0.0.1:4321/settings; no external services"));
process.once("SIGTERM", () => server.close());
