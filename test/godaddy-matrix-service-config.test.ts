import assert from "node:assert/strict";
import test from "node:test";

import {
  godaddyMatrixEnvironmentNames,
  parseGoDaddyMatrixConfiguration
} from "../src/godaddy/matrix-service-config.ts";
import { MATRIX_RELEASE_SIDECAR_SHA256 } from "../src/godaddy/matrix-release-pin.ts";

const matrixPersistentRoot = `${process.cwd()}/public/assets/.personal-consultant-matrix-v1`;

const configured = Object.freeze({
  RUNTIME_MODE: "production",
  GODADDY_STATE_DATABASE_ROLE: "published",
  MATRIX_SIDECAR_PATH: "/srv/personal-consultant/bin/matrix-sidecar",
  MATRIX_SIDECAR_SHA256: "a".repeat(64),
  MATRIX_PROTOCOL_VERSION: "1",
  MATRIX_STORE_DIR: `${matrixPersistentRoot}/crypto-store`,
  MATRIX_STORE_PASSPHRASE: "b".repeat(64),
  MATRIX_MEDIA_SPOOL_DIR: `${matrixPersistentRoot}/media-spool`,
  MATRIX_HOMESERVER_URL: "https://matrix.org",
  MATRIX_ALLOWED_HTTPS_ORIGINS: "https://matrix.org",
  MATRIX_BOT_MXID: "@consultant-bot:matrix.org",
  MATRIX_BOT_DEVICE_ID: "BOT_DEVICE_1",
  MATRIX_ACCESS_TOKEN: "test-only-access-token",
  MATRIX_ROOM_ID: "!private-room:matrix.org",
  MATRIX_OWNER_MXID: "@owner:matrix.org",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  DB_PASSWORD: "must-never-enter-the-child",
  SETTINGS_OWNER_PASSWORD: "must-never-enter-the-child-either"
});

test("accepts one exact Published matrix.org binding and creates a child-only environment", () => {
  const result = parseGoDaddyMatrixConfiguration(configured);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.protocolVersion, 1);
  assert.equal(result.value.expectedBuild, "0.1.0");
  assert.match(result.value.applicationRoot, /^\//u);
  assert.match(result.value.expectedIdentityHashes.roomIdSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(result.value.spawnEnvironment).sort(), [
    "MATRIX_ACCESS_TOKEN",
    "MATRIX_ALLOWED_HTTPS_ORIGINS",
    "MATRIX_BOT_DEVICE_ID",
    "MATRIX_BOT_MXID",
    "MATRIX_HOMESERVER_URL",
    "MATRIX_MEDIA_SPOOL_DIR",
    "MATRIX_OWNER_MXID",
    "MATRIX_ROOM_ID",
    "MATRIX_STORE_DIR",
    "MATRIX_STORE_PASSPHRASE",
    "PATH"
  ]);
  assert.equal(Object.hasOwn(result.value.spawnEnvironment, "DB_PASSWORD"), false);
  assert.equal(Object.hasOwn(result.value.spawnEnvironment, "SETTINGS_OWNER_PASSWORD"), false);
});

test("Preview and test runtimes stay stateless even if production credentials were copied into them", () => {
  for (const runtimeMode of ["development", "test"]) {
    assert.deepEqual(parseGoDaddyMatrixConfiguration({ ...configured, RUNTIME_MODE: runtimeMode }), {
      ok: false,
      code: "matrix_disabled_for_runtime"
    });
  }
});

const mysqlConfiguration = Object.freeze({
  ...configured,
  MATRIX_STORE_BACKEND: "mysql",
  DB_HOST: "database.example.test",
  DB_PORT: "3306",
  DB_NAME: "synthetic_matrix",
  DB_USER: "synthetic_matrix_user",
  DB_PASSWORD: "synthetic-mysql-child-secret",
  DB_SSL_CA_FILE: "/srv/test-fixture/mysql-ca.pem"
});

test("MySQL mode explicitly passes only selected DB credentials to its child and needs no legacy folders", () => {
  const environment: Record<string, unknown> = { ...mysqlConfiguration,
    DATABASE_URL: "must-not-inherit", GOOGLE_CLIENT_SECRET: "must-not-inherit", DB_SSL_REJECT_UNAUTHORIZED: "false" };
  delete environment.MATRIX_SIDECAR_PATH;
  delete environment.MATRIX_SIDECAR_SHA256;
  delete environment.MATRIX_STORE_DIR;
  delete environment.MATRIX_MEDIA_SPOOL_DIR;
  const result = parseGoDaddyMatrixConfiguration(environment);
  assert.ok(result.ok);
  assert.equal(result.value.storeBackend, "mysql");
  assert.equal(result.value.binaryPath, `${process.cwd()}/runtime/matrix/personal-consultant-matrix-sidecar`);
  assert.equal(result.value.expectedSha256, MATRIX_RELEASE_SIDECAR_SHA256);
  for (const field of ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DB_SSL_CA_FILE"] as const) {
    assert.equal(result.value.spawnEnvironment[field], mysqlConfiguration[field]);
  }
  assert.equal(result.value.spawnEnvironment.MATRIX_STORE_BACKEND, "mysql");
  assert.equal(result.value.spawnEnvironment.MATRIX_DEPLOYMENT_GENERATION, MATRIX_RELEASE_SIDECAR_SHA256);
  for (const field of ["SETTINGS_OWNER_PASSWORD", "GOOGLE_CLIENT_SECRET", "DATABASE_URL", "DB_SSL_REJECT_UNAUTHORIZED"]) {
    assert.equal(Object.hasOwn(result.value.spawnEnvironment, field), false);
  }
});

