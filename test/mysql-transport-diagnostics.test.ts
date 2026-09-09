import assert from "node:assert/strict";
import test from "node:test";

import { inspectMySqlTransport } from "../src/godaddy/mysql-transport-diagnostics.ts";
import type { MySqlConnection, MySqlPool } from "../src/godaddy/mysql-storage.ts";

function pool(input: Readonly<{ cipher?: string; haveSsl?: string; required?: string; fail?: boolean }>): Readonly<{
  value: MySqlPool; released: () => boolean; destroyed: () => boolean;
}> {
  let release = false;
  let destroy = false;
  const connection: MySqlConnection = {
    async execute(statement) {
      if (input.fail) throw new Error("secret database failure");
      if (statement.includes("SESSION STATUS")) return [[{ Variable_name: "Ssl_cipher", Value: input.cipher ?? "" }], []];
      return [[
        { Variable_name: "have_ssl", Value: input.haveSsl ?? "YES" },
        { Variable_name: "require_secure_transport", Value: input.required ?? "OFF" }
      ], []];
    },
    async beginTransaction() {}, async commit() {}, async rollback() {},
    release: () => { release = true; }, destroy: () => { destroy = true; }
  };
  return {
    value: { execute: connection.execute, async getConnection() { return connection; } },
    released: () => release, destroyed: () => destroy
  };
}

const database = { host: "private.invalid", port: 3306, database: "app", user: "app", password: "secret" };
const tlsConnection = (cipher: string): Readonly<{ execute: (statement: string, values: readonly unknown[]) => Promise<readonly [unknown, unknown]>; end: () => Promise<void> }> => ({
  async execute() { return [[{ Variable_name: "Ssl_cipher", Value: cipher }], []]; },
  async end() {}
});

test("reports normalized MySQL transport facts without connection details", async () => {
  const fixture = pool({ cipher: "TLS_AES_256_GCM_SHA384", haveSsl: "YES", required: "ON" });
  assert.deepEqual(await inspectMySqlTransport(fixture.value), {
    nodeDatabaseReachable: true,
    nodeSessionEncrypted: true,
    nodeExtraCaConfigured: false,
    nodeAdditionalSystemCaActive: false,
    serverTlsSupport: "available",
    secureTransportRequired: true,
    verifiedTlsConnection: "not_checked",
    verifiedTlsIdentityConnection: "not_checked"
  });
  assert.equal(fixture.released(), true);
  assert.equal(fixture.destroyed(), false);
});

test("reports the provider's unencrypted MySQL path and disabled TLS", async () => {
  const fixture = pool({ cipher: "", haveSsl: "DISABLED", required: "OFF" });
  assert.deepEqual(await inspectMySqlTransport(fixture.value), {
    nodeDatabaseReachable: true,
    nodeSessionEncrypted: false,
    nodeExtraCaConfigured: false,
    nodeAdditionalSystemCaActive: false,
    serverTlsSupport: "disabled",
    secureTransportRequired: false,
    verifiedTlsConnection: "not_checked",
    verifiedTlsIdentityConnection: "not_checked"
  });
});

test("fails closed without exposing a database error", async () => {
  const fixture = pool({ fail: true });
  assert.deepEqual(await inspectMySqlTransport(fixture.value), {
    nodeDatabaseReachable: false,
    nodeSessionEncrypted: "unknown",
    nodeExtraCaConfigured: false,
    nodeAdditionalSystemCaActive: false,
    serverTlsSupport: "unknown",
    secureTransportRequired: "unknown",
    verifiedTlsConnection: "not_checked",
    verifiedTlsIdentityConnection: "not_checked"
  });
  assert.equal(fixture.released(), false);
  assert.equal(fixture.destroyed(), true);
});

test("probes a separate certificate-verified TLS session and reports only a stable result", async () => {
  const fixture = pool({ cipher: "" });
  assert.equal((await inspectMySqlTransport(fixture.value, database, {
    connectTls: async () => tlsConnection("TLS_AES_256_GCM_SHA384"),
    connectIdentityTls: async () => tlsConnection("TLS_AES_256_GCM_SHA384")
  })).verifiedTlsConnection, "connected");
  for (const [code, expected] of [
    ["HANDSHAKE_NO_SSL_SUPPORT", "server_not_supported"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "server_identity_rejected"],
    ["ECONNRESET", "connection_closed"],
    ["ETIMEDOUT", "network_failed"],
    ["ER_ACCESS_DENIED_ERROR", "login_or_database_failed"],
    ["PRIVATE_SECRET_FAILURE", "failed"]
  ] as const) {
    const result = await inspectMySqlTransport(fixture.value, database, {
      connectTls: async () => { throw Object.assign(new Error("private host"), { code }); },
      connectIdentityTls: async () => tlsConnection("TLS_AES_256_GCM_SHA384")
    });
    assert.equal(result.verifiedTlsConnection, expected);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("distinguishes CA validation from server-identity validation", async () => {
  const fixture = pool({ cipher: "" });
  const result = await inspectMySqlTransport(fixture.value, database, {
    connectTls: async () => tlsConnection("TLS_AES_256_GCM_SHA384"),
    connectIdentityTls: async () => {
      throw Object.assign(new Error("private certificate name"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    }
  });
  assert.equal(result.verifiedTlsConnection, "connected");
  assert.equal(result.verifiedTlsIdentityConnection, "server_identity_rejected");
  assert.equal(JSON.stringify(result).includes("private"), false);
});
