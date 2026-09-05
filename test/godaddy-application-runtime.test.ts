import assert from "node:assert/strict";
import test from "node:test";

import { createGoDaddyApplicationRuntime } from "../src/godaddy/application-runtime.ts";
import type { MySqlConnection } from "../src/godaddy/mysql-storage.ts";

const publicationSynchronizer = Object.freeze({
  async withPublicationPermit<Value>(publish: () => Promise<Value>): Promise<Value> { return publish(); },
  async withGenerationFence<Value>(
    _input: Readonly<{ generation: number }>,
    fence: () => Promise<Value>
  ): Promise<Value> { return fence(); }
});

const productionEnvironment = Object.freeze({
  RUNTIME_MODE: "production",
  GODADDY_STATE_DATABASE_ROLE: "published",
  DB_HOST: "db.internal",
  DB_PORT: "3306",
  DB_NAME: "personal_consultant",
  DB_USER: "application",
  DB_PASSWORD: "test-only-password"
});

test("Preview remains inert even when a complete Published environment is copied into it", async () => {
  const calls: string[] = [];
  const application = createGoDaddyApplicationRuntime({
    environment: { ...productionEnvironment, RUNTIME_MODE: "development", MATRIX_ACCESS_TOKEN: "copied-secret" }
  }, {
    createPool: () => {
      calls.push("pool");
      throw new Error("Preview must not create a pool.");
    },
    createRegistrarRuntime: () => {
      calls.push("registrar");
      throw new Error("Preview must not create a registrar.");
    },
    createMatrixService: () => {
      calls.push("matrix");
      throw new Error("Preview must not create Matrix resources.");
    },
    createSettingsRuntime: (_environment, dependencies) => {
      calls.push("settings");
      assert.equal(dependencies.pool, undefined);
      assert.equal(dependencies.registrarRuntime, undefined);
      return Object.freeze({
        configured: false,
        handle: async () => undefined,
        close: async () => { calls.push("settings.close"); }
      });
    }
  });

  assert.equal(application.configured, false);
  assert.equal(application.registrarRuntime, undefined);
  assert.equal(application.matrixService, undefined);
  await application.start();
  await Promise.all([application.stop(), application.stop()]);
  assert.deepEqual(calls, ["settings", "settings.close"]);
});

test("Published composition shares one pool and closes Matrix, providers, then the pool exactly once", async () => {
  const calls: string[] = [];
  let capturedPool: unknown;
  let capturedRegistrar: unknown;
  let wakeMatrixOutbox: (() => void | Promise<void>) | undefined;
  const pool = {
    execute: async (): Promise<readonly [unknown, unknown]> => [[], []],
    getConnection: async (): Promise<MySqlConnection> => { throw new Error("unused"); },
    end: async (): Promise<void> => { calls.push("pool.end"); }
  };
  const registrarRuntime = {
    registrar: {} as never,
    matrixOutbox: {} as never,
    matrixIngressReceipts: {} as never,
    matrixPublicationSynchronizer: publicationSynchronizer,
    afterConfirmed: async () => { await wakeMatrixOutbox?.(); },
    getActiveSessionSummary: async () => null
  };
  let matrixStarts = 0;
  let matrixWakes = 0;
  const matrixMediaConsumer = async (input: Readonly<{ eventHash: string }>) => ({
    eventHash: input.eventHash,
    consumptionReceiptHash: "a".repeat(64)
  });

  const application = createGoDaddyApplicationRuntime({ environment: productionEnvironment }, {
    createPool: () => pool,
    createRegistrarRuntime: (input) => {
      capturedPool = input.pool;
      wakeMatrixOutbox = input.wakeMatrixOutbox;
      void input.wakeMatrixOutbox?.();
      return registrarRuntime;
    },
    createSettingsRuntime: (_environment, dependencies) => {
      assert.equal(dependencies.pool, pool);
      capturedRegistrar = dependencies.registrarRuntime;
      return Object.freeze({
        configured: true,
        handle: async () => undefined,
        close: async () => { calls.push("settings.close"); }
      });
    },
    matrixMediaConsumer,
    createMatrixService: (input, serviceDependencies) => {
      assert.equal(input.pool, pool);
      assert.equal(input.registrarRuntime, registrarRuntime);
      assert.equal(serviceDependencies?.mediaConsumer, matrixMediaConsumer);
      assert.equal(serviceDependencies?.publicationSynchronizer, publicationSynchronizer);
      return Object.freeze({
        configured: true,
        start: async () => { matrixStarts += 1; },
        wakeOutbox: () => { matrixWakes += 1; },
        getReadiness: () => Object.freeze({ configured: true, ready: true, reason: "ready" }),
        assertReadyForNewSession: () => undefined,
        stop: async () => { calls.push("matrix.stop"); }
      });
    }
  });

  assert.equal(application.configured, true);
  assert.equal(capturedPool, pool);
  assert.equal(capturedRegistrar, registrarRuntime);
  assert.equal(matrixWakes, 1);
  await Promise.all([application.start(), application.start()]);
  assert.equal(matrixStarts, 1);
  await Promise.all([application.stop(), application.stop()]);
  assert.deepEqual(calls, ["matrix.stop", "settings.close", "pool.end"]);
});

