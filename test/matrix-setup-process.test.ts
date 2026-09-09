import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { spawn } from "node:child_process";
import { parseMatrixSetupStatus, spawnMatrixSetupProcess } from "../src/godaddy/matrix-setup-process.ts";
import { matrixSetupDocument } from "../src/godaddy/matrix-setup-page.ts";

test("MySQL setup offers explicit new-device setup without Preview ceremony", () => {
  const html = matrixSetupDocument({ state: "prepared", storeBackend: "mysql", mysqlTransport: {
    nodeDatabaseReachable: true, nodeSessionEncrypted: false, nodeExtraCaConfigured: false,
    nodeAdditionalSystemCaActive: false, serverTlsSupport: "disabled", secureTransportRequired: false,
    verifiedTlsConnection: "server_not_supported",
    verifiedTlsIdentityConnection: "server_identity_rejected"
  } }, "synthetic-token");
  assert.match(html, /Підключити наявний пристрій через MySQL/u);
  assert.match(html, /Перевірити програми Matrix/u);
  assert.match(html, /value="start_fresh"/u);
  assert.doesNotMatch(html, /Перевірити авторизований Preview|приватність каталогів/u);
  assert.doesNotMatch(html, /перевірка HTTP-доступу пройдена/u);
  assert.match(html, /Транспорт MySQL|TLS на сервері MySQL: вимкнений/u);
  assert.doesNotMatch(html, /DB_HOST|password|certificate/u);
});

const status = () => ({ own_bot_device_id: "NEW_DEVICE", own_bot_ed25519: "A".repeat(43),
  self_identity_verified: false, owner_identity_verified: false, private_cross_signing_ready: false,
  devices: { self: [{ device_id: "TRUSTED_DEVICE", ed25519: "B".repeat(43), verified: false,
    blacklisted: false, cross_signed_by_owner: true, deleted: false }], owner: [] }, verification: null });

test("setup status projects only public fingerprints and strict known fields", () => {
  assert.deepEqual(parseMatrixSetupStatus(status()), status());
  assert.equal(parseMatrixSetupStatus({ ...status(), access_token: "never reflect" }), undefined);
  assert.equal(parseMatrixSetupStatus({ ...status(), own_bot_ed25519: "not-a-key" }), undefined);
  const nullable = status(); nullable.devices.self[0]!.ed25519 = null as unknown as string;
  assert.ok(parseMatrixSetupStatus(nullable));
  const duplicate = status(); duplicate.devices.self.push(duplicate.devices.self[0]!);
  assert.equal(parseMatrixSetupStatus(duplicate), undefined);
});

test("setup comparison has an exact flow, bounded SAS and one-time comparison token", () => {
  const flow = { phase: "compare", target: "self", other_device_id: "TRUSTED_DEVICE", other_user_id: "@test-bot:matrix.org",
    generation: "c".repeat(32), flow_id: "flow", comparison_token: "d".repeat(32),
    emojis: null, decimals: [1234, 2345, 3456], confirmed: false };
  assert.ok(parseMatrixSetupStatus({ ...status(), verification: flow }));
  for (const bad of [{ ...flow, decimals: [1, 2, 3] }, { ...flow, decimals: null }, { ...flow, access_token: "secret" },
    { ...flow, comparison_token: "wrong" }]) assert.equal(parseMatrixSetupStatus({ ...status(), verification: bad }), undefined);
});

function childFixture(now?: () => number) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; kill: () => boolean };
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  child.stdin = new Writable({ write(chunk, _encoding, callback) { requests.push(JSON.parse(String(chunk))); callback(); } });
  let killed = false;
  child.kill = () => { if (!killed) { killed = true; queueMicrotask(() => child.emit("exit", 0)); } return true; };
  const frames = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
  const input = { binaryPath: "/private/pinned/setup", applicationRoot: "/app", fresh: true,
    environment: { MATRIX_ACCESS_TOKEN: "test-only-token" } };
  let options: unknown;
  const process = spawnMatrixSetupProcess(input, { spawn: ((_file: string, _args: string[], captured: unknown) => {
    options = captured; return child;
  }) as unknown as typeof spawn, requestTimeoutMs: 100, now });
  return { child, frames, process, requests, options };
}

