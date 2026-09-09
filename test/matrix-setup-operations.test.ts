import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { createMatrixSetupOperations, matrixSetupEnabled } from "../src/godaddy/matrix-setup-operations.ts";
import type { MatrixReleaseInspection } from "../src/godaddy/matrix-release-install.ts";
import type { MatrixSetupCommand } from "../src/godaddy/matrix-setup-process.ts";
import { matrixSetupDocument } from "../src/godaddy/matrix-setup-page.ts";
import type { MatrixBrowserChallenge } from "../src/godaddy/matrix-browser-isolation.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const inspection = (provisioning: MatrixReleaseInspection["storeProvisioning"] = "empty"): MatrixReleaseInspection => ({
  sidecarPath: `${root}/runtime/matrix/personal-consultant-matrix-sidecar`, setupPath: `${root}/runtime/matrix/personal-consultant-matrix-setup`,
  sidecarSha256: "a".repeat(64), setupSha256: "b".repeat(64),
  storeDir: `${root}/public/assets/.personal-consultant-matrix-v1/crypto-store`,
  mediaSpoolDir: `${root}/public/assets/.personal-consultant-matrix-v1/media-spool`,
  storeState: provisioning === "empty" ? "empty" : "contains_state", storeProvisioning: provisioning,
  mediaSpoolState: "empty", credentialReadiness: "requires_http_isolation"
});
const env = () => ({ RUNTIME_MODE: "production", GODADDY_STATE_DATABASE_ROLE: "published", MATRIX_SETUP_MODE: "provision",
  MATRIX_SIDECAR_PATH: inspection().sidecarPath, MATRIX_SIDECAR_SHA256: "a".repeat(64), MATRIX_PROTOCOL_VERSION: "1",
  MATRIX_STORE_DIR: inspection().storeDir, MATRIX_MEDIA_SPOOL_DIR: inspection().mediaSpoolDir,
  MATRIX_STORE_PASSPHRASE: "c".repeat(64), MATRIX_HOMESERVER_URL: "https://matrix.org", MATRIX_ALLOWED_HTTPS_ORIGINS: "https://matrix.org",
  MATRIX_BOT_MXID: "@test-bot:matrix.org", MATRIX_BOT_DEVICE_ID: "NEW_DEVICE", MATRIX_ACCESS_TOKEN: "test-only-token",
  MATRIX_OWNER_MXID: "@test-owner:matrix.org", MATRIX_ROOM_ID: "!test-room:matrix.org" });
function fixture(options: { environment?: Record<string, unknown>; provisioning?: MatrixReleaseInspection["storeProvisioning"]; isolation?: boolean; requestError?: string } = {}) {
  const calls: unknown[] = [];
  const setup = createMatrixSetupOperations(options.environment ?? env(), {
    releasePin: { manifestSha256: "d".repeat(64), sourceCommit: "e".repeat(40) }, applicationRoot: root,
    prepare: async () => { calls.push("prepare"); return { ok: true, value: inspection(options.provisioning) }; },
    inspect: async () => { calls.push("inspect"); return { ok: true, value: inspection(options.provisioning) }; },
    isolation: async () => { calls.push("isolation"); return options.isolation === false
      ? { ok: false, code: "matrix_http_isolation_failed" }
      : { ok: true, checkedPaths: 12, credentialReadiness: "http_isolation_verified" }; },
    spawn: input => { calls.push({ fresh: input.fresh, environment: input.environment }); return {
      request: async (command: MatrixSetupCommand) => { calls.push(command); if (options.requestError) throw new Error(options.requestError); return { own_bot_device_id: "NEW_DEVICE", own_bot_ed25519: null,
        self_identity_verified: true, owner_identity_verified: true, private_cross_signing_ready: true,
        devices: { self: [], owner: [] }, verification: null }; },
      close: async () => { calls.push("close"); }
    }; }
  });
  return { setup, calls };
}

