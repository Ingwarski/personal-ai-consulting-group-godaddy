import { createHash } from "node:crypto";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MATRIX_RELEASE_SIDECAR_SHA256 } from "./matrix-release-pin.ts";

export const GODADDY_MATRIX_SIDECAR_BUILD = "0.1.0";
export const GODADDY_MATRIX_PROTOCOL_VERSION = 1;
export const GODADDY_MATRIX_HOMESERVER_ORIGIN = "https://matrix.org";

const MATRIX_ENVIRONMENT_NAMES = Object.freeze([
  "MATRIX_SIDECAR_PATH",
  "MATRIX_SIDECAR_SHA256",
  "MATRIX_PROTOCOL_VERSION",
  "MATRIX_STORE_DIR",
  "MATRIX_STORE_PASSPHRASE",
  "MATRIX_MEDIA_SPOOL_DIR",
  "MATRIX_HOMESERVER_URL",
  "MATRIX_ALLOWED_HTTPS_ORIGINS",
  "MATRIX_BOT_MXID",
  "MATRIX_BOT_DEVICE_ID",
  "MATRIX_ACCESS_TOKEN",
  "MATRIX_ROOM_ID",
  "MATRIX_OWNER_MXID"
] as const);

const APPLICATION_SOURCE_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MATRIX_PERSISTENT_ROOT = resolve(
  APPLICATION_SOURCE_ROOT,
  "public",
  "assets",
  ".personal-consultant-matrix-v1"
);
const MATRIX_STORE_ROOT = resolve(MATRIX_PERSISTENT_ROOT, "crypto-store");
const MATRIX_MEDIA_SPOOL_ROOT = resolve(MATRIX_PERSISTENT_ROOT, "media-spool");
const MATRIX_MYSQL_SIDECAR_PATH = join(
  APPLICATION_SOURCE_ROOT,
  "runtime",
  "matrix",
  "personal-consultant-matrix-sidecar"
);

export type GoDaddyMatrixExecutableBinding = Readonly<{
  binaryPath: string;
  expectedSha256: string;
}>;

const DEFAULT_MYSQL_EXECUTABLE_BINDING: GoDaddyMatrixExecutableBinding = Object.freeze({
  binaryPath: MATRIX_MYSQL_SIDECAR_PATH,
  expectedSha256: MATRIX_RELEASE_SIDECAR_SHA256
});

type MatrixEnvironmentName = typeof MATRIX_ENVIRONMENT_NAMES[number];

export type GoDaddyMatrixConfiguration = Readonly<{
  storeBackend?: "sqlite" | "mysql";
  applicationRoot: string;
  binaryPath: string;
  expectedSha256: string;
  protocolVersion: 1;
  expectedBuild: string;
  storeDir: string;
  mediaSpoolDir: string;
  homeserverOrigin: "https://matrix.org";
  roomId: string;
  ownerMxid: string;
  botMxid: string;
  botDeviceId: string;
  expectedIdentityHashes: Readonly<{
    roomIdSha256: string;
    ownerMxidSha256: string;
    botMxidSha256: string;
    botDeviceIdSha256: string;
  }>;
  spawnEnvironment: Readonly<Record<string, string>>;
}>;

export type GoDaddyMatrixConfigurationResult =
  | Readonly<{ ok: true; value: GoDaddyMatrixConfiguration }>
  | Readonly<{
      ok: false;
      code:
        | "matrix_disabled_for_runtime"
        | "matrix_state_database_not_enabled"
        | "matrix_not_configured"
        | "matrix_configuration_incomplete"
        | "matrix_configuration_invalid";
    }>;

const asString = (value: unknown, maximumBytes: number): string | undefined =>
  typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maximumBytes
    ? value
    : undefined;

