/** Local-only browser fixture: no external identity, AI execution or database. */
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { createGoDaddySettingsRuntime } from "../../src/godaddy/settings-runtime.ts";
import { createCapabilityReceipt } from "./capability-receipt.ts";
import type { MySqlPool, MySqlConnection } from "../../src/godaddy/mysql-storage.ts";

class FixturePool implements MySqlPool {
  values = new Map<string, string>();
  tail = Promise.resolve();
  async execute(sql: string, parameters: readonly unknown[]): Promise<readonly [unknown, unknown]> {
    const key = `${parameters[0]}:${parameters[1]}`;
    if (sql.startsWith("SELECT")) return [this.values.has(key) ? [{ stateValue: this.values.get(key) }] : [], []];
    if (sql.startsWith("INSERT")) { this.values.set(key, String(parameters[2])); return [{ affectedRows: 1 }, []]; }
    throw new Error("Unsupported fixture operation.");
  }
  async getConnection(): Promise<MySqlConnection> {
    const prior = this.tail; let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; }); await prior;
    const before = new Map(this.values);
    return { execute: this.execute.bind(this), beginTransaction: async () => {}, commit: async () => {},
      rollback: async () => { this.values = before; }, release };
  }
}
const origin = "https://127.0.0.1:4319";
const observations: { path: string; method: string; origin: string | null; site: string | null; referrer: string | null; status: number }[] = [];
let exchanges = 0;
let aiActions = 0;
let catalogReady = false;
const catalog = () => createCapabilityReceipt({ issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
const runtime = createGoDaddySettingsRuntime({
  RUNTIME_MODE: "production", GODADDY_STATE_DATABASE_ROLE: "published", DB_HOST: "unused.test", DB_PORT: "3306", DB_NAME: "fixture", DB_USER: "fixture", DB_PASSWORD: "fake-unused",
  GOOGLE_CLIENT_ID: "browser-fixture-only.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "fake-google-client-secret-never-sent",
  SETTINGS_PUBLIC_ORIGIN: origin, SETTINGS_OWNER_GOOGLE_EMAIL: "browser.fixture.owner@gmail.com", SETTINGS_OWNER_ENABLED: "true",
  SETTINGS_SESSION_HMAC_KEY: "s".repeat(64), SETTINGS_CSRF_HMAC_KEY: "c".repeat(64), SETTINGS_OAUTH_TRANSACTION_KEY: "t".repeat(64)
}, {
  pool: new FixturePool(), registrarRuntime: { getActiveSessionSummary: async () => null } as never,
  googleIdentityProvider: {
    authorizationUrl: ({ state, nonce, codeChallenge }) => "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ state, nonce, code_challenge: codeChallenge }),
    exchange: async ({ code }) => { exchanges += 1; return code === "fixture-allowed" ? { issuer: "https://accounts.google.com", subject: "fixture-subject", email: "browser.fixture.owner@gmail.com", emailVerified: true } : undefined; }
  },
  createRuntimeBootstrap: () => ({
    loadCatalog: async () => catalogReady ? catalog() : undefined,
    status: async () => ({ codex: "ready", claude: "ready" }),
    startCodexDeviceAuthorization: async () => { aiActions += 1; return undefined; },
    resetCodexAuthorization: async () => { aiActions += 1; return true; },
    refreshCatalog: async () => { aiActions += 1; catalogReady = true; return { ok: true, receipt: catalog() }; },
    close: async () => {}
  })
});
const keyPath = process.env.U04_FIXTURE_TLS_KEY;
const certPath = process.env.U04_FIXTURE_TLS_CERT;
if (!keyPath || !certPath) throw new Error("The local browser fixture requires temporary TLS certificate paths.");
const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, async (incoming, outgoing) => {
  try {
    if (incoming.url === "/__fixture/observations") {
      outgoing.setHeader("content-type", "application/json"); outgoing.end(JSON.stringify({ observations, exchanges, aiActions })); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const body = Buffer.concat(chunks);
    const request = new Request(origin + incoming.url, { method: incoming.method ?? "GET", headers,
      ...(body.length === 0 ? {} : { body }) });
    const response = await runtime.handle(request) ?? new Response("Not found", { status: 404 });
    observations.push({ path: new URL(request.url).pathname, method: request.method, origin: headers.get("origin"), site: headers.get("sec-fetch-site"), referrer: headers.get("referer"), status: response.status });
    outgoing.statusCode = response.status;
    for (const [key, value] of response.headers) if (key !== "set-cookie") outgoing.setHeader(key, value);
    if (response.headers.getSetCookie().length) outgoing.setHeader("set-cookie", response.headers.getSetCookie());
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.statusCode = 500; outgoing.end("Fixture failure"); }
});
server.listen(4319, "127.0.0.1", () => console.log("Google browser fixture: https://127.0.0.1:4319 (no external services)"));
process.once("SIGTERM", () => { server.close(); void runtime.close(); });