function mysqlFixture(options: { failInspect?: boolean; requestError?: string; spawnError?: boolean; failCloseOnce?: boolean } = {}) {
  const calls: string[] = [];
  let closeFailed = false;
  let spawned: Parameters<NonNullable<Parameters<typeof createMatrixSetupOperations>[1]>["spawn"] & {}>[0] | undefined;
  const legacy = inspection();
  const result = { storeBackend: "mysql" as const, sidecarPath: legacy.sidecarPath, setupPath: legacy.setupPath,
    sidecarSha256: legacy.sidecarSha256, setupSha256: legacy.setupSha256 };
  const setup = createMatrixSetupOperations({ ...env(), MATRIX_STORE_BACKEND: "mysql",
    DB_HOST: "127.0.0.1", DB_PORT: "3306", DB_NAME: "synthetic", DB_USER: "synthetic", DB_PASSWORD: "synthetic" }, {
    releasePin: { manifestSha256: "d".repeat(64), sourceCommit: "e".repeat(40) }, applicationRoot: root,
    prepare: async () => { assert.fail("MySQL must not prepare legacy files"); },
    inspect: async () => { assert.fail("MySQL must not inspect legacy files"); },
    isolation: async () => { assert.fail("MySQL must not run Preview HTTP ceremony"); },
    prepareMySql: async () => { calls.push("prepare_mysql"); return { ok: true, value: result }; },
    inspectMySql: async () => { calls.push("inspect_mysql"); return options.failInspect
      ? { ok: false, code: "matrix_release_checksum_mismatch" } : { ok: true, value: result }; },
    spawn: input => {
      calls.push("spawn"); spawned = input;
      if (options.spawnError) throw new Error("matrix_setup_unavailable");
      return { request: async () => {
        if (options.requestError) throw new Error(options.requestError);
        return { own_bot_device_id: "NEW_DEVICE", own_bot_ed25519: null, self_identity_verified: true,
          owner_identity_verified: true, private_cross_signing_ready: true, devices: { self: [], owner: [] }, verification: null };
      }, close: async () => {
        calls.push("close");
        if (options.failCloseOnce && !closeFailed) { closeFailed = true; throw new Error("matrix_setup_termination_failed"); }
      } };
    }
  });
  return { setup, calls, spawned: () => spawned };
}

test("MySQL setup prepares binaries without Preview and resumes with a private disposable shared spool", async () => {
  const f = mysqlFixture();
  assert.equal(f.setup.view().storeBackend, "mysql");
  assert.equal((await f.setup.action("resume", {})).error, "matrix_setup_not_prepared");
  assert.equal((await f.setup.action("start_fresh", {})).error, "matrix_setup_not_prepared");
  for (const action of ["complete_preview", "restrict_media_permissions"] as const) {
    assert.equal((await f.setup.action(action, {})).error, "matrix_setup_invalid_request");
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.setup.action("prepare", {}, "owner-session"), { state: "prepared", storeBackend: "mysql" });
  assert.equal((await f.setup.action("resume", {})).state, "starting");
  assert.deepEqual(f.calls, ["prepare_mysql", "inspect_mysql", "spawn"]);
  const spawned = f.spawned()!;
  assert.equal(spawned.fresh, false);
  assert.equal(spawned.environment.MATRIX_STORE_BACKEND, "mysql");
  assert.equal(spawned.environment.DB_PASSWORD, "synthetic");
  const spool = spawned.environment.MATRIX_MEDIA_SPOOL_DIR!;
  assert.equal(spawned.environment.MATRIX_STORE_DIR, spool);
  assert.equal(dirname(spool), spawned.environment.TMPDIR);
  assert.match(spool, /\/pc-matrix-setup-[^/]+$/);
  assert.doesNotMatch(spool, /public\/assets/);
  assert.equal((await lstat(spool)).mode & 0o7777, 0o700);
  assert.equal(dirname(spawned.environment.SSL_CERT_FILE!), spool);
  assert.equal((await lstat(spawned.environment.SSL_CERT_FILE!)).mode & 0o7777, 0o600);
  assert.match(await readFile(spawned.environment.SSL_CERT_FILE!, "utf8"), /^-----BEGIN CERTIFICATE-----/u);
  assert.equal((await f.setup.action("status", {})).state, "verifying");
  assert.equal((await f.setup.action("finish", {})).state, "complete");
  await assert.rejects(lstat(spool), { code: "ENOENT" });
  assert.equal((await f.setup.action("resume", {})).error, "matrix_setup_not_prepared");
  await f.setup.close();
});

