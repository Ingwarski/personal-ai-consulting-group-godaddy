import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { delimiter, resolve, sep } from "node:path";

import { verifyGoDaddyRustProbeArtifact } from "../../scripts/verify-godaddy-rust-probe-artifact.mjs";

const PROBE_DIRECTORY_NAME = "godaddy-rust-matrix-probe-v1";
const ARTIFACT_DIRECTORY = ["vendor", "godaddy-rust-probe", "linux-x64-musl"];
const MAX_OUTPUT_BYTES = 8 * 1024;
const EXECUTION_TIMEOUT_MILLISECONDS = 20_000;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const isProbeResult = (value) => isRecord(value)
  && typeof value.ok === "boolean"
  && value.schema_version === 1
  && value.matrix_sdk_version === "0.18.0"
  && typeof value.store_created === "boolean"
  && typeof value.store_reopened === "boolean"
  && typeof value.wrong_key_rejected === "boolean"
  && typeof value.matrix_https === "boolean"
  && typeof value.survived_restart === "boolean"
  && typeof value.survived_redeploy === "boolean";

const isLockResult = (value) => isRecord(value) && value.ok === true && value.ready === true;

const sanitizedPath = (environment) => typeof environment.PATH === "string" && environment.PATH.length > 0
  ? environment.PATH.split(delimiter).filter((entry) => entry.length > 0).join(delimiter)
  : "/usr/local/bin:/usr/bin:/bin";

const probeRootFor = (workingDirectory) => {
  const assets = resolve(workingDirectory, "public", "assets");
  const root = resolve(assets, PROBE_DIRECTORY_NAME);
  if (!root.startsWith(`${assets}${sep}`)) throw new Error("Invalid probe root.");
  return root;
};

const parseJsonResult = (output) => {
  try {
    const lines = output.trim().split("\n");
    return lines.length === 1 ? JSON.parse(lines[0]) : undefined;
  } catch {
    return undefined;
  }
};

const once = (emitter, event) => new Promise((resolveEvent) => emitter.once(event, resolveEvent));

export function createRustProbeExecutor({ binaryPath, environment = process.env, spawnImpl = spawn }) {
  const execute = async ({ command, root, bootId, deploymentId, timeoutMilliseconds = EXECUTION_TIMEOUT_MILLISECONDS }) => {
    const child = spawnImpl(binaryPath, [command, "--root", root, "--boot-id", bootId, "--deployment-id", deploymentId], {
      cwd: resolve(root, "..", "..", ".."),
      env: { PATH: sanitizedPath(environment) },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"]
    });
    let output = "";
    let overflow = false;
    child.stdout?.on("data", (chunk) => {
      if (overflow) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    let timeout;
    const outcome = await Promise.race([
      once(child, "close").then((code) => ({ code, timedOut: false })),
      once(child, "error").then(() => ({ code: undefined, timedOut: false })),
      new Promise((resolveTimeout) => {
        timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolveTimeout({ code: undefined, timedOut: true });
        }, timeoutMilliseconds);
      })
    ]);
    clearTimeout(timeout);
    // `status` intentionally exits non-zero when an already-held store lock
    // rejects access. Its one-line structured response is the evidence this
    // caller needs, so parse it before judging the process status.
    if (overflow || outcome.timedOut) return undefined;
    return parseJsonResult(output);
  };

  const checkLockContention = async ({ root, bootId, deploymentId }) => {
    const holder = spawnImpl(binaryPath, ["hold-lock", "--root", root, "--boot-id", bootId, "--deployment-id", deploymentId], {
      cwd: resolve(root, "..", "..", ".."),
      env: { PATH: sanitizedPath(environment) },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"]
    });
    let holderOutput = "";
    const ready = new Promise((resolveReady) => {
      const timer = setTimeout(() => resolveReady(false), 3_000);
      holder.stdout?.on("data", (chunk) => {
        holderOutput += chunk.toString("utf8");
        const value = parseJsonResult(holderOutput);
        if (isLockResult(value)) {
          clearTimeout(timer);
          resolveReady(true);
        }
      });
      holder.once("error", () => {
        clearTimeout(timer);
        resolveReady(false);
      });
    });
    const holderReady = await ready;
    try {
      if (!holderReady) return false;
      const rejected = await execute({ command: "status", root, bootId, deploymentId, timeoutMilliseconds: 3_000 });
      return isRecord(rejected) && rejected.ok === false && rejected.code === "store_locked";
    } finally {
      if (!holder.killed) holder.kill("SIGKILL");
      await Promise.race([once(holder, "close"), new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000))]);
    }
  };

  return Object.freeze({ execute, checkLockContention });
}