test("MySQL executable identity comes from the verified release, not stale deployment values", () => {
  const result = parseGoDaddyMatrixConfiguration({
    ...mysqlConfiguration,
    MATRIX_SIDECAR_PATH: "/obsolete/runtime/matrix-sidecar",
    MATRIX_SIDECAR_SHA256: "f".repeat(64)
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.binaryPath, `${process.cwd()}/runtime/matrix/personal-consultant-matrix-sidecar`);
  assert.equal(result.value.expectedSha256, MATRIX_RELEASE_SIDECAR_SHA256);
});

test("MySQL child cannot start with partial DB settings, implicit port or disabled TLS hints", () => {
  for (const field of ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
    const environment: Record<string, unknown> = { ...mysqlConfiguration };
    delete environment[field];
    assert.deepEqual(parseGoDaddyMatrixConfiguration(environment), { ok: false, code: "matrix_configuration_incomplete" });
  }
  for (const port of ["0", "65536", "3306.0", "03306", "abc"]) {
    assert.deepEqual(parseGoDaddyMatrixConfiguration({ ...mysqlConfiguration, DB_PORT: port }), { ok: false, code: "matrix_configuration_invalid" });
  }
  assert.deepEqual(parseGoDaddyMatrixConfiguration({ ...mysqlConfiguration, DB_SSL_CA_FILE: "relative.pem" }), { ok: false, code: "matrix_configuration_invalid" });
  assert.deepEqual(parseGoDaddyMatrixConfiguration({ ...mysqlConfiguration, MATRIX_STORE_BACKEND: "auto" }), { ok: false, code: "matrix_configuration_invalid" });
});

test("distinguishes absent, partial and invalid Matrix configuration without naming a secret", () => {
  assert.deepEqual(parseGoDaddyMatrixConfiguration({
    RUNTIME_MODE: "production",
    GODADDY_STATE_DATABASE_ROLE: "published"
  }), { ok: false, code: "matrix_not_configured" });
  assert.deepEqual(parseGoDaddyMatrixConfiguration({
    RUNTIME_MODE: "production",
    GODADDY_STATE_DATABASE_ROLE: "published",
    MATRIX_ROOM_ID: configured.MATRIX_ROOM_ID
  }), { ok: false, code: "matrix_configuration_incomplete" });
  const invalid = parseGoDaddyMatrixConfiguration({ ...configured, MATRIX_STORE_PASSPHRASE: "short" });
  assert.deepEqual(invalid, { ok: false, code: "matrix_configuration_invalid" });
  assert.doesNotMatch(JSON.stringify(invalid), /short|token|passphrase/i);
});

test("rejects target expansion, ambiguous or non-dedicated state roots and wrong Matrix identities", () => {
  const invalidVariants = [
    { MATRIX_ALLOWED_HTTPS_ORIGINS: "https://matrix.org,https://evil.example" },
    { MATRIX_HOMESERVER_URL: "https://matrix.org/_matrix" },
    { MATRIX_STORE_DIR: `${matrixPersistentRoot}/../matrix-store` },
    { MATRIX_MEDIA_SPOOL_DIR: `${matrixPersistentRoot}/crypto-store/spool` },
    { MATRIX_STORE_DIR: `${process.cwd()}/public/assets/matrix-store` },
    { MATRIX_MEDIA_SPOOL_DIR: `${matrixPersistentRoot}/spool` },
    { MATRIX_STORE_DIR: `${process.cwd()}/private-matrix-store` },
    { MATRIX_MEDIA_SPOOL_DIR: `${process.cwd()}/private-matrix-spool` },
    { MATRIX_OWNER_MXID: "@owner:elsewhere.example" },
    { MATRIX_BOT_MXID: configured.MATRIX_OWNER_MXID },
    { MATRIX_PROTOCOL_VERSION: "2" },
    { MATRIX_SIDECAR_SHA256: "A".repeat(64) },
    { MATRIX_STORE_PASSPHRASE: "B".repeat(64) },
    { MATRIX_STORE_PASSPHRASE: "g".repeat(64) }
  ];
  for (const override of invalidVariants) {
    assert.deepEqual(parseGoDaddyMatrixConfiguration({ ...configured, ...override }), {
      ok: false,
      code: "matrix_configuration_invalid"
    });
  }
});

test("keeps the documented Matrix environment inventory exact", () => {
  assert.deepEqual(godaddyMatrixEnvironmentNames(), [
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
  ]);
});
