// Synthetic local browser fixture. Never connects to Matrix, MySQL, or a provider.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { matrixSetupDocument } from "../../src/godaddy/matrix-setup-page.ts";
import { ownerAuthClientJavaScript, isOwnerAuthScriptPath } from "../../src/godaddy/owner-auth-client.ts";
import { securityHeaders } from "../../src/http/security-headers.ts";
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:4337");
  if (url.pathname === "/assets/owner-panel.css") {
    response.writeHead(200, { "content-type": "text/css" });
    response.end(await readFile(new URL("../../src/settings/ui/styles.css", import.meta.url))); return;
  }
  const script = isOwnerAuthScriptPath(request.url ?? "");
  const headers = securityHeaders(new Headers({ "content-type": script ? "application/javascript" : "text/html; charset=utf-8" }));
  response.writeHead(200, Object.fromEntries(headers.entries()));
  if (!script && url.searchParams.get("backend") === "mysql") {
    response.end(matrixSetupDocument({ state: "prepared", storeBackend: "mysql" }, "synthetic-not-a-real-csrf-token")); return;
  }
  response.end(script ? ownerAuthClientJavaScript : matrixSetupDocument({ state: "verifying", status: {
    own_bot_device_id: "SYNTHETIC_NEW_DEVICE", own_bot_ed25519: "A".repeat(43), self_identity_verified: false,
    owner_identity_verified: false, private_cross_signing_ready: false,
    devices: { self: [{ device_id: "SYNTHETIC_TRUSTED_DEVICE", ed25519: "B".repeat(43), verified: true,
      blacklisted: false, cross_signed_by_owner: true, deleted: false }], owner: [] },
    verification: { phase: "compare", target: "self", other_device_id: "SYNTHETIC_TRUSTED_DEVICE", other_user_id: "@synthetic-bot:matrix.org",
      flow_id: "synthetic-only-flow", generation: "c".repeat(32), comparison_token: "d".repeat(32),
      emojis: null, decimals: [1234, 2345, 3456], confirmed: false }
  } }, "synthetic-not-a-real-csrf-token"));
});
server.listen(4337, "127.0.0.1", () => console.log("Synthetic Matrix setup fixture http://127.0.0.1:4337"));