test("MySQL fresh setup passes explicit fresh intent only after release preparation", async () => {
  const f = mysqlFixture();
  await f.setup.action("prepare", {});
  assert.equal((await f.setup.action("start_fresh", {})).state, "starting");
  assert.equal(f.spawned()!.fresh, true);
  assert.equal(f.spawned()!.environment.MATRIX_STORE_BACKEND, "mysql");
  await f.setup.close();
});

test("MySQL setup rejects changed release and removes its spool only after child shutdown or failed spawn", async () => {
  const denied = mysqlFixture({ failInspect: true });
  await denied.setup.action("prepare", {});
  assert.equal((await denied.setup.action("resume", {})).error, "matrix_release_checksum_mismatch");
  assert.equal(denied.spawned(), undefined); await denied.setup.close();
  for (const mode of ["stop", "close", "failure", "spawn_failure"] as const) {
    const f = mysqlFixture({ ...(mode === "failure" ? { requestError: "matrix_setup_process_failed" } : {}),
      ...(mode === "spawn_failure" ? { spawnError: true } : {}) });
    await f.setup.action("prepare", {}); await f.setup.action("resume", {});
    const spool = f.spawned()!.environment.MATRIX_MEDIA_SPOOL_DIR!;
    if (mode === "stop") await f.setup.action("stop", {});
    if (mode === "close") await f.setup.close();
    if (mode === "failure") assert.equal((await f.setup.action("status", {})).state, "stopped");
    await assert.rejects(lstat(spool), { code: "ENOENT" });
    await f.setup.close();
  }
});

test("MySQL setup retains the shared spool when child termination is not confirmed", async () => {
  const f = mysqlFixture({ failCloseOnce: true });
  await f.setup.action("prepare", {}); await f.setup.action("resume", {});
  const spool = f.spawned()!.environment.MATRIX_MEDIA_SPOOL_DIR!;
  assert.equal((await f.setup.action("stop", {})).error, "matrix_setup_termination_failed");
  assert.ok((await lstat(spool)).isDirectory());
  await f.setup.close();
  await assert.rejects(lstat(spool), { code: "ENOENT" });
});
test("Published setup mode is explicit and Preview cannot prepare files or start a child", async () => {
  for (const environment of [{ ...env(), RUNTIME_MODE: "development" }, { ...env(), GODADDY_STATE_DATABASE_ROLE: "preview" },
    { ...env(), MATRIX_SETUP_MODE: "TRUE" }]) {
    assert.equal(matrixSetupEnabled(environment), false);
    const { setup, calls } = fixture({ environment });
    assert.equal((await setup.action("prepare", {})).error, "matrix_setup_disabled"); assert.deepEqual(calls, []);
  }
});