/**
 * Temporary GoDaddy Published capability gate for a future Rust Matrix sidecar.
 * It accepts no caller input, has no Matrix identity or credential, and owns
 * exactly one synthetic fixed path until DELETE removes it.
 */
export class GoDaddyRustSidecarCapabilityProbe {
  #workingDirectory;
  #root;
  #artifactPath;
  #checksumPath;
  #bootId;
  #deploymentId;
  #verifyArtifact;
  #executor;
  #removeDirectory;
  #operation;

  constructor({
    workingDirectory = process.cwd(),
    environment = process.env,
    bootId = randomUUID(),
    deploymentId = "rust-sidecar-probe-a",
    artifactPath = resolve(workingDirectory, ...ARTIFACT_DIRECTORY, "godaddy-rust-probe"),
    checksumPath = resolve(workingDirectory, ...ARTIFACT_DIRECTORY, "SHA256SUMS"),
    verifyArtifact = verifyGoDaddyRustProbeArtifact,
    executor,
    removeDirectory = rm
  } = {}) {
    this.#workingDirectory = resolve(workingDirectory);
    this.#root = probeRootFor(this.#workingDirectory);
    this.#artifactPath = artifactPath;
    this.#checksumPath = checksumPath;
    this.#bootId = bootId;
    this.#deploymentId = deploymentId;
    this.#verifyArtifact = verifyArtifact;
    this.#executor = executor ?? createRustProbeExecutor({ binaryPath: artifactPath, environment });
    this.#removeDirectory = removeDirectory;
  }

  async start() {
    return this.#runExclusive(async () => {
      if (!await this.#artifactIsValid()) return { ok: false, code: "binary_unavailable" };
      const lockContention = await this.#executor.checkLockContention({
        root: this.#root,
        bootId: this.#bootId,
        deploymentId: this.#deploymentId
      });
      if (!lockContention) return { ok: false, code: "lock_unverified" };
      const result = await this.#executor.execute({
        command: "start",
        root: this.#root,
        bootId: this.#bootId,
        deploymentId: this.#deploymentId
      });
      return isProbeResult(result)
        ? { ok: result.ok, binary_verified: true, lock_contention: true, ...result }
        : { ok: false, code: "probe_execution_failed" };
    });
  }

  async status() {
    return this.#runExclusive(async () => {
      if (!await this.#artifactIsValid()) return { ok: false, code: "binary_unavailable" };
      const result = await this.#executor.execute({
        command: "status",
        root: this.#root,
        bootId: this.#bootId,
        deploymentId: this.#deploymentId
      });
      return isProbeResult(result)
        ? { ok: result.ok, binary_verified: true, ...result }
        : { ok: false, code: "probe_execution_failed" };
    });
  }

  async remove() {
    return this.#runExclusive(async () => {
      if (probeRootFor(this.#workingDirectory) !== this.#root) return { ok: false, code: "invalid_probe_root" };
      try {
        await this.#removeDirectory(this.#root, { recursive: true, force: true });
        return { ok: true, removed: true };
      } catch {
        return { ok: false, code: "cleanup_failed" };
      }
    });
  }

  async #artifactIsValid() {
    return this.#verifyArtifact({ artifactPath: this.#artifactPath, checksumPath: this.#checksumPath });
  }

  async #runExclusive(operation) {
    if (this.#operation !== undefined) return { ok: false, code: "probe_in_progress" };
    this.#operation = operation();
    try {
      return await this.#operation;
    } finally {
      this.#operation = undefined;
    }
  }
}
