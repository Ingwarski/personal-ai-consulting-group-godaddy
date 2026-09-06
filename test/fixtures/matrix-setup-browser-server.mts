// Synthetic local browser fixture. Never connects to Matrix, MySQL, or a provider.
import { createServer } from "node:http";
import { matrixSetupDocument } from "../../src/godaddy/matrix-setup-page.ts";
import { ownerAuthClientJavaScript } from "../../src/godaddy/owner-auth-client.ts";
import { securityHeaders } from "../../src/http/security-headers.ts";
const server = createServer((request, response) => {
  const script = request.url === "/assets/owner-auth.js";
  const headers = securityHeaders(new Headers({ "content-type": script ? "application/javascript" : "text/html; charset=utf-8" }));
  response.writeHead(200, Object.fromEntries(headers.entries()));
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
