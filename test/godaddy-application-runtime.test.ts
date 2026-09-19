import assert from "node:assert/strict";
import test from "node:test";

import { createGoDaddyApplicationRuntime } from "../src/godaddy/application-runtime.ts";
import type { CloseableMySqlPool } from "../src/godaddy/mysql-pool.ts";
import type { GoDaddySettingsRuntime } from "../src/godaddy/settings-runtime.ts";

const baseEnvironment = Object.freeze({
  RUNTIME_MODE: "production",
  GODADDY_STATE_DATABASE_ROLE: "published",
  DB_HOST: "db.internal",
  DB_PORT: "3306",
  DB_NAME: "personal_consultant",
  DB_USER: "application",
  DB_PASSWORD: "synthetic",
  ARCHIVE_ENCRYPTION_KEY: "a".repeat(64),
  RUNTIME_INSTRUCTION_ENCRYPTION_KEY: "b".repeat(64),
  RUNTIME_CREDENTIAL_ENCRYPTION_KEY: "c".repeat(64)
});

function harness(environment: Record<string, unknown>) {
  let ended = 0;
  const pool = {
    async execute() { throw new Error("Unexpected query."); },
    async getConnection() { throw new Error("Unexpected connection."); },
    async end() { ended += 1; }
  } as CloseableMySqlPool;
  const settings = Object.freeze({ configured: true, async handle() { return undefined; }, async close() {} }) as GoDaddySettingsRuntime;
  const runtime = createGoDaddyApplicationRuntime({ environment }, {
    createPool: () => pool,
    createSettingsRuntime: () => settings
  });
  return { runtime, ended: () => ended };
}

test("application readiness requires three independent encryption roots", async () => {
  const valid = harness({ ...baseEnvironment });
  assert.equal(valid.runtime.configured, true);
  await valid.runtime.stop();
  assert.equal(valid.ended(), 1);

  for (const patch of [
    { RUNTIME_CREDENTIAL_ENCRYPTION_KEY: undefined },
    { RUNTIME_INSTRUCTION_ENCRYPTION_KEY: "short" },
    { RUNTIME_CREDENTIAL_ENCRYPTION_KEY: baseEnvironment.ARCHIVE_ENCRYPTION_KEY }
  ]) {
    const invalid = harness({ ...baseEnvironment, ...patch });
    assert.equal(invalid.runtime.configured, false);
    await invalid.runtime.stop();
    assert.equal(invalid.ended(), 1);
  }
});
