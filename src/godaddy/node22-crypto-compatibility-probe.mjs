import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIRECTORY_NAME = ".godaddy-node22-matrix-crypto-compatibility-v1";
const CRYPTO_DIRECTORY_NAME = "crypto";
const MARKER_FILE_NAME = "receipt.json";
const SYNTHETIC_USER_ID = "@godaddy-node22-compatibility:example.invalid";
const SYNTHETIC_DEVICE_ID = "GODADDY_NODE22";
const STORE_PASSPHRASE = createHash("sha256")
  .update("godaddy-node22-matrix-crypto-compatibility-v1")
  .digest("base64url");

const probeDirectory = (parentDirectory) => join(resolve(parentDirectory), DIRECTORY_NAME);

const cryptoStoreExists = async (directory) => {
  try {
    return (await readdir(directory)).includes("matrix-sdk-crypto.sqlite3");
  } catch {
    return false;
  }
};

const safeFailure = (error) => ({
  code: typeof error?.code === "string" ? error.code : undefined,
  message: String(error?.message ?? error ?? "unknown error")
    .replaceAll(process.cwd(), "<application>")
    .replace(/\/[^\n]*?node_modules\//g, "<node_modules>/")
});

/**
 * A temporary, Preview-only check of whether the vendor's current native
 * binding can technically run on GoDaddy Node 22. It has no Matrix account,
 * network request, user data or database access, and deletes only its own
 * fixed directories after the receipt is read.
 */
export class GoDaddyNode22CryptoCompatibilityProbe {
  #directories;
  #loadCrypto;

  constructor({
    workingDirectory = process.cwd(),
    temporaryDirectory = tmpdir(),
    loadCrypto = () => import("@matrix-org/matrix-sdk-crypto-nodejs")
  } = {}) {
    this.#directories = [
      { kind: "app", directory: probeDirectory(workingDirectory) },
      { kind: "tmp", directory: probeDirectory(temporaryDirectory) }
    ];
    this.#loadCrypto = loadCrypto;
  }

  async start() {
    let crypto;
    try {
      crypto = await this.#loadCrypto();
    } catch (error) {
      return {
        ok: true,
        imported: false,
        openedStore: false,
        failure: safeFailure(error)
      };
    }

    const stores = [];
    for (const target of this.#directories) {
      const cryptoDirectory = join(target.directory, CRYPTO_DIRECTORY_NAME);
      let writable = false;
      let cryptoStore = false;
      let failure;
      try {
        await mkdir(cryptoDirectory, { recursive: true, mode: 0o700 });
        await writeFile(join(target.directory, MARKER_FILE_NAME), JSON.stringify({
          version: 1,
          bootId: randomUUID()
        }), { encoding: "utf8", mode: 0o600 });
        writable = true;
        const machine = await crypto.OlmMachine.initialize(
          new crypto.UserId(SYNTHETIC_USER_ID),
          new crypto.DeviceId(SYNTHETIC_DEVICE_ID),
          cryptoDirectory,
          STORE_PASSPHRASE,
          crypto.StoreType.Sqlite
        );
        machine.close();
        cryptoStore = await cryptoStoreExists(cryptoDirectory);
      } catch (error) {
        failure = safeFailure(error);
      }
      stores.push({
        kind: target.kind,
        writable,
        cryptoStore,
        ...(failure === undefined ? {} : { failure })
      });
    }

    return {
      ok: true,
      imported: true,
      openedStore: stores.every((store) => store.cryptoStore),
      stores
    };
  }

  async remove() {
    for (const directory of new Set(this.#directories.map(({ directory }) => directory))) {
      await rm(directory, { recursive: true, force: true });
    }
    return { ok: true, removed: true };
  }
}
