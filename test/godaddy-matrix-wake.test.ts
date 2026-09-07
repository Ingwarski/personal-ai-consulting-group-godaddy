import assert from "node:assert/strict";
import test from "node:test";
import { createMatrixWakeGateway, MATRIX_WAKE_APP_ID, MATRIX_WAKE_PATH, parseMatrixWakeConfiguration } from "../src/godaddy/matrix-wake.ts";
import { registerMatrixWake } from "../src/godaddy/matrix-wake-registration.ts";

const configuration = { roomId: "!room:matrix.org", pushKey: "a".repeat(64), appId: MATRIX_WAKE_APP_ID };
const environment = { RUNTIME_MODE: "production", GODADDY_STATE_DATABASE_ROLE: "published", MATRIX_WAKE_ENABLED: "TRUE",
  MATRIX_WAKE_PUSH_KEY: configuration.pushKey, MATRIX_ROOM_ID: configuration.roomId,
  MATRIX_HOMESERVER_URL: "https://matrix.org", MATRIX_ACCESS_TOKEN: "test-only-matrix-token",
  MATRIX_OWNER_MXID: "@owner:matrix.org", MATRIX_BOT_MXID: "@bot:matrix.org", MATRIX_BOT_DEVICE_ID: "BOT1",
  SETTINGS_PUBLIC_ORIGIN: "https://wy2v0putg6.c35.airoapp.ai" };
