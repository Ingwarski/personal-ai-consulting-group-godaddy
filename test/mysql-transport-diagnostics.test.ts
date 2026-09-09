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

test("reports normalized MySQL transport facts without connection details", async () => {
  const fixture = pool({ cipher: "TLS_AES_256_GCM_SHA384", haveSsl: "YES", required: "ON" });
  assert.deepEqual(await inspectMySqlTransport(fixture.value), {
    nodeDatabaseReachable: true,
    nodeSessionEncrypted: true,
    serverTlsSupport: "available",
    secureTransportRequired: true
  });
  assert.equal(fixture.released(), true);
  assert.equal(fixture.destroyed(), false);
});

test("reports the provider's unencrypted MySQL path and disabled TLS", async () => {
  const fixture = pool({ cipher: "", haveSsl: "DISABLED", required: "OFF" });
  assert.deepEqual(await inspectMySqlTransport(fixture.value), {
    nodeDatabaseReachable: true,
    nodeSessionEncrypted: false,
    serverTlsSupport: "disabled",
    secureTransportRequired: false
  });
});

test("fails closed without exposing a database error", async () => {
  const fixture = pool({ fail: true });
  assert.deepEqual(await inspectMySqlTransport(fixture.value), {
    nodeDatabaseReachable: false,
    nodeSessionEncrypted: "unknown",
    serverTlsSupport: "unknown",
    secureTransportRequired: "unknown"
  });
  assert.equal(fixture.released(), true);
  assert.equal(fixture.destroyed(), true);
});