const sha256Utf8 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function exactAbsolutePath(value: string): string | undefined {
  if (!isAbsolute(value) || resolve(value) !== value) return undefined;
  return value;
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

function matrixOrgMxid(value: string): boolean {
  return /^@[A-Za-z0-9._=+\-/]+:matrix\.org$/u.test(value) && Buffer.byteLength(value, "utf8") <= 255;
}

function matrixOrgRoomId(value: string): boolean {
  return /^![^:\s]{1,220}:matrix\.org$/u.test(value) && Buffer.byteLength(value, "utf8") <= 255;
}

function printableDeviceId(value: string): boolean {
  return /^[\x21-\x7e]{1,255}$/u.test(value);
}

function suppliedMatrixNames(environment: Record<string, unknown>): number {
  return MATRIX_ENVIRONMENT_NAMES.reduce((count, name) => count + (Object.hasOwn(environment, name) ? 1 : 0), 0);
}

/**
 * Parses only the immutable Published Matrix binding. Development/Preview can
 * never inherit production state merely because provider secrets are present.
 * Secret values stay in the child-only environment and are never included in
 * readiness or validation errors.
 */
export function parseGoDaddyMatrixConfiguration(
  environment: Record<string, unknown>,
  mysqlExecutableBinding: GoDaddyMatrixExecutableBinding = DEFAULT_MYSQL_EXECUTABLE_BINDING
): GoDaddyMatrixConfigurationResult {
  if (environment.RUNTIME_MODE !== "production") return { ok: false, code: "matrix_disabled_for_runtime" };
  if (environment.GODADDY_STATE_DATABASE_ROLE !== "published") {
    return { ok: false, code: "matrix_state_database_not_enabled" };
  }
  const mysql = environment.MATRIX_STORE_BACKEND === "mysql";
  if (environment.MATRIX_STORE_BACKEND !== undefined && !["mysql", "sqlite"].includes(String(environment.MATRIX_STORE_BACKEND))) {
    return { ok: false, code: "matrix_configuration_invalid" };
  }
  const names = mysql ? MATRIX_ENVIRONMENT_NAMES.filter((name) => ![
    "MATRIX_SIDECAR_PATH", "MATRIX_SIDECAR_SHA256", "MATRIX_STORE_DIR", "MATRIX_MEDIA_SPOOL_DIR"
  ].includes(name)) : MATRIX_ENVIRONMENT_NAMES;
  const supplied = names.filter((name) => Object.hasOwn(environment, name)).length;
  if (supplied === 0) return { ok: false, code: "matrix_not_configured" };
  if (supplied !== names.length) {
    return { ok: false, code: "matrix_configuration_incomplete" };
  }

  const values = Object.fromEntries(names.map((name) => [name, asString(environment[name], 8_192)])) as
    Record<MatrixEnvironmentName, string | undefined>;
  if (Object.values(values).some((value) => value === undefined)) {
    return { ok: false, code: "matrix_configuration_invalid" };
  }

  const binaryPath = mysql
    ? exactAbsolutePath(mysqlExecutableBinding.binaryPath)
    : exactAbsolutePath(values.MATRIX_SIDECAR_PATH as string);
  // Legacy paths are never opened in MySQL mode. The actual shared private
  // spool is created per boot by the service, not taken from a public folder.
  const storeDir = mysql ? MATRIX_STORE_ROOT : exactAbsolutePath(values.MATRIX_STORE_DIR as string);
  const mediaSpoolDir = mysql ? MATRIX_MEDIA_SPOOL_ROOT : exactAbsolutePath(values.MATRIX_MEDIA_SPOOL_DIR as string);
  const expectedSha256 = mysql
    ? mysqlExecutableBinding.expectedSha256
    : values.MATRIX_SIDECAR_SHA256 as string;
  const roomId = values.MATRIX_ROOM_ID as string;
  const ownerMxid = values.MATRIX_OWNER_MXID as string;
  const botMxid = values.MATRIX_BOT_MXID as string;
  const botDeviceId = values.MATRIX_BOT_DEVICE_ID as string;
  const storePassphrase = values.MATRIX_STORE_PASSPHRASE as string;
  const accessToken = values.MATRIX_ACCESS_TOKEN as string;
  if (
    binaryPath === undefined || storeDir === undefined || mediaSpoolDir === undefined ||
    overlaps(storeDir, mediaSpoolDir) || overlaps(binaryPath, storeDir) || overlaps(binaryPath, mediaSpoolDir) ||
    storeDir !== MATRIX_STORE_ROOT || mediaSpoolDir !== MATRIX_MEDIA_SPOOL_ROOT ||
    !/^[a-f0-9]{64}$/u.test(expectedSha256) ||
    values.MATRIX_PROTOCOL_VERSION !== String(GODADDY_MATRIX_PROTOCOL_VERSION) ||
    values.MATRIX_HOMESERVER_URL !== GODADDY_MATRIX_HOMESERVER_ORIGIN ||
    values.MATRIX_ALLOWED_HTTPS_ORIGINS !== GODADDY_MATRIX_HOMESERVER_ORIGIN ||
    !matrixOrgRoomId(roomId) || !matrixOrgMxid(ownerMxid) || !matrixOrgMxid(botMxid) || ownerMxid === botMxid ||
    !printableDeviceId(botDeviceId) || !/^[a-f0-9]{64}$/u.test(storePassphrase) ||
    Buffer.byteLength(accessToken, "utf8") > 4_096
  ) {
    return { ok: false, code: "matrix_configuration_invalid" };
  }

  const pathValue = asString(environment.PATH, 8_192) ?? "/usr/local/bin:/usr/bin:/bin";
  const databaseEnvironment: Record<string, string> = {};
  if (mysql) {
    for (const name of ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
      const value = asString(environment[name], 8_192);
      if (value === undefined) return { ok: false, code: "matrix_configuration_incomplete" };
      databaseEnvironment[name] = value;
    }
    const port = Number(databaseEnvironment.DB_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== databaseEnvironment.DB_PORT) return { ok: false, code: "matrix_configuration_invalid" };
    if (environment.DB_SSL_CA_FILE !== undefined) {
      const ca = asString(environment.DB_SSL_CA_FILE, 8_192);
      if (ca === undefined || exactAbsolutePath(ca) === undefined) return { ok: false, code: "matrix_configuration_invalid" };
      databaseEnvironment.DB_SSL_CA_FILE = ca;
    }
  }
  const spawnEnvironment = Object.freeze({
    ...databaseEnvironment,
    ...(mysql ? { MATRIX_STORE_BACKEND: "mysql", MATRIX_DEPLOYMENT_GENERATION: expectedSha256 } : {}),
    PATH: pathValue,
    MATRIX_HOMESERVER_URL: GODADDY_MATRIX_HOMESERVER_ORIGIN,
    MATRIX_ALLOWED_HTTPS_ORIGINS: GODADDY_MATRIX_HOMESERVER_ORIGIN,
    MATRIX_STORE_DIR: storeDir,
    MATRIX_STORE_PASSPHRASE: storePassphrase,
    MATRIX_MEDIA_SPOOL_DIR: mediaSpoolDir,
    MATRIX_ACCESS_TOKEN: accessToken,
    MATRIX_ROOM_ID: roomId,
    MATRIX_OWNER_MXID: ownerMxid,
    MATRIX_BOT_MXID: botMxid,
    MATRIX_BOT_DEVICE_ID: botDeviceId
  });

  return {
    ok: true,
    value: Object.freeze({
      storeBackend: mysql ? "mysql" : "sqlite",
      applicationRoot: APPLICATION_SOURCE_ROOT,
      binaryPath,
      expectedSha256,
      protocolVersion: GODADDY_MATRIX_PROTOCOL_VERSION,
      expectedBuild: GODADDY_MATRIX_SIDECAR_BUILD,
      storeDir,
      mediaSpoolDir,
      homeserverOrigin: GODADDY_MATRIX_HOMESERVER_ORIGIN,
      roomId,
      ownerMxid,
      botMxid,
      botDeviceId,
      expectedIdentityHashes: Object.freeze({
        roomIdSha256: sha256Utf8(roomId),
        ownerMxidSha256: sha256Utf8(ownerMxid),
        botMxidSha256: sha256Utf8(botMxid),
        botDeviceIdSha256: sha256Utf8(botDeviceId)
      }),
      spawnEnvironment
    })
  };
}

export const godaddyMatrixEnvironmentNames = (): readonly string[] => MATRIX_ENVIRONMENT_NAMES;