test("forbidden production credentials fail before any stateful composition", async () => {
  let pools = 0;
  const application = createGoDaddyApplicationRuntime({
    environment: { ...productionEnvironment, OPENAI_API_KEY: "forbidden" }
  }, {
    createPool: () => {
      pools += 1;
      throw new Error("Forbidden configuration must not create a pool.");
    },
    createSettingsRuntime: () => Object.freeze({
      configured: false,
      handle: async () => undefined,
      close: async () => undefined
    })
  });
  await application.start();
  await application.stop();
  assert.equal(application.configured, false);
  assert.equal(pools, 0);
});

test("invalid shutdown policy and incomplete Settings fail before background Matrix work", async () => {
  let pools = 0;
  assert.throws(() => createGoDaddyApplicationRuntime({ environment: productionEnvironment }, {
    shutdownTimeoutMs: 999,
    createPool: () => {
      pools += 1;
      throw new Error("Invalid lifecycle policy must be rejected first.");
    }
  }), /Invalid application shutdown timeout/u);
  assert.equal(pools, 0);

  let matrixStarts = 0;
  const pool = {
    execute: async (): Promise<readonly [unknown, unknown]> => [[], []],
    getConnection: async (): Promise<MySqlConnection> => { throw new Error("unused"); },
    end: async (): Promise<void> => undefined
  };
  const registrarRuntime = {
    registrar: {} as never,
    matrixOutbox: {} as never,
    matrixIngressReceipts: {} as never,
    matrixPublicationSynchronizer: publicationSynchronizer,
    afterConfirmed: async () => undefined,
    getActiveSessionSummary: async () => null
  };
  const application = createGoDaddyApplicationRuntime({ environment: productionEnvironment }, {
    createPool: () => pool,
    createRegistrarRuntime: () => registrarRuntime,
    createSettingsRuntime: () => Object.freeze({
      configured: false,
      handle: async () => undefined,
      close: async () => undefined
    }),
    createMatrixService: () => Object.freeze({
      configured: true,
      start: async () => { matrixStarts += 1; },
      wakeOutbox: () => undefined,
      getReadiness: () => Object.freeze({ configured: true, ready: false, reason: "starting" }),
      assertReadyForNewSession: () => { throw new Error("not ready"); },
      stop: async () => undefined
    })
  });
  assert.equal(application.configured, false);
  await application.start();
  assert.equal(matrixStarts, 0);
  await application.stop();
});

test("a failed Matrix stop never races provider or pool teardown", async () => {
  const calls: string[] = [];
  const pool = {
    execute: async (): Promise<readonly [unknown, unknown]> => [[], []],
    getConnection: async (): Promise<MySqlConnection> => { throw new Error("unused"); },
    end: async (): Promise<void> => { calls.push("pool.end"); }
  };
  const registrarRuntime = {
    registrar: {} as never,
    matrixOutbox: {} as never,
    matrixIngressReceipts: {} as never,
    matrixPublicationSynchronizer: publicationSynchronizer,
    afterConfirmed: async () => undefined,
    getActiveSessionSummary: async () => null
  };
  const application = createGoDaddyApplicationRuntime({ environment: productionEnvironment }, {
    createPool: () => pool,
    createRegistrarRuntime: () => registrarRuntime,
    createSettingsRuntime: () => Object.freeze({
      configured: true,
      handle: async () => undefined,
      close: async () => { calls.push("settings.close"); }
    }),
    createMatrixService: () => Object.freeze({
      configured: true,
      start: async () => undefined,
      wakeOutbox: () => undefined,
      getReadiness: () => Object.freeze({ configured: true, ready: true, reason: "ready" }),
      assertReadyForNewSession: () => undefined,
      stop: async () => {
        calls.push("matrix.stop");
        throw new Error("sidecar did not terminate");
      }
    })
  });

  await assert.rejects(application.stop(), /sidecar did not terminate/u);
  assert.deepEqual(calls, ["matrix.stop"]);
  await assert.rejects(application.stop(), /sidecar did not terminate/u);
  assert.deepEqual(calls, ["matrix.stop"]);
});
