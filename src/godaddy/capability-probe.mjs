import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const PROBE_DIRECTORY_NAME = ".godaddy-matrix-e2ee-capability-probe-v1";
const MARKER_FILE_NAME = "receipt.json";
const CRYPTO_DIRECTORY_NAME = "crypto";
const MATRIX_VERSIONS_URL = "https://matrix.org/_matrix/client/versions";
const SYNTHETIC_USER_ID = "@godaddy-capability-probe:example.invalid";
const SYNTHETIC_DEVICE_ID = "GODADDY_PROBE";
const STORE_PASSPHRASE = createHash("sha256")
  .update("godaddy-node22-matrix-e2ee-capability-probe-v1")
  .digest("base64url");

const safeDirectoryName = (kind, parentDirectory) =>
  join(resolve(parentDirectory), PROBE_DIRECTORY_NAME, kind);

const now = () => new Date().toISOString();

const runChildProcess = (spawnImpl) => new Promise((resolveChild) => {
  let output = "";
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    resolveChild(value);
  };

  try {
    const child = spawnImpl(process.execPath, ["-e", "process.stdout.write('ok')"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0 && output === "ok"));
  } catch {
    finish(false);
  }
});

const checkMatrixEgress = async (fetchImpl) => {
  try {
    const response = await fetchImpl(MATRIX_VERSIONS_URL, { signal: AbortSignal.timeout(10_000) });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
};

const cryptoStoreIsPresent = async (directory) => {
  try {
    const files = await readdir(directory);
    return files.includes("matrix-sdk-crypto.sqlite3");
  } catch {
    return false;
  }
};

const loadMarker = async (path) => {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      value === null ||
      typeof value !== "object" ||
      value.version !== 1 ||
      typeof value.writerBootId !== "string"
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
};

/**
 * This route exists only for a one-time, content-free GoDaddy Preview
 * capability check. It has no Matrix credential, no real Matrix identity,
 * no database access and no user-controlled input. The caller must remove the
 * route and its two fixed directories after the verification receipt is read.
 */
export class GoDaddyMatrixCapabilityProbe {
  #bootId = randomUUID();
  #directories;
  #fetch;
  #spawn;
  #loadCrypto;
  #operation;

  constructor({
    workingDirectory = process.cwd(),
    temporaryDirectory = tmpdir(),
    fetchImpl = fetch,
    spawnImpl = spawn,
    loadCrypto = () => import("@matrix-org/matrix-sdk-crypto-nodejs")
  } = {}) {
    this.#directories = [
      { kind: "app", directory: safeDirectoryName("app", workingDirectory) },
      { kind: "tmp", directory: safeDirectoryName("tmp", temporaryDirectory) }
    ];
    this.#fetch = fetchImpl;
    this.#spawn = spawnImpl;
    this.#loadCrypto = loadCrypto;
  }

  async start() {
    if (this.#operation !== undefined) return { ok: false, code: "probe_in_progress" };
    this.#operation = this.#start();
    try {
      return await this.#operation;
    } finally {
      this.#operation = undefined;
    }
  }

  async #start() {
    let crypto;
    try {
      crypto = await this.#loadCrypto();
    } catch {
      return {
        ok: true,
        nativeCrypto: false,
        childProcess: await runChildProcess(this.#spawn),
        matrixHttps: await checkMatrixEgress(this.#fetch),
        stores: this.#directories.map(({ kind }) => ({ kind, writable: false, cryptoStore: false }))
      };
    }

    const stores = [];
    for (const target of this.#directories) {
      const cryptoDirectory = join(target.directory, CRYPTO_DIRECTORY_NAME);
      const markerPath = join(target.directory, MARKER_FILE_NAME);
      let writable = false;
      let cryptoStore = false;
      try {
        await mkdir(cryptoDirectory, { recursive: true, mode: 0o700 });
        await writeFile(markerPath, JSON.stringify({ version: 1, writerBootId: this.#bootId, createdAt: now() }), {
          encoding: "utf8",
          mode: 0o600
        });
        writable = true;
        const machine = await crypto.OlmMachine.initialize(
          new crypto.UserId(SYNTHETIC_USER_ID),
          new crypto.DeviceId(SYNTHETIC_DEVICE_ID),
          cryptoDirectory,
          STORE_PASSPHRASE,
          crypto.StoreType.Sqlite
        );
        machine.close();
        cryptoStore = await cryptoStoreIsPresent(cryptoDirectory);
      } catch {
        // The route reports only a Boolean capability result, never filesystem errors.
      }
      stores.push({ kind: target.kind, writable, cryptoStore });
    }

    return {
      ok: true,
      nativeCrypto: true,
      childProcess: await runChildProcess(this.#spawn),
      matrixHttps: await checkMatrixEgress(this.#fetch),
      stores
    };
  }

  async status() {
    let crypto;
    try {
      crypto = await this.#loadCrypto();
    } catch {
      return { ok: true, nativeCrypto: false, stores: this.#directories.map(({ kind }) => ({ kind, survivedRestart: false, cryptoStoreReopened: false })) };
    }

    const stores = [];
    for (const target of this.#directories) {
      const marker = await loadMarker(join(target.directory, MARKER_FILE_NAME));
      const cryptoDirectory = join(target.directory, CRYPTO_DIRECTORY_NAME);
      const survivedRestart = marker !== undefined && marker.writerBootId !== this.#bootId;
      let cryptoStoreReopened = false;
      if (marker !== undefined && await cryptoStoreIsPresent(cryptoDirectory)) {
        try {
          const machine = await crypto.OlmMachine.initialize(
            new crypto.UserId(SYNTHETIC_USER_ID),
            new crypto.DeviceId(SYNTHETIC_DEVICE_ID),
            cryptoDirectory,
            STORE_PASSPHRASE,
            crypto.StoreType.Sqlite
          );
          machine.close();
          cryptoStoreReopened = true;
        } catch {
          cryptoStoreReopened = false;
        }
      }
      stores.push({ kind: target.kind, survivedRestart, cryptoStoreReopened });
    }
    return { ok: true, nativeCrypto: true, stores };
  }

  async remove() {
    const uniqueDirectories = new Set(this.#directories.map(({ directory }) => directory));
    for (const directory of uniqueDirectories) {
      await rm(directory, { recursive: true, force: true });
    }
    return { ok: true, removed: true };
  }

  async directoryExists(kind) {
    const target = this.#directories.find((candidate) => candidate.kind === kind);
    if (target === undefined) return false;
    try {
      await stat(target.directory);
      return true;
    } catch {
      return false;
    }
  }
}