test("setup transport requires handshake, sends exact explicit commands, and does not inherit host credentials", async () => {
  const fixture = childFixture();
  await assert.rejects(fixture.process.request({ type: "status" }), /starting/);
  fixture.frames({ version: 1, type: "setup_ready" });
  const pending = fixture.process.request({ type: "status" });
  const request = fixture.requests[0]!;
  assert.deepEqual(request.command, { type: "status" });
  assert.deepEqual((fixture.options as { env: unknown }).env, { MATRIX_ACCESS_TOKEN: "test-only-token" });
  fixture.child.stderr.write("secret raw library error must be discarded");
  fixture.frames({ version: 1, id: request.id, ok: true, status: status() });
  assert.deepEqual(await pending, status());
  await fixture.process.close();
});

test("startup failure preserves only known safe native codes", async () => {
  for (const code of ["configuration_invalid", "store_locked", "store_or_device_quarantined", "transport_or_store_unavailable",
    "mysql_connection_timeout", "mysql_tls_failed", "mysql_login_or_database_failed", "mysql_connection_failed",
    "mysql_client_configuration_failed", "mysql_address_failed", "mysql_connection_refused", "mysql_connection_closed",
    "mysql_socket_denied", "mysql_io_failed", "mysql_protocol_failed",
    "mysql_session_timeout", "mysql_session_configuration_failed"]) {
    const fixture = childFixture();
    fixture.frames({ version: 1, type: "setup_failed", error: code });
    await assert.rejects(fixture.process.request({ type: "status" }), { message: code });
    await fixture.process.close();
  }
  const fixture = childFixture();
  fixture.frames({ version: 1, type: "setup_failed", error: "private-token-or-sdk-output" });
  await assert.rejects(fixture.process.request({ type: "status" }), { message: "matrix_setup_unavailable" });
  await fixture.process.close();
});

test("unexpected child response fields fail closed instead of leaking into owner UI", async () => {
  const fixture = childFixture(); fixture.frames({ version: 1, type: "setup_ready" });
  const pending = fixture.process.request({ type: "status" });
  fixture.frames({ version: 1, id: fixture.requests[0]!.id, ok: true, status: { ...status(), token: "private" } });
  await assert.rejects(pending, /protocol_error/);
  await fixture.process.close();
});

test("final flushed status is accepted when child exit arrives before stdout drains", async () => {
  const fixture = childFixture(); fixture.frames({ version: 1, type: "setup_ready" });
  const pending = fixture.process.request({ type: "finish" });
  fixture.child.emit("exit", 0);
  fixture.frames({ version: 1, id: fixture.requests[0]!.id, ok: true, status: status() });
  fixture.child.emit("close", 0);
  assert.deepEqual(await pending, status());
  await fixture.process.close();
});

test("owner setup markup shows codes for comparison, no secret inputs or automatic confirmation", () => {
  const value = parseMatrixSetupStatus(status())!;
  const document = matrixSetupDocument({ state: "verifying", status: value }, "test-form-token");
  assert.match(document, /TRUSTED_DEVICE/);
  assert.doesNotMatch(document, /name="(?:password|access_token|recovery_key)"/u);
  assert.doesNotMatch(document, /name="action" value="confirm"/u);
  const escaped = matrixSetupDocument({ state: "verifying", error: "<script>evil</script>" }, "token");
  assert.doesNotMatch(escaped, /<script>evil/);
});

test("a near-expiry process refuses new SAS without sending an invitation", async () => {
  let now = 1_000;
  const fixture = childFixture(() => now); fixture.frames({ version: 1, type: "setup_ready" });
  assert.equal(fixture.process.expiresAt, 901_000);
  now += 10 * 60_000;
  for (const type of ["start_self_verification", "start_owner_verification"] as const) {
    await assert.rejects(fixture.process.request({ type, device_id: "TRUSTED_DEVICE" }), /matrix_setup_needs_resume/);
  }
  assert.deepEqual(fixture.requests, []);
  // Existing exchanges can still finish inside the deadline.
  const pending = fixture.process.request({ type: "status" });
  fixture.frames({ version: 1, id: fixture.requests[0]!.id, ok: true, status: status() });
  await pending;
  now = 901_000;
  await assert.rejects(fixture.process.request({ type: "status" }), /matrix_setup_expired/);
  await fixture.process.close();
});
