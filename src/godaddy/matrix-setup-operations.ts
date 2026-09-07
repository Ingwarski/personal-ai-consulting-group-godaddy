import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseGoDaddyMatrixConfiguration } from "./matrix-service-config.ts";
import { inspectMatrixRelease, prepareMatrixRelease, verifyMatrixHttpIsolation,
  type MatrixReleaseExpectation, type MatrixIsolationDiagnostics } from "./matrix-release-install.ts";
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
  "verification_already_active", "verification_peer_changed"]);
const isolationErrors = new Set(["matrix_http_isolation_failed", "matrix_http_isolation_cleanup_failed"]);
export const matrixSetupEnabled = (environment: Record<string, unknown>): boolean =>
  environment.RUNTIME_MODE === "production" && environment.GODADDY_STATE_DATABASE_ROLE === "published"
  && environment.MATRIX_SETUP_MODE === "provision";

export function createMatrixSetupOperations(environment: Record<string, unknown>, dependencies: Readonly<{
  releasePin?: MatrixReleaseExpectation;
  applicationRoot?: string;
  prepare?: typeof prepareMatrixRelease;
  inspect?: typeof inspectMatrixRelease;
  isolation?: typeof verifyMatrixHttpIsolation;
  spawn?: typeof spawnMatrixSetupProcess;
}> = {}): MatrixSetupOperations {
  const enabled = matrixSetupEnabled(environment);
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
  const run = async (action: MatrixSetupAction, fields: MatrixSetupFields, ownerBinding?: string): Promise<MatrixSetupView> => {
    if (!enabled || closed) throw new Error("matrix_setup_disabled");
    if (pin === undefined) throw new Error("matrix_release_unavailable");
    if (action === "prepare") {
      if (process !== undefined) throw new Error("matrix_setup_busy");
      if (browserPending !== undefined) { browserPending.resolve(undefined); await isolationRun; }
      isolationConfirmed = false;
      view = { state: "unprepared" };
      const prepared = await (dependencies.prepare ?? prepareMatrixRelease)(root, pin);
      if (closed) throw new Error("matrix_setup_disabled");
      if (!prepared.ok) throw new Error(prepared.code);
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
      view = { state: "starting" }; return view;
    }
    if (process === undefined) throw new Error("matrix_setup_not_running");
    if (action === "stop") {
      await process.close(); process = undefined; isolationConfirmed = false;
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
      await process.close(); process = undefined; isolationConfirmed = false;
      view = { state: "complete", status }; return view;
    }
    view = { state: "verifying", status }; return view;
  };
  return Object.freeze({
    view: () => view,
    async action(action: MatrixSetupAction, fields: MatrixSetupFields, ownerBinding?: string): Promise<MatrixSetupView> {
      if (busy) return { ...view, error: "matrix_setup_busy" };
      busy = true;
      try { activeAction = run(action, fields, ownerBinding); return await activeAction; }
      catch (error) {
        const message = error instanceof Error ? error.message : "";
        // Only stable content-free codes; never child/library error details.
        const allowed = /^(?:matrix_(?:setup|release|configuration|store)_[a-z_]{1,48}|policy_not_ready|verification_[a-z_]{1,40}|isolation_[a-z_]{1,48})$/u;
        view = { ...view, error: allowed.test(message) || nativeSetupErrors.has(message) || isolationErrors.has(message) ? message : "matrix_setup_failed" };
        return view;
      } finally { busy = false; activeAction = undefined; }
    },
    async close(): Promise<void> {
      closed = true; isolationConfirmed = false;
      // action() owns safe error projection. A shutdown-triggered rejection must
      // not skip the remaining isolation and child cleanup here.
      browserPending?.resolve(undefined); await activeAction?.catch(() => undefined); await isolationRun;
      await process?.close(); process = undefined;
    }
  });
}