test("permission repair cannot be invoked without the exact diagnostic or during active setup", async () => {
  const { setup } = fixture();
  assert.equal((await setup.action("restrict_media_permissions", {})).error, "matrix_setup_invalid_request");
  await setup.action("prepare", {}); await setup.action("start_fresh", {});
  assert.equal((await setup.action("restrict_media_permissions", {})).error, "matrix_setup_busy");
  await setup.close();
  const preview = fixture({ environment: { ...env(), RUNTIME_MODE: "development" } });
  assert.equal((await preview.setup.action("restrict_media_permissions", {})).error, "matrix_setup_disabled");
  assert.deepEqual(preview.calls, []);
});
test("safe native errors retain actionable guidance but arbitrary SDK text is never exposed", async () => {
  for (const [code, guidance] of [
    ["self_verification_required", "Спочатку завершіть порівняння"],
    ["stale_comparison", "Це порівняння вже неактуальне"],
    ["peer_not_cross_signed", "Обраний пристрій ще не підписаний"],
    ["transport_unavailable", "Зв’язок із сервером Matrix"],
    ["secret SDK failure test-token", "Перевірте конфігурацію Published"]
  ]) {
    const { setup } = fixture({ requestError: code });
    await setup.action("prepare", {}); await setup.action("start_fresh", {});
    const view = await setup.action("status", {});
    assert.equal(view.error, code.startsWith("secret") ? "matrix_setup_failed" : code);
    const html = matrixSetupDocument(view, "synthetic-csrf");
    assert.ok(html.includes(guidance!)); assert.ok(!html.includes("test-token"));
    await setup.close();
  }
});
test("fresh initialization requires verified release and separate successful HTTP isolation first", async () => {
  const { setup, calls } = fixture();
  assert.equal((await setup.action("start_fresh", {})).error, "matrix_setup_not_prepared"); assert.deepEqual(calls, []);
  assert.equal((await setup.action("prepare", {})).state, "prepared");
  assert.equal((await setup.action("start_fresh", {})).state, "starting");
  assert.deepEqual(calls.slice(0, 3), ["prepare", "isolation", "inspect"]);
  const spawned = calls[3] as { fresh: boolean; environment: Record<string, string> };
  assert.equal(spawned.fresh, true); assert.equal(spawned.environment.MATRIX_ACCESS_TOKEN, "test-only-token");
  assert.equal(Object.hasOwn(spawned.environment, "GODADDY_STATE_DATABASE_ROLE"), false);
  assert.equal((await setup.action("status", {})).state, "verifying");
  assert.equal((await setup.action("finish", {})).state, "complete"); assert.equal(calls.at(-1), "close");
});
test("failed isolation never unlocks credential-bearing child execution", async () => {
  const { setup, calls } = fixture({ isolation: false });
  assert.equal((await setup.action("prepare", {})).error, "matrix_http_isolation_failed");
  assert.equal((await setup.action("start_fresh", {})).error, "matrix_setup_not_prepared");
  assert.deepEqual(calls, ["prepare", "isolation"]);
});
test("failed preparation renders content-free probe diagnostics without unlocking setup", async () => {
  const diagnostics = { stage: "anonymous_http" as const,
    probes: [{ environment: "preview" as const, target: "sidecar" as const, status: 503, denied: false }] };
  const setup = createMatrixSetupOperations(env(), {
    releasePin: { manifestSha256: "d".repeat(64), sourceCommit: "e".repeat(40) }, applicationRoot: root,
    prepare: async () => ({ ok: true, value: inspection() }),
    isolation: async (_root, _pin, _fetch, _options, _browser, observe) => {
      observe?.(diagnostics); return { ok: false, code: "matrix_http_isolation_failed" };
    }, spawn: () => { assert.fail("failed diagnostic is not permission to spawn"); }
  });
  const view = await setup.action("prepare", {}, "owner-session");
  assert.deepEqual(view.isolationDiagnostics, diagnostics);
  const html = matrixSetupDocument(view, "synthetic-csrf");
  assert.match(html, /preview · sidecar · HTTP 503/);
  assert.doesNotMatch(html, /value="start_fresh"/);
  assert.equal((await setup.action("start_fresh", {})).error, "matrix_setup_not_prepared");
  await setup.close();
});
test("a failed repeat preparation revokes the previous successful view and keeps exact isolation errors", async () => {
  for (const code of ["matrix_http_isolation_failed", "matrix_http_isolation_cleanup_failed"] as const) {
    let fail = false;
    let spawns = 0;
    const setup = createMatrixSetupOperations(env(), {
      releasePin: { manifestSha256: "d".repeat(64), sourceCommit: "e".repeat(40) }, applicationRoot: root,
      prepare: async () => ({ ok: true, value: inspection() }),
      isolation: async () => fail ? { ok: false, code }
        : { ok: true, checkedPaths: 12, credentialReadiness: "http_isolation_verified" },
      spawn: () => { spawns += 1; throw new Error("must not spawn"); }
    });
    assert.equal((await setup.action("prepare", {})).state, "prepared");
    fail = true;
    const failed = await setup.action("prepare", {});
    assert.deepEqual(failed, { state: "unprepared", error: code });
    const html = matrixSetupDocument(failed, "synthetic-csrf");
    assert.ok(!html.includes("перевірка HTTP-доступу пройдена"));
    assert.ok(!html.includes('value="start_fresh"'));
    assert.ok(html.includes(code));
    assert.equal((await setup.action("start_fresh", {})).error, "matrix_setup_not_prepared");
    assert.equal(spawns, 0);
    await setup.close();
  }
});
test("existing state cannot be freshly initialized; exact incomplete intent selects native recovery, bound state does not", async () => {
  for (const provisioning of ["bound", "incomplete"] as const) {
    const { setup, calls } = fixture({ provisioning });
    await setup.action("prepare", {});
    assert.equal((await setup.action("start_fresh", {})).error, "matrix_store_not_empty");
    assert.equal((await setup.action("resume", {})).state, "starting");
    const spawned = calls.at(-1) as { fresh: boolean };
    assert.equal(spawned.fresh, provisioning === "incomplete");
    await setup.close();
  }
});