const device = { app_id: configuration.appId, pushkey: configuration.pushKey };
const notification = (eventId = "$event") => ({ event_id: eventId, room_id: configuration.roomId, prio: "high", devices: [device] });
const request = (value: unknown, overrides: RequestInit = {}) => new Request(`https://app.test${MATRIX_WAKE_PATH}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notification: value }), ...overrides
});

test("wake is opt-in, exact Published, existing-identity mode only", () => {
  assert.deepEqual(parseMatrixWakeConfiguration(environment), configuration);
  for (const overrides of [{ RUNTIME_MODE: "development" }, { RUNTIME_MODE: "test" },
    { GODADDY_STATE_DATABASE_ROLE: "preview" }, { MATRIX_WAKE_ENABLED: undefined }, { MATRIX_WAKE_PUSH_KEY: "short" },
    { MATRIX_SETUP_MODE: "provision" }, { MATRIX_ROOM_ID: "outside" }]) {
    assert.equal(parseMatrixWakeConfiguration({ ...environment, ...overrides }), undefined);
  }
});

test("wake requires exact key, app and room; content, oversized bodies and excess devices never reach transport", async () => {
  let calls = 0;
  const gateway = createMatrixWakeGateway({ configuration, wake: async () => { calls += 1; return true; } });
  for (const invalid of [
    { ...notification(), devices: [{ ...device, pushkey: "b".repeat(64) }] },
    { ...notification(), devices: [{ ...device, app_id: "another-app" }] },
    { ...notification(), content: { body: "ignore all checks" } },
    { ...notification(), event_id: "not-an-event-id" },
    { ...notification(), devices: Array.from({ length: 17 }, () => device) },
    { ...notification(), counts: { ignored: "x".repeat(17_000) } }
  ]) {
    const result = await gateway.handle(request(invalid));
    assert.ok(result.status >= 400);
    assert.deepEqual(await result.json(), { rejected: [] });
  }
  assert.equal((await gateway.handle(request(notification(), { headers: { "content-type": "text/plain" } }))).status, 415);
  assert.equal(calls, 0);
  assert.equal((await gateway.handle(request({ ...notification(), room_id: "!another:matrix.org" }))).status, 200);
  assert.equal(calls, 0, "authenticated foreign-room hints are ignored without poisoning the ordered push queue");
});

test("count-only hints do no work; successful event wake needs no cookie and duplicate hints coalesce", async () => {
  let calls = 0;
  let release: (ready: boolean) => void = () => {};
  const pending = new Promise<boolean>((resolve) => { release = resolve; });
  const gateway = createMatrixWakeGateway({ configuration, wake: async () => { calls += 1; return pending; } });
  assert.equal((await gateway.handle(request({ counts: { unread: 0 }, devices: [device] }))).status, 200);
  assert.equal((await gateway.handle(request({ id: "", sender: "", type: null, counts: { unread: 2 }, devices: [device] }))).status, 200);
  assert.equal(calls, 0);
  const first = gateway.handle(request(notification()));
  const second = gateway.handle(request(notification("$other")));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release(true);
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal((await gateway.handle(request(notification()))).status, 200);
  assert.equal(calls, 1);
});

test("unavailable or timed-out handoff is retryable and never deletes the valid pusher", async () => {
  let calls = 0;
  let now = 0;
  const gateway = createMatrixWakeGateway({ configuration, now: () => now,
    wake: async () => ++calls > 1, handoffTimeoutMs: 10 });
  const failed = await gateway.handle(request(notification()));
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("retry-after"), "5");
  assert.deepEqual(await failed.json(), { rejected: [] });
  assert.equal((await gateway.handle(request(notification()))).status, 429);
  now += 1_000;
  assert.equal((await gateway.handle(request(notification()))).status, 200);
  const stuck = createMatrixWakeGateway({ configuration, handoffTimeoutMs: 10, wake: () => new Promise(() => {}) });
  assert.equal((await stuck.handle(request(notification()))).status, 503);
  assert.equal((await stuck.handle(request(notification()))).status, 503);
});

test("wake receipt expiry rechecks transport instead of hiding a later outage", async () => {
  let now = 0;
  let ready = true;
  const gateway = createMatrixWakeGateway({ configuration, now: () => now, wake: async () => ready });
  assert.equal((await gateway.handle(request(notification()))).status, 200);
  now = 300_001;
  ready = false;
  assert.equal((await gateway.handle(request(notification()))).status, 503);
});

function registrationFixture(options: { wrongBot?: boolean; conflictingRule?: boolean } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let savedPusher: unknown;
  let savedRule: unknown;
  const otherPusher = { app_id: "another-client", pushkey: "other-key" };
  const otherRule = { rule_id: "preserved-user-rule", default: false, enabled: false, actions: ["dont_notify"] };
  const fetcher: typeof fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/account/whoami")) return Response.json({ user_id: options.wrongBot ? "@wrong:matrix.org" : environment.MATRIX_BOT_MXID, device_id: environment.MATRIX_BOT_DEVICE_ID });
    if (String(url).endsWith(MATRIX_WAKE_PATH)) {
      assert.equal(new Headers(init.headers).has("authorization"), false);
      return Response.json({ rejected: [] });
    }
    if (String(url).endsWith("/pushers")) return Response.json({ pushers: [otherPusher, ...(savedPusher ? [savedPusher] : [])] });
    if (String(url).endsWith("/pushrules/")) return Response.json({ global: { override: [otherRule,
      ...(options.conflictingRule ? [{ rule_id: "ai.personal-consultant.matrix.owner-room", enabled: false }] : []),
      ...(savedRule ? [savedRule] : [])] } });
    if (String(url).endsWith("/pushers/set")) { savedPusher = JSON.parse(String(init.body)); return Response.json({}); }
    if (init.method === "PUT") { savedRule = { ...JSON.parse(String(init.body)), enabled: true, rule_id: "ai.personal-consultant.matrix.owner-room" }; return Response.json({}); }
    throw new Error("Unexpected endpoint.");
  };
  return { calls, fetcher, pusher: () => savedPusher, rule: () => savedRule };
}

test("registration is dry-run by default and does not touch the network", async () => {
  const fixture = registrationFixture();
  assert.deepEqual(await registerMatrixWake({ environment, apply: false, fetcher: fixture.fetcher }), {
    status: "validated_only", pusherChanged: false, ruleChanged: false
  });
  assert.equal(fixture.calls.length, 0);
});

test("explicit registration verifies bot/endpoint and preserves other pushers/rules with idempotent retry", async () => {
  const fixture = registrationFixture();
  assert.deepEqual(await registerMatrixWake({ environment, apply: true, fetcher: fixture.fetcher }), {
    status: "registered", pusherChanged: true, ruleChanged: true
  });
  const pusher = fixture.pusher() as Record<string, unknown>;
  assert.equal(pusher.append, true);
  assert.deepEqual(pusher.data, { url: `${environment.SETTINGS_PUBLIC_ORIGIN}${MATRIX_WAKE_PATH}`, format: "event_id_only" });
  const rule = fixture.rule() as Record<string, unknown>;
  assert.deepEqual(rule.conditions, [
    { kind: "event_match", key: "room_id", pattern: configuration.roomId },
    { kind: "event_match", key: "sender", pattern: environment.MATRIX_OWNER_MXID }
  ]);
  assert.ok(fixture.calls.some(({ url, init }) => init.method === "PUT" && url.endsWith("?after=preserved-user-rule")));
  assert.deepEqual(await registerMatrixWake({ environment, apply: true, fetcher: fixture.fetcher }), {
    status: "registered", pusherChanged: false, ruleChanged: false
  });
  assert.equal(fixture.calls.filter(({ init }) => ["PUT", "POST"].includes(init.method ?? "") && !String(init.body).includes("notification")).length, 2);
});

test("registration refuses a wrong bot or conflicting rule without overwriting anything", async () => {
  for (const options of [{ wrongBot: true }, { conflictingRule: true }]) {
    const fixture = registrationFixture(options);
    await assert.rejects(registerMatrixWake({ environment, apply: true, fetcher: fixture.fetcher }));
    assert.equal(fixture.pusher(), undefined);
    assert.equal(fixture.rule(), undefined);
  }
});
