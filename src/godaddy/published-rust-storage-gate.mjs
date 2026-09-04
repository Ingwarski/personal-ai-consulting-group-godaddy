import { GoDaddyRustSidecarCapabilityProbe } from "./rust-sidecar-capability-probe.mjs";

export const PUBLISHED_RUST_STORAGE_GATE_LOG_PREFIX = "G00_PUBLISHED_RUST_STORAGE_GATE";

/**
 * This marker is intentionally committed rather than supplied as a secret.
 * Change deploymentId for the redeploy pass, then change operation to
 * "cleanup" for the final exact-directory removal pass.
 */
export const PUBLISHED_RUST_STORAGE_GATE_CONFIGURATION = Object.freeze({
  operation: "verify",
  deploymentId: "published-g00-b"
});

const isPublishedRuntime = (environment) => environment.RUNTIME_MODE === "production"
  && environment.GODADDY_STATE_DATABASE_ROLE === "published";

const verificationReceipt = (result, deploymentId) => {
  const binaryVerified = result?.binary_verified === true;
  const lockContention = result?.lock_contention === true;
  const matrixSdkVersion = result?.matrix_sdk_version === "0.18.0" ? result.matrix_sdk_version : "unverified";
  const storeReopened = result?.store_reopened === true;
  const wrongKeyRejected = result?.wrong_key_rejected === true;
  const matrixHttps = result?.matrix_https === true;
  return {
    schema_version: 1,
    phase: "verify",
    deployment_id: deploymentId,
    ok: result?.ok === true
      && binaryVerified
      && lockContention
      && matrixSdkVersion === "0.18.0"
      && storeReopened
      && wrongKeyRejected
      && matrixHttps,
    binary_verified: binaryVerified,
    lock_contention: lockContention,
    matrix_sdk_version: matrixSdkVersion,
    store_created: result?.store_created === true,
    store_reopened: storeReopened,
    wrong_key_rejected: wrongKeyRejected,
    matrix_https: matrixHttps,
    survived_restart: result?.survived_restart === true,
    survived_redeploy: result?.survived_redeploy === true,
    code: typeof result?.code === "string" ? result.code : undefined
  };
};

const cleanupReceipt = (result, deploymentId) => ({
  schema_version: 1,
  phase: "cleanup",
  deployment_id: deploymentId,
  ok: result?.ok === true && result?.removed === true,
  removed: result?.removed === true,
  code: typeof result?.code === "string" ? result.code : undefined
});

const failureReceipt = (phase, deploymentId) => ({
  schema_version: 1,
  phase,
  deployment_id: deploymentId,
  ok: false,
  code: "gate_execution_failed"
});

/**
 * Runs only in the exact Published role. It has no HTTP route, accepts no
 * caller data, has no Matrix identity, and does not import or call MySQL.
 */
export async function runPublishedRustStorageGate({
  environment = process.env,
  configuration = PUBLISHED_RUST_STORAGE_GATE_CONFIGURATION,
  probe,
  log = console.log
} = {}) {
  if (!isPublishedRuntime(environment)) {
    return { schema_version: 1, phase: "skipped", ok: true, code: "not_published_runtime" };
  }

  const operation = configuration?.operation;
  const deploymentId = configuration?.deploymentId;
  if (!new Set(["verify", "cleanup"]).has(operation)
    || typeof deploymentId !== "string"
    || !/^[a-z0-9_-]{1,96}$/u.test(deploymentId)) {
    const receipt = failureReceipt("configuration", "invalid");
    log(`${PUBLISHED_RUST_STORAGE_GATE_LOG_PREFIX} ${JSON.stringify(receipt)}`);
    return receipt;
  }

  const capabilityProbe = probe ?? new GoDaddyRustSidecarCapabilityProbe({
    environment,
    deploymentId
  });

  let receipt;
  try {
    receipt = operation === "cleanup"
      ? cleanupReceipt(await capabilityProbe.remove(), deploymentId)
      : verificationReceipt(await capabilityProbe.start(), deploymentId);
  } catch {
    receipt = failureReceipt(operation, deploymentId);
  }

  log(`${PUBLISHED_RUST_STORAGE_GATE_LOG_PREFIX} ${JSON.stringify(receipt)}`);
  return receipt;
}