test("dead setup revokes old SAS and supports a checked existing-store resume", async () => {
  for (const code of ["matrix_setup_unavailable", "matrix_setup_expired", "matrix_setup_needs_resume",
    "matrix_setup_process_failed", "matrix_setup_timeout", "matrix_setup_protocol_error", "setup_expired"]) {
    const options = { provisioning: "bound" as const, requestError: "" };
    const { setup, calls } = fixture(options);
    await setup.action("prepare", {}); await setup.action("resume", {});
    await setup.action("status", {});
    options.requestError = code;
    const stopped = await setup.action("status", {});
    assert.deepEqual(stopped, { state: "stopped", error: code });
    assert.equal(calls.at(-1), "close");
    const html = matrixSetupDocument(stopped, "synthetic-csrf");
    assert.doesNotMatch(html, /value="(?:confirm|verify_self|verify_owner|start_fresh)"/);
    assert.match(html, /value="prepare"/);
    assert.equal((await setup.action("resume", {})).error, "matrix_setup_not_prepared");
    options.requestError = "";
    await setup.action("prepare", {});
    assert.equal((await setup.action("resume", {})).state, "starting");
    assert.equal((calls.at(-1) as { fresh: boolean }).fresh, false);
    await setup.close();
  }
});

test("a stale SAS error removes its confirmation token but preserves device status", async () => {
  const options = { requestError: "" };
  const { setup } = fixture(options);
  await setup.action("prepare", {}); await setup.action("start_fresh", {});
  const current = await setup.action("status", {});
  // Inject only a synthetic previously-rendered flow into this fixture's status.
  Object.assign(current.status!, { verification: { phase: "compare", target: "self", other_device_id: "TRUSTED_DEVICE",
    other_user_id: "@test-bot:matrix.org", generation: "c".repeat(32), flow_id: "old-flow",
    comparison_token: "d".repeat(32), emojis: null, decimals: [1234, 2345, 3456], confirmed: false } });
  assert.match(matrixSetupDocument(current, "synthetic-csrf"), /value="confirm"/);
  options.requestError = "stale_comparison";
  const stale = await setup.action("confirm", { flowId: "old-flow", comparisonToken: "d".repeat(32) });
  assert.equal(stale.state, "verifying"); assert.equal(stale.status?.verification, null);
  assert.equal(stale.status?.own_bot_device_id, "NEW_DEVICE");
  assert.doesNotMatch(matrixSetupDocument(stale, "synthetic-csrf"), /value="confirm"|1234 · 2345 · 3456/);
  await setup.close();
});

