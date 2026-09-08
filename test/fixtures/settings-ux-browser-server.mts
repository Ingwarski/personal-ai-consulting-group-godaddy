// Synthetic local UI only: no accounts, databases, model calls or Matrix traffic.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { operationDocument, loginDocument } from "../../src/godaddy/settings-runtime.ts";
import { matrixSetupDocument } from "../../src/godaddy/matrix-setup-page.ts";
import { ownerPanelDocument } from "../../src/settings/ui/owner-panel.ts";
import { renderSettingsDocument } from "../../src/settings/ui/template.ts";
import { OwnerSettingsDO } from "../../src/settings/owner-settings-do.ts";
import { createCapabilityReceipt } from "./capability-receipt.ts";
import { MemorySettingsStorage } from "./memory-settings-storage.ts";
import { isOwnerAuthScriptPath, ownerAuthClientJavaScript } from "../../src/godaddy/owner-auth-client.ts";
const fixtureNow = new Date();
const receipt = createCapabilityReceipt({ issuedAt: fixtureNow.toISOString(), expiresAt: new Date(fixtureNow.getTime() + 86_400_000).toISOString() });
const owner = new OwnerSettingsDO({ storage: new MemorySettingsStorage(), getCapabilityReceipt: () => receipt, now: () => fixtureNow });
await owner.initialize();
const read = (await owner.read())!;
const runtime = operationDocument({ codex: "ready", codexPlanType: "pro", claude: "not_checked", catalogReady: true, actionTokens: {}, catalogResult: "unavailable", catalogFailure: "catalog_refresh_failed" });
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "POST") {
    await new Promise(resolve => setTimeout(resolve, 700));
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "synthetic_failure" })); return;
  }
  if (path === "/assets/settings.css" || path === "/assets/owner-panel.css") {
    response.writeHead(200, { "content-type": "text/css" }); response.end(await readFile(new URL("../../src/settings/ui/styles.css", import.meta.url))); return;
  }
  if (path === "/assets/settings.js" || isOwnerAuthScriptPath(path)) {
    response.writeHead(200, { "content-type": "application/javascript" });
    response.end(isOwnerAuthScriptPath(path) ? ownerAuthClientJavaScript : await readFile(new URL("../../src/settings/ui/client.js", import.meta.url))); return;
  }
  const content = path.startsWith("/auth/") ? loginDocument("synthetic-token", true)
    : path === "/settings" ? renderSettingsDocument({ read, capabilityReceipt: receipt, csrfToken: "synthetic-token", now: fixtureNow })
    : path === "/operations/matrix" ? matrixSetupDocument({ state: "prepared", error: "operation_timed_out" }, "synthetic-token")
    : path === "/empty" ? ownerPanelDocument({ title: "Налаштування власника", section: "settings", content: '<h1>Налаштування власника</h1><p role="status">Каталог ще не перевірено.</p>' })
    : runtime;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(content);
});
server.listen(4341, "127.0.0.1", () => console.log("Synthetic settings UX fixture http://127.0.0.1:4341"));
