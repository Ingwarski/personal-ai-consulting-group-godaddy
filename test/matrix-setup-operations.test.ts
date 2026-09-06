import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createMatrixSetupOperations, matrixSetupEnabled } from "../src/godaddy/matrix-setup-operations.ts";
import type { MatrixReleaseInspection } from "../src/godaddy/matrix-release-install.ts";
import type { MatrixSetupCommand } from "../src/godaddy/matrix-setup-process.ts";
import { matrixSetupDocument } from "../src/godaddy/matrix-setup-page.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const inspection = (provisioning: MatrixReleaseInspection["storeProvisioning"] = "empty"): MatrixReleaseInspection => ({
  sidecarPath: `${root}/.runtime/matrix/personal-consultant-matrix-sidecar`, setupPath: `${root}/.runtime/matrix/personal-consultant-matrix-setup`,
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
test("Published setup mode is explicit and Preview cannot prepare files or start a child", async () => {
  for (const environment of [{ ...env(), RUNTIME_MODE: "development" }, { ...env(), GODADDY_STATE_DATABASE_ROLE: "preview" },
    { ...env(), MATRIX_SETUP_MODE: "TRUE" }]) {
    assert.equal(matrixSetupEnabled(environment), false);
    const { setup, calls } = fixture({ environment });
    assert.equal((await setup.action("prepare", {})).error, "matrix_setup_disabled"); assert.deepEqual(calls, []);
  }
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
  assert.ok((await setup.action("prepare", {})).error);
  assert.equal((await setup.action("start_fresh", {})).error, "matrix_setup_not_prepared");
  assert.deepEqual(calls, ["prepare", "isolation"]);
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