const browserChallenge = (): MatrixBrowserChallenge => ({ nonce: "a".repeat(32), expiresAt: Date.now() + 180000,
  verifierHash: "b".repeat(64), paths: [], canaries: [], positivePath: "/assets/test.txt", positiveBody: "test" });
test("cancelling a browser challenge cannot conceal a temporary-file cleanup failure", async () => {
  const setup = createMatrixSetupOperations(env(), {
    releasePin: { manifestSha256: "d".repeat(64), sourceCommit: "e".repeat(40) }, applicationRoot: root,
    prepare: async () => ({ ok: true, value: inspection() }),
    isolation: async (_root, _pin, _fetch, _options, browser) => {
      await browser!(browserChallenge()); return { ok: false, code: "matrix_http_isolation_cleanup_failed" };
    }, spawn: () => { assert.fail("cleanup failure cannot start provisioning"); }
  });
  await setup.action("prepare", {}, "owner");
  const result = await setup.action("stop", {}, "owner");
  assert.equal(result.state, "unprepared"); assert.equal(result.error, "matrix_http_isolation_cleanup_failed");
  assert.equal((await setup.action("start_fresh", {})).error, "matrix_setup_not_prepared");
  await setup.close();
});
test("pending browser check is bound to the initiating owner session and cannot start a child or replay", async () => {
  let cleanup = false;
  const setup = createMatrixSetupOperations(env(), {
    releasePin: { manifestSha256: "d".repeat(64), sourceCommit: "e".repeat(40) }, applicationRoot: root,
    prepare: async () => ({ ok: true, value: inspection() }),
    isolation: async (_root, _pin, _fetch, _options, browser) => {
      const report = await browser!(browserChallenge()); cleanup = true;
      return report === true ? { ok: true, checkedPaths: 12, credentialReadiness: "http_isolation_verified", evidenceKind: "browser_assisted_http_isolation" }
        : { ok: false, code: "matrix_http_isolation_failed" };
    },
    spawn: () => { throw Error("must not start"); }
  });
  assert.equal((await setup.action("prepare", {}, "session-one")).state, "awaiting_preview");
  assert.equal((await setup.action("start_fresh", {}, "session-one")).error, "matrix_setup_not_prepared");
  assert.equal((await setup.action("complete_preview", { previewReport: "true" }, "other-session")).error, "matrix_setup_invalid_request");
  assert.equal(cleanup, false);
  assert.equal((await setup.action("complete_preview", { previewReport: "true" }, "session-one")).state, "prepared");
  assert.equal(cleanup, true); assert.equal(setup.view().isolationEvidence, "browser_assisted_http_isolation");
  assert.equal((await setup.action("complete_preview", { previewReport: "true" }, "session-one")).error, "matrix_setup_invalid_request");
  await setup.close();
});
test("shutdown during either preparation or initial probes cannot create a later browser challenge", async () => {
  for (const stage of ["prepare", "probes"] as const) {
    let release!: () => void; let entered!: () => void; let done = false;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const setup = createMatrixSetupOperations(env(), {
      releasePin: { manifestSha256: "d".repeat(64), sourceCommit: "e".repeat(40) }, applicationRoot: root,
      prepare: async () => { if (stage === "prepare") { entered(); await pending; } return { ok: true, value: inspection() }; },
      isolation: async (_root, _pin, _fetch, _options, browser) => {
        entered(); await pending; assert.equal(await browser!(browserChallenge()), undefined);
        return { ok: false, code: "matrix_http_isolation_failed" };
      }
    });
    const preparing = setup.action("prepare", {}, "owner"); await reached;
    const closing = setup.close().then(() => { done = true; });
    await Promise.resolve(); assert.equal(done, false); release();
    await Promise.all([preparing, closing]); assert.equal(done, true);
    assert.notEqual(setup.view().state, "awaiting_preview"); assert.equal(setup.view().browserChallenge, undefined);
  }
});
