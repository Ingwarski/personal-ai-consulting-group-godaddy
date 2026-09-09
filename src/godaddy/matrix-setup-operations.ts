import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseGoDaddyMatrixConfiguration } from "./matrix-service-config.ts";
import { inspectMatrixRelease, prepareMatrixRelease, verifyMatrixHttpIsolation, restrictMatrixMediaPermissions,
  prepareMySqlMatrixRelease, inspectMySqlMatrixRelease,
  type MatrixReleaseExpectation, type MatrixIsolationDiagnostics, type MatrixReleaseDiagnostic } from "./matrix-release-install.ts";
import { MATRIX_RELEASE_PIN } from "./matrix-release-pin.ts";
import type { MatrixBrowserChallenge } from "./matrix-browser-isolation.ts";
import { spawnMatrixSetupProcess, type MatrixSetupProcess, type MatrixSetupCommand } from "./matrix-setup-process.ts";
import type { MatrixSetupAction, MatrixSetupView } from "./matrix-setup-page.ts";

export type MatrixSetupFields = Readonly<{ deviceId?: string; flowId?: string; comparisonToken?: string; previewReport?: string }>;
export type MatrixSetupOperations = Readonly<{
  view: () => MatrixSetupView;
  action: (action: MatrixSetupAction, fields: MatrixSetupFields, ownerBinding?: string) => Promise<MatrixSetupView>;
  close: () => Promise<void>;
}>;
const nativeSetupErrors = new Set(["configuration_invalid", "input_unavailable", "invalid_options", "invalid_request",
  "invalid_verification_target", "no_active_verification", "operation_timed_out", "output_unavailable", "peer_not_cross_signed",
  "policy_not_ready", "self_verification_required", "setup_expired", "stale_comparison", "store_locked",
  "store_or_device_quarantined", "too_many_devices", "transport_or_store_unavailable", "transport_unavailable",
  "verification_already_active", "verification_peer_changed", "mysql_connection_timeout", "mysql_tls_failed",
  "mysql_login_or_database_failed", "mysql_client_configuration_failed", "mysql_address_failed", "mysql_connection_refused",
  "mysql_connection_closed", "mysql_socket_denied", "mysql_io_failed", "mysql_protocol_failed", "mysql_connection_failed",
  "mysql_session_timeout", "mysql_session_configuration_failed"]);
const isolationErrors = new Set(["matrix_http_isolation_failed", "matrix_http_isolation_cleanup_failed"]);
const terminalProcessErrors = new Set(["matrix_setup_unavailable", "matrix_setup_process_failed", "matrix_setup_protocol_error",
  "matrix_setup_timeout", "matrix_setup_expired", "matrix_setup_needs_resume", "matrix_setup_closed", "setup_expired"]);
export const matrixSetupEnabled = (environment: Record<string, unknown>): boolean =>
  environment.RUNTIME_MODE === "production" && environment.GODADDY_STATE_DATABASE_ROLE === "published"
  && environment.MATRIX_SETUP_MODE === "provision";

