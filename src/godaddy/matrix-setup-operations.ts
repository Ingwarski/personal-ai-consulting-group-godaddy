import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseGoDaddyMatrixConfiguration } from "./matrix-service-config.ts";
import { inspectMatrixRelease, prepareMatrixRelease, verifyMatrixHttpIsolation,
  type MatrixReleaseExpectation } from "./matrix-release-install.ts";
import { MATRIX_RELEASE_PIN } from "./matrix-release-pin.ts";
import { spawnMatrixSetupProcess, type MatrixSetupProcess, type MatrixSetupCommand } from "./matrix-setup-process.ts";
import type { MatrixSetupAction, MatrixSetupView } from "./matrix-setup-page.ts";

export type MatrixSetupFields = Readonly<{ deviceId?: string; flowId?: string; comparisonToken?: string }>;
export type MatrixSetupOperations = Readonly<{
  view: () => MatrixSetupView;
  action: (action: MatrixSetupAction, fields: MatrixSetupFields) => Promise<MatrixSetupView>;
  close: () => Promise<void>;
}>;
const nativeSetupErrors = new Set(["configuration_invalid", "input_unavailable", "invalid_options", "invalid_request",
  "invalid_verification_target", "no_active_verification", "operation_timed_out", "output_unavailable", "peer_not_cross_signed",
  "policy_not_ready", "self_verification_required", "setup_expired", "stale_comparison", "store_locked",
  "store_or_device_quarantined", "too_many_devices", "transport_or_store_unavailable", "transport_unavailable",
  "verification_already_active", "verification_peer_changed"]);
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
  const run = async (action: MatrixSetupAction, fields: MatrixSetupFields): Promise<MatrixSetupView> => {
    if (!enabled || closed) throw new Error("matrix_setup_disabled");
    if (pin === undefined) throw new Error("matrix_release_unavailable");
    if (action === "prepare") {
      if (process !== undefined) throw new Error("matrix_setup_busy");
      isolationConfirmed = false;
      const prepared = await (dependencies.prepare ?? prepareMatrixRelease)(root, pin);
      if (!prepared.ok) throw new Error(prepared.code);
      const isolation = await (dependencies.isolation ?? verifyMatrixHttpIsolation)(root, pin);
      if (!isolation.ok) throw new Error(isolation.code);
      isolationConfirmed = true;
      view = { state: "prepared" }; return view;
    }
    if (action === "start_fresh" || action === "resume") {
      if (!isolationConfirmed || process !== undefined) throw new Error("matrix_setup_not_prepared");
      const configuration = parseGoDaddyMatrixConfiguration(environment);
      if (!configuration.ok) throw new Error(configuration.code);
      const inspection = await (dependencies.inspect ?? inspectMatrixRelease)(root, pin);
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
    async action(action: MatrixSetupAction, fields: MatrixSetupFields): Promise<MatrixSetupView> {
      if (busy) return { ...view, error: "matrix_setup_busy" };
      busy = true;
      try { return await run(action, fields); }
      catch (error) {
        const message = error instanceof Error ? error.message : "";
        // Only stable content-free codes; never child/library error details.
        const allowed = /^(?:matrix_(?:setup|release|configuration|store)_[a-z_]{1,48}|policy_not_ready|verification_[a-z_]{1,40}|isolation_[a-z_]{1,48})$/u;
        view = { ...view, error: allowed.test(message) || nativeSetupErrors.has(message) ? message : "matrix_setup_failed" };
        return view;
      } finally { busy = false; }
    },
    async close(): Promise<void> {
      closed = true; isolationConfirmed = false;
      await process?.close(); process = undefined;
    }
  });
}