export function createMatrixSetupOperations(environment: Record<string, unknown>, dependencies: Readonly<{
  releasePin?: MatrixReleaseExpectation;
  applicationRoot?: string;
  prepare?: typeof prepareMatrixRelease;
  inspect?: typeof inspectMatrixRelease;
  prepareMySql?: typeof prepareMySqlMatrixRelease;
  inspectMySql?: typeof inspectMySqlMatrixRelease;
  isolation?: typeof verifyMatrixHttpIsolation;
  spawn?: typeof spawnMatrixSetupProcess;
}> = {}): MatrixSetupOperations {
  const enabled = matrixSetupEnabled(environment);
  const mysql = environment.MATRIX_STORE_BACKEND === "mysql";
  const root = dependencies.applicationRoot ?? resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const pin = dependencies.releasePin ?? MATRIX_RELEASE_PIN;
  let view: MatrixSetupView = { state: enabled ? "unprepared" : "disabled" };
  let process: MatrixSetupProcess | undefined;
  let busy = false;
  let isolationConfirmed = false;
  let closed = false;
  let browserPending: { challenge: MatrixBrowserChallenge; ownerBinding: string; resolve: (report: unknown) => void } | undefined;
  let isolationRun: Promise<MatrixSetupView> | undefined;
  let activeAction: Promise<MatrixSetupView> | undefined;
  let isolationExpiresAt = 0;
  let mysqlPrepared = false;
  let transientSpool: { path: string; dev: number; ino: number } | undefined;
  const publicView = (value: MatrixSetupView): MatrixSetupView => mysql ? { ...value, storeBackend: "mysql" } : value;
  const cleanupSpool = async (): Promise<void> => {
    if (transientSpool === undefined) return;
    const owned = transientSpool;
    const current = await lstat(owned.path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino
      || await realpath(owned.path) !== owned.path) throw new Error("matrix_setup_cleanup_failed");
    // Only the exact mkdtemp-created inode, after the child has fully stopped.
    // This path is temporary media/cache, never durable MySQL or legacy state.
    await rm(owned.path, { recursive: true, force: false });
    transientSpool = undefined;
  };
  const closeProcess = async (): Promise<void> => {
    await process?.close(); process = undefined;
    await cleanupSpool();
  };
  const run = async (action: MatrixSetupAction, fields: MatrixSetupFields, ownerBinding?: string): Promise<MatrixSetupView> => {
    if (!enabled || closed) throw new Error("matrix_setup_disabled");
    if (pin === undefined) throw new Error("matrix_release_unavailable");
    if (mysql && ["complete_preview", "restrict_media_permissions"].includes(action)) {
      throw new Error("matrix_setup_invalid_request");
    }
    if (mysql && action === "prepare") {
      if (process !== undefined) throw new Error("matrix_setup_busy");
      mysqlPrepared = false;
      view = { state: "unprepared" };
      const prepared = await (dependencies.prepareMySql ?? prepareMySqlMatrixRelease)(root, pin);
      if (closed) throw new Error("matrix_setup_disabled");
      if (!prepared.ok) { view = { state: "unprepared", error: prepared.code }; return view; }
      // Preparation proves binaries only. Rust must validate the existing active
      // database, encryption identity and Matrix account when resume starts it.
      mysqlPrepared = true;
      view = { state: "prepared" }; return view;
    }
    if (mysql && (action === "resume" || action === "start_fresh")) {
      if (!mysqlPrepared || process !== undefined) throw new Error("matrix_setup_not_prepared");
      const configuration = parseGoDaddyMatrixConfiguration(environment);
      if (!configuration.ok) throw new Error(configuration.code);
      const inspection = await (dependencies.inspectMySql ?? inspectMySqlMatrixRelease)(root, pin);
      if (closed) throw new Error("matrix_setup_disabled");
      if (!inspection.ok) throw new Error(inspection.code);
      if (configuration.value.storeBackend !== "mysql" || configuration.value.binaryPath !== inspection.value.sidecarPath
        || configuration.value.expectedSha256 !== inspection.value.sidecarSha256) throw new Error("matrix_configuration_invalid");
      await cleanupSpool();
      const temporaryParent = await realpath(tmpdir());
      const path = await mkdtemp(join(temporaryParent, "pc-matrix-setup-"));
      const stat = await lstat(path);
      transientSpool = { path, dev: stat.dev, ino: stat.ino };
      try {
        if (closed) throw new Error("matrix_setup_disabled");
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700
          || await realpath(path) !== path) throw new Error("matrix_setup_unsafe_path");
        process = (dependencies.spawn ?? spawnMatrixSetupProcess)({ binaryPath: inspection.value.setupPath,
          applicationRoot: root, fresh: action === "start_fresh", environment: { ...configuration.value.spawnEnvironment,
            MATRIX_STORE_DIR: path, MATRIX_MEDIA_SPOOL_DIR: path, TMPDIR: temporaryParent } });
      } catch (error) { await cleanupSpool(); throw error; }
      view = { state: "starting", ...(process.expiresAt === undefined ? {} : { expiresAt: process.expiresAt }) }; return view;
    }
    if (action === "restrict_media_permissions") {
      if (process !== undefined || browserPending !== undefined || !["unprepared", "stopped"].includes(view.state)) {
        throw new Error("matrix_setup_busy");
      }
      const diagnostic = view.releaseDiagnostic;
      if (diagnostic?.stage !== "store" || !/^matrix-sdk-media\.sqlite3(?:-wal|-shm)?$/u.test(diagnostic.target)
        || diagnostic.mode !== "644" || !diagnostic.ownerMatches || !diagnostic.file || diagnostic.symlink || diagnostic.links !== 1) {
        throw new Error("matrix_setup_invalid_request");
      }
      isolationConfirmed = false;
      const result = await restrictMatrixMediaPermissions(root, pin);
      view = { state: "unprepared", ...(result.ok ? {} : { error: result.code }) }; return view;
    }
    if (action === "prepare") {
      if (process !== undefined) throw new Error("matrix_setup_busy");
      if (browserPending !== undefined) { browserPending.resolve(undefined); await isolationRun; }
      isolationConfirmed = false;
      view = { state: "unprepared" };
      let releaseDiagnostic: MatrixReleaseDiagnostic | undefined;
      const prepared = await (dependencies.prepare ?? prepareMatrixRelease)(root, pin, {
        observeUnsafePath: value => { releaseDiagnostic = value; }
      });
      if (closed) throw new Error("matrix_setup_disabled");
      if (!prepared.ok) {
        view = { state: "unprepared", error: prepared.code,
          ...(releaseDiagnostic === undefined ? {} : { releaseDiagnostic }) }; return view;
      }
      let announce: (view: MatrixSetupView) => void = () => {};
      const awaitingBrowser = new Promise<MatrixSetupView>(resolve => { announce = resolve; });
      const browserCheck = ownerBinding === undefined ? undefined : (challenge: MatrixBrowserChallenge): Promise<unknown> =>
        new Promise(resolve => {
          if (closed) { resolve(undefined); return; }
          browserPending = { challenge, ownerBinding, resolve };
          view = { state: "awaiting_preview", browserChallenge: challenge };
          announce(view);
        });
      let diagnostics: MatrixIsolationDiagnostics | undefined;
      isolationRun = (dependencies.isolation ?? verifyMatrixHttpIsolation)(root, pin, fetch, {}, browserCheck,
        observation => { diagnostics = observation; })
        .then(isolation => {
          browserPending = undefined;
          if (closed) return view;
          if (!isolation.ok) { view = { state: "unprepared", error: isolation.code,
            ...(diagnostics === undefined ? {} : { isolationDiagnostics: diagnostics }) }; return view; }
          isolationConfirmed = true; isolationExpiresAt = Date.now() + 300_000;
          view = { state: "prepared", ...(isolation.evidenceKind === undefined ? {} : { isolationEvidence: isolation.evidenceKind }),
            ...(isolation.controlVisibility === undefined ? {} : { controlVisibility: isolation.controlVisibility }) };
          return view;
        }).catch(() => { browserPending = undefined; view = { state: "unprepared", error: "matrix_http_isolation_failed" }; return view; });
      return Promise.race([isolationRun, awaitingBrowser]);
    }
    if (action === "complete_preview") {
      if (browserPending === undefined || ownerBinding === undefined || ownerBinding !== browserPending.ownerBinding
        || fields.previewReport === undefined) throw new Error("matrix_setup_invalid_request");
      let report: unknown;
      try { report = JSON.parse(fields.previewReport); } catch { report = undefined; }
      browserPending.resolve(report);
      return await isolationRun!;
    }
    if (action === "stop" && browserPending !== undefined) {
      if (ownerBinding !== browserPending.ownerBinding) throw new Error("matrix_setup_invalid_request");
      browserPending.resolve(undefined); await isolationRun;
      if (view.error === "matrix_http_isolation_cleanup_failed") return view;
      view = { state: "stopped" }; return view;
    }
    if (action === "start_fresh" || action === "resume") {
      if (!isolationConfirmed || Date.now() >= isolationExpiresAt || process !== undefined) throw new Error("matrix_setup_not_prepared");
      const configuration = parseGoDaddyMatrixConfiguration(environment);
      if (!configuration.ok) throw new Error(configuration.code);
      const inspection = await (dependencies.inspect ?? inspectMatrixRelease)(root, pin);
      if (closed) throw new Error("matrix_setup_disabled");
      if (!inspection.ok) throw new Error(inspection.code);
      if (configuration.value.binaryPath !== inspection.value.sidecarPath
        || configuration.value.expectedSha256 !== inspection.value.sidecarSha256
        || configuration.value.storeDir !== inspection.value.storeDir
        || configuration.value.mediaSpoolDir !== inspection.value.mediaSpoolDir) throw new Error("matrix_configuration_invalid");
      if (action === "start_fresh" && inspection.value.storeState !== "empty") throw new Error("matrix_store_not_empty");
      if (action === "resume" && inspection.value.storeState !== "contains_state") throw new Error("matrix_store_missing");
      process = (dependencies.spawn ?? spawnMatrixSetupProcess)({ binaryPath: inspection.value.setupPath,
        applicationRoot: root, fresh: action === "start_fresh" || inspection.value.storeProvisioning === "incomplete",
        environment: configuration.value.spawnEnvironment });
      view = { state: "starting", ...(process.expiresAt === undefined ? {} : { expiresAt: process.expiresAt }) }; return view;
    }
    if (process === undefined) throw new Error("matrix_setup_not_running");
    if (action === "stop") {
      await closeProcess(); isolationConfirmed = false; mysqlPrepared = false;
      view = { state: "stopped" }; return view;
    }
    let command: MatrixSetupCommand;
    if (action === "verify_self" || action === "verify_owner") {
      if (fields.deviceId === undefined) throw new Error("matrix_setup_invalid_request");
      command = { type: action === "verify_self" ? "start_self_verification" : "start_owner_verification", device_id: fields.deviceId };
    } else if (action === "confirm") {
      if (fields.flowId === undefined || fields.comparisonToken === undefined) throw new Error("matrix_setup_invalid_request");
      command = { type: "confirm_sas", flow_id: fields.flowId, comparison_token: fields.comparisonToken };
    } else if (action === "cancel") {
      if (fields.flowId === undefined) throw new Error("matrix_setup_invalid_request");
      command = { type: "cancel_sas", flow_id: fields.flowId };
    } else command = { type: action === "finish" ? "finish" : "status" };
    const status = await process.request(command);
    if (action === "finish") {
      await closeProcess(); isolationConfirmed = false; mysqlPrepared = false;
      view = { state: "complete", status }; return view;
    }
    view = { state: "verifying", status, ...(process.expiresAt === undefined ? {} : { expiresAt: process.expiresAt }) }; return view;
  };
  return Object.freeze({
    view: () => publicView(view),
    async action(action: MatrixSetupAction, fields: MatrixSetupFields, ownerBinding?: string): Promise<MatrixSetupView> {
      if (busy) return publicView({ ...view, error: "matrix_setup_busy" });
      busy = true;
      try { activeAction = run(action, fields, ownerBinding); return publicView(await activeAction); }
      catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (process !== undefined && terminalProcessErrors.has(message)) {
          isolationConfirmed = false; mysqlPrepared = false;
          // Revoke all displayed SAS data before awaiting shutdown; never retain
          // a live-looking confirmation for a dead or expiring process.
          view = { state: "stopping", error: message };
          try {
            await closeProcess();
            view = { state: "stopped", error: message };
          } catch { view = { state: "stopping", error: "matrix_setup_termination_failed" }; }
          return publicView(view);
        }
        if ((message === "stale_comparison" || message === "no_active_verification") && view.status !== undefined) {
          view = { ...view, status: { ...view.status, verification: null } };
        }
        // Only stable content-free codes; never child/library error details.
        const allowed = /^(?:matrix_(?:setup|release|configuration|store)_[a-z_]{1,48}|policy_not_ready|verification_[a-z_]{1,40}|isolation_[a-z_]{1,48})$/u;
        view = { ...view, error: allowed.test(message) || nativeSetupErrors.has(message) || isolationErrors.has(message) ? message : "matrix_setup_failed" };
        return publicView(view);
      } finally { busy = false; activeAction = undefined; }
    },
    async close(): Promise<void> {
      closed = true; isolationConfirmed = false; mysqlPrepared = false;
      // action() owns safe error projection. A shutdown-triggered rejection must
      // not skip the remaining isolation and child cleanup here.
      browserPending?.resolve(undefined); await activeAction?.catch(() => undefined); await isolationRun;
      await closeProcess();
    }
  });
}
