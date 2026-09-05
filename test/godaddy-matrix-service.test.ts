import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createGoDaddyMatrixService,
  type DurableMatrixMediaConsumer,
  type GoDaddyMatrixDatabaseProbe,
  type MatrixPublicationSynchronizer,
  type MatrixServiceClock
} from "../src/godaddy/matrix-service.ts";
import type { GoDaddyMatrixConfiguration } from "../src/godaddy/matrix-service-config.ts";
import type {
  MatrixAcceptanceReceipt,
  MatrixIngressMediaObject,
  MatrixRuntime,
  MatrixRuntimeReadiness,
  MatrixSendInput,
  ValidatedMatrixIngress,
  ValidatedMatrixIngressRejection
} from "../src/godaddy/matrix-runtime.ts";
import { MatrixSidecarError, type MatrixSidecarSupervisorOptions } from "../src/godaddy/matrix-sidecar-supervisor.ts";
import type { LeasedMatrixOutboxRecord } from "../src/godaddy/mysql-matrix-outbox.ts";
import type { MySqlPool } from "../src/godaddy/mysql-storage.ts";
import type { GoDaddyRegistrarRuntime } from "../src/godaddy/registrar-runtime.ts";

const FIXED_TIME = Date.parse("2026-09-05T12:00:00.000Z");
const readyProbe: GoDaddyMatrixDatabaseProbe = Object.freeze({
  mysqlAvailable: true,
  schemaAvailable: true,
  outboxAvailable: true,
  ingressAvailable: true
});

const immediatePublicationSynchronizer: MatrixPublicationSynchronizer = Object.freeze({
  async withPublicationPermit<Value>(publish: () => Promise<Value>) {
    return publish();
  },
  async withGenerationFence<Value>(_input: unknown, fence: () => Promise<Value>) {
    return fence();
  }
});

const configuration: GoDaddyMatrixConfiguration = Object.freeze({
  applicationRoot: "/srv/personal-consultant/app",
  binaryPath: "/srv/personal-consultant/bin/matrix-sidecar",
  expectedSha256: "a".repeat(64),
  protocolVersion: 1,
  expectedBuild: "0.1.0",
  storeDir: "/srv/personal-consultant/app/public/assets/.personal-consultant-matrix-v1/crypto-store",
  mediaSpoolDir: "/srv/personal-consultant/app/public/assets/.personal-consultant-matrix-v1/media-spool",
  homeserverOrigin: "https://matrix.org",
  roomId: "!private-room:matrix.org",
  ownerMxid: "@owner:matrix.org",
  botMxid: "@consultant-bot:matrix.org",
  botDeviceId: "BOT_DEVICE_1",
  expectedIdentityHashes: Object.freeze({
    roomIdSha256: "b".repeat(64),
    ownerMxidSha256: "c".repeat(64),
    botMxidSha256: "d".repeat(64),
    botDeviceIdSha256: "e".repeat(64)
  }),
  spawnEnvironment: Object.freeze({
    PATH: "/usr/bin:/bin",
    MATRIX_HOMESERVER_URL: "https://matrix.org",
    MATRIX_ALLOWED_HTTPS_ORIGINS: "https://matrix.org",
    MATRIX_STORE_DIR: "/srv/personal-consultant/app/public/assets/.personal-consultant-matrix-v1/crypto-store",
    MATRIX_STORE_PASSPHRASE: "a".repeat(64),
    MATRIX_MEDIA_SPOOL_DIR: "/srv/personal-consultant/app/public/assets/.personal-consultant-matrix-v1/media-spool",
    MATRIX_ACCESS_TOKEN: "test-only-token",
    MATRIX_ROOM_ID: "!private-room:matrix.org",
    MATRIX_OWNER_MXID: "@owner:matrix.org",
    MATRIX_BOT_MXID: "@consultant-bot:matrix.org",
    MATRIX_BOT_DEVICE_ID: "BOT_DEVICE_1"
  })
});

function currentSchemaColumns(): readonly Readonly<Record<string, unknown>>[] {
  const specifications = [
    ["personal_consultant_state", `
state_namespace|varchar(64)|NO|-|utf8mb4_bin
state_key|varchar(191)|NO|-|utf8mb4_bin
state_value|json|NO|-|-
updated_at|timestamp(6)|NO|current_timestamp(6)|-`],
    ["personal_consultant_matrix_outbox", `
generation|bigint unsigned|NO|-|-
sequence_no|bigint unsigned|NO|-|-
transaction_id|varchar(128)|NO|-|ascii_bin
state|enum('pending','leased','accepted','device_delivered','read','blocked','cancelled')|NO|-|-
record_kind|enum('message','control')|NO|-|-
message_json|json|NO|-|-
body_hash|char(64)|NO|-|ascii_bin
delivery_hash|char(64)|NO|-|ascii_bin
reply_to_event_id|varchar(255)|YES|-|utf8mb4_bin
matrix_event_id|varchar(255)|YES|-|utf8mb4_bin
lease_owner|varchar(128)|YES|-|ascii_bin
lease_epoch|bigint unsigned|NO|0|-
lease_expires_at|varchar(64)|YES|-|-
attempt_count|bigint unsigned|NO|0|-
last_error_code|varchar(96)|YES|-|ascii_bin
available_at|varchar(64)|NO|-|-
created_at|varchar(64)|NO|-|-
accepted_at|varchar(64)|YES|-|-
device_delivered_at|varchar(64)|YES|-|-
read_at|varchar(64)|YES|-|-
device_delivery_evidence_id|varchar(128)|YES|-|ascii_bin
device_delivery_evidence_hash|char(64)|YES|-|ascii_bin
read_evidence_id|varchar(128)|YES|-|ascii_bin
read_evidence_hash|char(64)|YES|-|ascii_bin
updated_at|timestamp(6)|NO|current_timestamp(6)|-`],
    ["personal_consultant_matrix_ingress", `
event_id|varchar(255)|NO|-|utf8mb4_bin
event_hash|char(64)|NO|-|ascii_bin
state|enum('ready','leased','processed','rejected','blocked')|NO|-|-
room_id|varchar(255)|NO|-|utf8mb4_bin
owner_mxid|varchar(255)|NO|-|utf8mb4_bin
body_hash|char(64)|NO|-|ascii_bin
media_manifest_hash|char(64)|NO|-|ascii_bin
work_intent_json|json|NO|-|-
ack_eligible_at|varchar(64)|YES|-|-
media_consumption_receipt_hash|char(64)|YES|-|ascii_bin
media_consumed_at|varchar(64)|YES|-|-
lease_owner|varchar(128)|YES|-|ascii_bin
lease_epoch|bigint unsigned|NO|0|-
lease_expires_at|varchar(64)|YES|-|-
session_id|varchar(128)|YES|-|-
generation|bigint unsigned|YES|-|-
received_at|varchar(64)|NO|-|-
acknowledged_at|varchar(64)|YES|-|-
updated_at|timestamp(6)|NO|current_timestamp(6)|-`]
  ] as const;
  return Object.freeze(specifications.flatMap(([tableName, source]) => source.trim().split("\n").map((line) => {
    const [columnName, columnType, isNullable, columnDefault, collationName] = line.split("|");
    return Object.freeze({
      tableName,
      columnName,
      columnType,
      isNullable,
      columnDefault: columnDefault === "-" ? null : columnDefault,
      collationName: collationName === "-" ? null : collationName
    });
  })));
}

function currentSchemaIndexes(reverseOutboxPrimary = false): readonly Readonly<Record<string, unknown>>[] {
  const definitions = [
    ["personal_consultant_state", "PRIMARY", 0, ["state_namespace", "state_key"]],
    ["personal_consultant_matrix_outbox", "PRIMARY", 0, reverseOutboxPrimary ? ["sequence_no", "generation"] : ["generation", "sequence_no"]],
    ["personal_consultant_matrix_outbox", "uq_matrix_outbox_transaction", 0, ["transaction_id"]],
    ["personal_consultant_matrix_outbox", "uq_matrix_outbox_event", 0, ["matrix_event_id"]],
    ["personal_consultant_matrix_outbox", "ix_matrix_outbox_head", 1, ["state", "generation", "sequence_no"]],
    ["personal_consultant_matrix_ingress", "PRIMARY", 0, ["event_id"]],
    ["personal_consultant_matrix_ingress", "ix_matrix_ingress_recovery", 1, ["state", "lease_expires_at"]]
  ] as const;
  return Object.freeze(definitions.flatMap(([tableName, indexName, nonUnique, columns]) =>
    columns.map((columnName, index) => Object.freeze({
      tableName,
      indexName,
      nonUnique,
      sequenceInIndex: index + 1,
      columnName,
      subPart: null,
      indexType: "BTREE"
    }))
  ));
}

class ManualClock implements MatrixServiceClock {
  #nextId = 1;
  #timers = new Map<number, Readonly<{ dueAt: number; callback: () => void }>>();
  current = FIXED_TIME;

  readonly now = (): number => this.current;

  readonly setTimeout = (callback: () => void, milliseconds: number): unknown => {
    const id = this.#nextId++;
    this.#timers.set(id, { dueAt: this.current + milliseconds, callback });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") this.#timers.delete(handle);
  };

  async flushDue(maximum = 100): Promise<void> {
    for (let index = 0; index < maximum; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.current)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (due === undefined) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const newlyDue = [...this.#timers.values()].some((timer) => timer.dueAt <= this.current);
        if (!newlyDue) return;
        continue;
      }
      this.#timers.delete(due[0]);
      due[1].callback();
    }
    throw new Error("Manual clock did not become idle.");
  }

  async advance(milliseconds: number): Promise<void> {
    this.current += milliseconds;
    await this.flushDue();
  }
}

class FakeMatrixRuntime implements MatrixRuntime {
  readiness: MatrixRuntimeReadiness = Object.freeze({
    liveness: "alive",
    matrixReadiness: "ready",
    reason: "ready",
    circuitOpen: false
  });
  subscriber: ((event: ValidatedMatrixIngress) => void | Promise<void>) | undefined;
  rejectionSubscriber:
    | ((rejection: ValidatedMatrixIngressRejection) => void | Promise<void>)
    | undefined;
  starts = 0;
  stops = 0;
  mediaReads = 0;
  ingressUnsubscriptions = 0;
  rejectionUnsubscriptions = 0;
  rejectionSubscriptionError: Error | undefined;
  readonly lifecycleCalls: string[] = [];
  readonly sent: MatrixSendInput[] = [];
  readonly acknowledgements: Array<Readonly<{ receiptId: string; durableReceiptId: string }>> = [];
  startImpl: () => Promise<void> = async () => undefined;
  stopImpl: () => Promise<void> = async () => undefined;
  sendImpl: (input: MatrixSendInput) => Promise<MatrixAcceptanceReceipt> = async (input) => Object.freeze({
    transactionId: input.transactionId,
    eventId: "$accepted-event:matrix.org",
    status: "accepted"
  });
  readMediaImpl: (media: ValidatedMatrixIngress["media"]) => Promise<readonly MatrixIngressMediaObject[]> = async () => [];
  ackImpl: (input: Readonly<{ receiptId: string; durableReceiptId: string }>) => Promise<void> = async () => undefined;

  async start(): Promise<void> {
    assert.notEqual(this.subscriber, undefined);
    assert.notEqual(this.rejectionSubscriber, undefined);
    this.lifecycleCalls.push("start");
    this.starts += 1;
    await this.startImpl();
  }

  async stop(): Promise<void> {
    this.stops += 1;
    await this.stopImpl();
  }

  getReadiness(): MatrixRuntimeReadiness {
    return this.readiness;
  }

  onIngress(subscriber: (event: ValidatedMatrixIngress) => void | Promise<void>): () => void {
    assert.equal(this.subscriber, undefined);
    this.lifecycleCalls.push("subscribe-ingress");
    this.subscriber = subscriber;
    return () => {
      if (this.subscriber === subscriber) {
        this.subscriber = undefined;
        this.ingressUnsubscriptions += 1;
      }
    };
  }

  onRejectedIngress(
    subscriber: (rejection: ValidatedMatrixIngressRejection) => void | Promise<void>
  ): () => void {
    assert.equal(this.rejectionSubscriber, undefined);
    this.lifecycleCalls.push("subscribe-rejection");
    if (this.rejectionSubscriptionError !== undefined) throw this.rejectionSubscriptionError;
    this.rejectionSubscriber = subscriber;
    return () => {
      if (this.rejectionSubscriber === subscriber) {
        this.rejectionSubscriber = undefined;
        this.rejectionUnsubscriptions += 1;
      }
    };
  }

  async ackIngress(input: Readonly<{ receiptId: string; durableReceiptId: string }>): Promise<void> {
    this.acknowledgements.push(input);
    await this.ackImpl(input);
  }

  async readMedia(media: ValidatedMatrixIngress["media"]): Promise<readonly MatrixIngressMediaObject[]> {
    this.mediaReads += 1;
    return this.readMediaImpl(media);
  }

  async send(input: MatrixSendInput): Promise<MatrixAcceptanceReceipt> {
    this.sent.push(input);
    return this.sendImpl(input);
  }

  emit(event: ValidatedMatrixIngress): void | Promise<void> {
    return this.subscriber?.(event);
  }

  emitRejection(rejection: ValidatedMatrixIngressRejection): void | Promise<void> {
    return this.rejectionSubscriber?.(rejection);
  }
}

class FakeOutbox {
  readonly calls: string[] = [];
  readonly leases: Array<Readonly<{ leaseOwner: string; leaseMilliseconds: number }>> = [];
  releases = 0;
  blocks = 0;
  accepted = 0;
  inspectImpl: () => Promise<"idle" | "available" | "waiting" | "blocked" | "corrupt"> = async () => "idle";
  leaseImpl: () => Promise<LeasedMatrixOutboxRecord | undefined> = async () => undefined;
  markAcceptedImpl: () => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: "stale_lease" }>> = async () => ({ ok: true });

  async inspectHead(): Promise<"idle" | "available" | "waiting" | "blocked" | "corrupt"> {
    this.calls.push("inspect");
    return this.inspectImpl();
  }

  async leaseHead(input: Readonly<{ leaseOwner: string; leaseMilliseconds: number }>): Promise<LeasedMatrixOutboxRecord | undefined> {
    this.calls.push("lease");
    this.leases.push(input);
    return this.leaseImpl();
  }

  async markAccepted(): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: "stale_lease" }>> {
    this.calls.push("markAccepted");
    this.accepted += 1;
    return this.markAcceptedImpl();
  }

  async markBlocked(): Promise<Readonly<{ ok: true }>> {
    this.calls.push("markBlocked");
    this.blocks += 1;
    return { ok: true };
  }

  async releaseTransient(): Promise<Readonly<{ ok: true }>> {
    this.calls.push("release");
    this.releases += 1;
    return { ok: true };
  }
}

class FakeIngressReceipts {
  readonly calls: string[] = [];
  readonly intents: unknown[] = [];
  readonly rejections: unknown[] = [];
  persistIntentImpl: () => Promise<Readonly<{ ok: true; replayed: boolean; durableAck: boolean; processed: boolean }>> =
    async () => ({ ok: true, replayed: false, durableAck: true, processed: false });
  persistRejectionImpl: () => Promise<
    | Readonly<{ ok: true; replayed: boolean; durableAck: boolean; processed: false }>
    | Readonly<{ ok: false; code: "event_conflict" }>
  > =
    async () => ({ ok: true, replayed: false, durableAck: true, processed: false });
  acknowledgeImpl: () => Promise<boolean> = async () => true;
  markMediaConsumedImpl: () => Promise<boolean> = async () => true;

  async persistIntent(input: unknown): Promise<Readonly<{ ok: true; replayed: boolean; durableAck: boolean; processed: boolean }>> {
    this.calls.push("persistIntent");
    this.intents.push(input);
    return this.persistIntentImpl();
  }

  async persistRejection(input: unknown): Promise<
    | Readonly<{ ok: true; replayed: boolean; durableAck: boolean; processed: false }>
    | Readonly<{ ok: false; code: "event_conflict" }>
  > {
    this.calls.push("persistRejection");
    this.rejections.push(input);
    return this.persistRejectionImpl();
  }

  async acknowledge(): Promise<boolean> {
    this.calls.push("ackEvidence");
    return this.acknowledgeImpl();
  }

  async markMediaConsumed(): Promise<boolean> {
    this.calls.push("markMediaConsumed");
    return this.markMediaConsumedImpl();
  }
}

class SerialPublicationSynchronizer implements MatrixPublicationSynchronizer {
  #tail: Promise<void> = Promise.resolve();

  async #exclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    const previous = this.#tail;
    let release: (() => void) | undefined;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  async withPublicationPermit<Value>(publish: () => Promise<Value>): Promise<Value> {
    return this.#exclusive(publish);
  }

  async withGenerationFence<Value>(
    _input: Readonly<{ generation: number }>,
    fence: () => Promise<Value>
  ): Promise<Value> {
    return this.#exclusive(fence);
  }
}

function ingress(overrides: Partial<ValidatedMatrixIngress> = {}): ValidatedMatrixIngress {
  return Object.freeze({
    receiptId: "receipt-0001",
    eventId: "$event-0001:matrix.org",
    roomId: configuration.roomId,
    senderMxid: configuration.ownerMxid,
    senderDeviceId: "OWNER_DEVICE_1",
    body: "Проведи аналіз.",
    media: Object.freeze([]),
    ...overrides
  });
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function rejectionFor(
  event: ValidatedMatrixIngress,
  overrides: Partial<ValidatedMatrixIngressRejection> = {}
): ValidatedMatrixIngressRejection {
  const media = Object.freeze(event.media.map((item) => Object.freeze({
    declaredMime: item.declaredMime,
    length: item.length,
    sha256: item.sha256
  })));
  const bodyHash = sha256Json(event.body);
  const mediaManifestHash = sha256Json(media);
  const eventHash = sha256Json({
    eventId: event.eventId,
    roomId: event.roomId,
    senderMxid: event.senderMxid,
    senderDeviceId: event.senderDeviceId,
    encrypted: true,
    bodyHash,
    relationEventId: event.relationEventId ?? null,
    mediaManifestHash
  });
  return Object.freeze({
    receiptId: event.receiptId,
    eventId: event.eventId,
    roomId: event.roomId,
    senderMxid: event.senderMxid,
    senderDeviceId: event.senderDeviceId,
    bodyHash,
    mediaManifestHash,
    eventHash,
    reason: "media_expired",
    ...overrides
  });
}

function mediaIngress(overrides: Partial<ValidatedMatrixIngress> = {}): ValidatedMatrixIngress {
  return ingress({
    body: null,
    media: Object.freeze([{
      handle: `${"1".repeat(32)}-${"2".repeat(24)}.pdf`,
      declaredMime: "application/pdf",
      length: 8,
      sha256: "3".repeat(64)
    }]),
    ...overrides
  });
}

function lease(attemptCount = 1, sequence = 1): LeasedMatrixOutboxRecord {
  return Object.freeze({
    generation: 1,
    sequence,
    transactionId: `pc-1-${sequence}-${"f".repeat(24)}`,
    message: Object.freeze({
      generation: 1,
      sequence,
      internalEventId: `confirmed-event-${String(sequence).padStart(4, "0")}`,
      role: "Головний консультант",
      visibleTime: "12:00",
      bodyFormat: "markdown" as const,
      body: `Відповідь ${sequence}`,
      bodyHash: "a".repeat(64),
      confirmedAt: "2026-09-05T12:00:00.000Z"
    }),
    leaseOwner: "matrix-worker-test",
    leaseEpoch: 1,
    attemptCount
  });
}

type HarnessOptions = Readonly<{
  probe?: () => Promise<GoDaddyMatrixDatabaseProbe>;
  mediaConsumer?: DurableMatrixMediaConsumer | null;
  runtime?: FakeMatrixRuntime;
  outbox?: FakeOutbox;
  receipts?: FakeIngressReceipts;
  readBinding?: () => Promise<Readonly<{ ok: true; value: Readonly<{ deviceId: string; storeFingerprint: string }> }>>;
  publicationSynchronizer?: MatrixPublicationSynchronizer;
}>;

function harness(options: HarnessOptions = {}) {
  const clock = new ManualClock();
  const runtime = options.runtime ?? new FakeMatrixRuntime();
  const outbox = options.outbox ?? new FakeOutbox();
  const receipts = options.receipts ?? new FakeIngressReceipts();
  const publicationSynchronizer = options.publicationSynchronizer ?? immediatePublicationSynchronizer;
  const supervisorOptions: MatrixSidecarSupervisorOptions[] = [];
  const runtimeInputs: Array<Parameters<NonNullable<Parameters<typeof createGoDaddyMatrixService>[1]["createRuntime"]>>[0]> = [];
  let bindingReads = 0;
  const pool = Object.freeze({
    execute: async (): Promise<readonly [unknown, unknown]> => [[], []],
    getConnection: async () => { throw new Error("unused"); }
  }) as unknown as MySqlPool;
  const registrarRuntime = Object.freeze({
    registrar: {} as never,
    matrixOutbox: outbox,
    matrixIngressReceipts: receipts,
    matrixPublicationSynchronizer: publicationSynchronizer,
    afterConfirmed: async () => undefined,
    getActiveSessionSummary: () => undefined
  }) as unknown as GoDaddyRegistrarRuntime;
  const defaultConsumer: DurableMatrixMediaConsumer = async ({ eventHash }) => ({
    eventHash,
    consumptionReceiptHash: "9".repeat(64)
  });
  const service = createGoDaddyMatrixService({
    environment: { RUNTIME_MODE: "production", GODADDY_STATE_DATABASE_ROLE: "published" },
    pool,
    registrarRuntime,
    now: () => new Date(clock.now())
  }, {
    parseConfiguration: () => ({ ok: true, value: configuration }),
    probeDatabase: options.probe ?? (async () => readyProbe),
    readStoreBinding: async () => {
      bindingReads += 1;
      return options.readBinding?.() ?? {
        ok: true,
        value: { deviceId: configuration.botDeviceId, storeFingerprint: "1".repeat(64) }
      };
    },
    createSupervisor: (input) => {
      supervisorOptions.push(input);
      return {} as never;
    },
    createRuntime: (input) => {
      runtimeInputs.push(input);
      return runtime;
    },
    ...(options.mediaConsumer === null ? {} : { mediaConsumer: options.mediaConsumer ?? defaultConsumer }),
    leaseOwner: () => "matrix-worker-test",
    clock,
    pollMilliseconds: 1_000,
    probeTimeoutMilliseconds: 5_000,
    stopTimeoutMilliseconds: 8_000
  });
  return {
    service,
    clock,
    runtime,
    outbox,
    receipts,
    supervisorOptions,
    runtimeInputs,
    bindingReads: () => bindingReads
  };
}

test("Preview is inert before parser, pool, filesystem, randomness, timers or sidecar dependencies", async () => {
  let touches = 0;
  const service = createGoDaddyMatrixService({
    environment: { RUNTIME_MODE: "development", GODADDY_STATE_DATABASE_ROLE: "published", MATRIX_ACCESS_TOKEN: "copied" },
    pool: {} as MySqlPool,
    registrarRuntime: {} as GoDaddyRegistrarRuntime
  }, {
    parseConfiguration: () => { touches += 1; throw new Error("must remain inert"); },
    probeDatabase: async () => { touches += 1; return readyProbe; },
    readStoreBinding: async () => { touches += 1; throw new Error("must remain inert"); },
    leaseOwner: () => { touches += 1; return "matrix-worker-test"; },
    clock: {
      now: () => { touches += 1; return FIXED_TIME; },
      setTimeout: () => { touches += 1; return 1; },
      clearTimeout: () => { touches += 1; }
    }
  });
  await service.start();
  service.wakeOutbox();
  await service.stop();
  assert.equal(service.configured, false);
  assert.deepEqual(service.getReadiness(), {
    configured: false,
    ready: false,
    reason: "matrix_disabled_for_runtime"
  });
  assert.equal(touches, 0);
});

test("Published startup fails closed before state or sidecar work when the shared publication fence is absent", async () => {
  let bindingReads = 0;
  const service = createGoDaddyMatrixService({
    environment: { RUNTIME_MODE: "production", GODADDY_STATE_DATABASE_ROLE: "published" },
    pool: {} as MySqlPool,
    registrarRuntime: {} as GoDaddyRegistrarRuntime
  }, {
    parseConfiguration: () => ({ ok: true, value: configuration }),
    readStoreBinding: async () => {
      bindingReads += 1;
      return { ok: true, value: { deviceId: configuration.botDeviceId, storeFingerprint: "1".repeat(64) } };
    }
  });
  await service.start();
  assert.deepEqual(service.getReadiness(), {
    configured: false,
    ready: false,
    reason: "publication_fence_unavailable"
  });
  assert.equal(bindingReads, 0);
});

test("a partially old schema is detected through metadata without DDL and prevents binding or spawn", async () => {
  const statements: string[] = [];
  let bindingReads = 0;
  const pool = {
    execute: async (statement: string): Promise<readonly [unknown, unknown]> => {
      statements.push(statement);
      return [[{
        tableName: "personal_consultant_state",
        columnName: "state_namespace",
        dataType: "varchar",
        columnType: "varchar(64)",
        collationName: "utf8mb4_bin"
      }], []];
    },
    getConnection: async () => { throw new Error("unused"); }
  } as unknown as MySqlPool;
  const service = createGoDaddyMatrixService({
    environment: { RUNTIME_MODE: "production", GODADDY_STATE_DATABASE_ROLE: "published" },
    pool,
    registrarRuntime: {} as GoDaddyRegistrarRuntime
  }, {
    parseConfiguration: () => ({ ok: true, value: configuration }),
    publicationSynchronizer: immediatePublicationSynchronizer,
    readStoreBinding: async () => {
      bindingReads += 1;
      return { ok: true, value: { deviceId: configuration.botDeviceId, storeFingerprint: "1".repeat(64) } };
    },
    leaseOwner: () => "matrix-worker-test",
    mediaConsumer: async ({ eventHash }) => ({ eventHash, consumptionReceiptHash: "9".repeat(64) })
  });
  await service.start();
  assert.deepEqual(service.getReadiness(), { configured: true, ready: false, reason: "schema_unavailable" });
  assert.equal(bindingReads, 0);
  assert.equal(statements.length, 3);
  assert.match(statements[0] ?? "", /information_schema\.COLUMNS/u);
  assert.match(statements[1] ?? "", /information_schema\.TABLES/u);
  assert.match(statements[2] ?? "", /information_schema\.STATISTICS/u);
  assert.doesNotMatch(statements.join("\n"), /\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/iu);
  await service.stop();
});

test("columns-correct but wrong InnoDB index order remains schema_unavailable before spawn", async () => {
  let bindingReads = 0;
  const statements: string[] = [];
  const pool = {
    execute: async (statement: string): Promise<readonly [unknown, unknown]> => {
      statements.push(statement);
      if (statement.includes("information_schema.COLUMNS")) return [currentSchemaColumns(), []];
      if (statement.includes("information_schema.TABLES")) return [[
        { tableName: "personal_consultant_state", engine: "InnoDB", tableType: "BASE TABLE" },
        { tableName: "personal_consultant_matrix_outbox", engine: "InnoDB", tableType: "BASE TABLE" },
        { tableName: "personal_consultant_matrix_ingress", engine: "InnoDB", tableType: "BASE TABLE" }
      ], []];
      if (statement.includes("information_schema.STATISTICS")) return [currentSchemaIndexes(true), []];
      throw new Error("Operational reads must not run against an invalid schema.");
    },
    getConnection: async () => { throw new Error("unused"); }
  } as unknown as MySqlPool;
  const service = createGoDaddyMatrixService({
    environment: { RUNTIME_MODE: "production", GODADDY_STATE_DATABASE_ROLE: "published" },
    pool,
    registrarRuntime: {} as GoDaddyRegistrarRuntime
  }, {
    parseConfiguration: () => ({ ok: true, value: configuration }),
    publicationSynchronizer: immediatePublicationSynchronizer,
    readStoreBinding: async () => {
      bindingReads += 1;
      return { ok: true, value: { deviceId: configuration.botDeviceId, storeFingerprint: "1".repeat(64) } };
    },
    leaseOwner: () => "matrix-worker-test",
    mediaConsumer: async ({ eventHash }) => ({ eventHash, consumptionReceiptHash: "9".repeat(64) })
  });
  await service.start();
  assert.deepEqual(service.getReadiness(), { configured: true, ready: false, reason: "schema_unavailable" });
  assert.equal(bindingReads, 0);
  assert.equal(statements.length, 3);
  await service.stop();
});

test("database/schema recovery gates exact store binding and passes bound identity into one runtime", async () => {
  let probes = 0;
  const h = harness({
    probe: async () => {
      probes += 1;
      return probes === 1 ? { ...readyProbe, schemaAvailable: false } : readyProbe;
    }
  });
  await h.service.start();
  assert.equal(h.bindingReads(), 0);
  assert.equal(h.runtime.starts, 0);
  assert.equal(h.service.getReadiness().reason, "schema_unavailable");
  await h.clock.advance(1_000);
  assert.equal(h.bindingReads(), 1);
  assert.equal(h.runtime.starts, 1);
  assert.deepEqual(h.runtime.lifecycleCalls, ["subscribe-ingress", "subscribe-rejection", "start"]);
  assert.equal(h.supervisorOptions[0]?.expectedIdentity.storeFingerprint, "1".repeat(64));
  assert.equal(h.supervisorOptions[0]?.expectedIdentity.botDeviceIdSha256, configuration.expectedIdentityHashes.botDeviceIdSha256);
  assert.deepEqual(h.supervisorOptions[0]?.argumentsList, ["--application-root", configuration.applicationRoot]);
  assert.equal(h.supervisorOptions[0]?.cwd, configuration.applicationRoot);
  assert.equal(h.service.getReadiness().ready, true);
  await h.service.stop();
});

test("a rejection-subscriber registration failure removes the ingress subscriber and stops the unstarted runtime", async () => {
  const runtime = new FakeMatrixRuntime();
  runtime.rejectionSubscriptionError = new Error("rejection subscription unavailable");
  const h = harness({ runtime });
  await h.service.start();
  assert.deepEqual(h.runtime.lifecycleCalls, ["subscribe-ingress", "subscribe-rejection"]);
  assert.equal(h.runtime.starts, 0);
  assert.equal(h.runtime.stops, 1);
  assert.equal(h.runtime.subscriber, undefined);
  assert.equal(h.runtime.rejectionSubscriber, undefined);
  assert.equal(h.runtime.ingressUnsubscriptions, 1);
  assert.equal(h.service.getReadiness().reason, "sidecar_not_ready");
  await h.service.stop();
});

test("ingress is serialized and deduped, commits the full intent before ACK, then records ACK evidence", async () => {
  const h = harness();
  const order: string[] = [];
  h.receipts.persistIntentImpl = async () => {
    order.push("persist");
    return { ok: true, replayed: false, durableAck: true, processed: false };
  };
  h.runtime.ackImpl = async () => { order.push("ack"); };
  h.receipts.acknowledgeImpl = async () => { order.push("evidence"); return true; };
  await h.service.start();
  await h.clock.flushDue();
  const event = ingress();
  assert.doesNotThrow(() => {
    h.runtime.emit(event);
    h.runtime.emit(event);
  });
  await h.clock.flushDue();
  assert.deepEqual(order, ["persist", "ack", "evidence"]);
  assert.equal(h.receipts.intents.length, 1);
  const persisted = h.receipts.intents[0] as { workIntent: { senderDeviceId: string } };
  assert.equal(persisted.workIntent.senderDeviceId, "OWNER_DEVICE_1");
  assert.equal(h.runtime.acknowledgements.length, 1);
  await h.service.stop();
});

test("secret-like ingress persists only content-free rejection hashes before ACK", async () => {
  const h = harness();
  const secret = `OPENAI_API_KEY=sk-${"x".repeat(32)}`;
  const order: string[] = [];
  h.receipts.persistRejectionImpl = async () => {
    order.push("reject");
    return { ok: true, replayed: false, durableAck: true, processed: false };
  };
  h.runtime.ackImpl = async () => { order.push("ack"); };
  await h.service.start();
  await h.clock.flushDue();
  h.runtime.emit(ingress({ body: secret }));
  await h.clock.flushDue();
  assert.deepEqual(order, ["reject", "ack"]);
  assert.equal(h.receipts.intents.length, 0);
  assert.equal(h.receipts.rejections.length, 1);
  assert.doesNotMatch(JSON.stringify(h.receipts.rejections[0]), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  await h.service.stop();
});

test("media expiry persists only content-free hashes before ACK and ACK evidence", async () => {
  const h = harness();
  const event = mediaIngress();
  const rejection = rejectionFor(event);
  const order: string[] = [];
  h.receipts.persistRejectionImpl = async () => {
    order.push("persist-rejection");
    return { ok: true, replayed: false, durableAck: true, processed: false };
  };
  h.runtime.ackImpl = async () => { order.push("ack"); };
  h.receipts.acknowledgeImpl = async () => { order.push("evidence"); return true; };
  await h.service.start();
  await h.clock.flushDue();
  h.runtime.emitRejection(rejection);
  await h.clock.flushDue();
  assert.deepEqual(order, ["persist-rejection", "ack", "evidence"]);
  assert.equal(h.receipts.intents.length, 0);
  assert.equal(h.receipts.rejections.length, 1);
  const persisted = h.receipts.rejections[0] as Readonly<Record<string, unknown>>;
  assert.deepEqual(Object.keys(persisted).sort(), [
    "bodyHash",
    "eventHash",
    "eventId",
    "mediaManifestHash",
    "now",
    "ownerMxid",
    "rejectionCode",
    "roomId"
  ]);
  assert.deepEqual({
    eventId: persisted.eventId,
    eventHash: persisted.eventHash,
    roomId: persisted.roomId,
    ownerMxid: persisted.ownerMxid,
    bodyHash: persisted.bodyHash,
    mediaManifestHash: persisted.mediaManifestHash,
    rejectionCode: persisted.rejectionCode
  }, {
    eventId: rejection.eventId,
    eventHash: rejection.eventHash,
    roomId: rejection.roomId,
    ownerMxid: rejection.senderMxid,
    bodyHash: rejection.bodyHash,
    mediaManifestHash: rejection.mediaManifestHash,
    rejectionCode: "media_expired"
  });
  assert.equal(h.runtime.mediaReads, 0);
  assert.deepEqual(h.runtime.acknowledgements, [{
    receiptId: rejection.receiptId,
    durableReceiptId: rejection.eventHash
  }]);
  await h.service.stop();
});

test("invalid media commits its explicit rejection before ACK and lets later valid ingress proceed", async () => {
  const h = harness();
  const rejection = rejectionFor(mediaIngress(), { reason: "invalid_media" });
  let commit!: () => void;
  const committed = new Promise<void>((resolve) => { commit = resolve; });
  h.receipts.persistRejectionImpl = async () => {
    await committed;
    return { ok: true, replayed: false, durableAck: true, processed: false };
  };
  await h.service.start();
  await h.clock.flushDue();
  h.runtime.emitRejection(rejection);
  await h.clock.flushDue();
  assert.equal(h.runtime.acknowledgements.length, 0);
  assert.equal(h.receipts.intents.length, 0);
  assert.equal(h.runtime.mediaReads, 0);
  commit();
  await h.clock.flushDue();
  assert.equal((h.receipts.rejections[0] as { rejectionCode: string }).rejectionCode, "invalid_media");
  assert.deepEqual(h.runtime.acknowledgements, [{ receiptId: rejection.receiptId, durableReceiptId: rejection.eventHash }]);
  h.runtime.emit(ingress({ receiptId: "receipt-next-valid", eventId: "$next-valid-event:matrix.org" }));
  await h.clock.flushDue();
  assert.equal(h.receipts.intents.length, 1);
  assert.equal(h.runtime.acknowledgements.length, 2);
  assert.equal(h.service.getReadiness().ready, true);
  await h.service.stop();
});

test("same-receipt media expiry replaces an in-flight unconsumed intent without reading expired media", async () => {
  const h = harness();
  const event = mediaIngress();
  const rejection = rejectionFor(event);
  const order: string[] = [];
  let signalPersistStarted: (() => void) | undefined;
  let finishPersist: (() => void) | undefined;
  const persistStarted = new Promise<void>((resolve) => { signalPersistStarted = resolve; });
  const persistGate = new Promise<void>((resolve) => { finishPersist = resolve; });
  h.receipts.persistIntentImpl = async () => {
    order.push("persist-intent-start");
    signalPersistStarted?.();
    await persistGate;
    order.push("persist-intent-done");
    return { ok: true, replayed: false, durableAck: false, processed: false };
  };
  h.receipts.persistRejectionImpl = async () => {
    order.push("persist-rejection");
    return { ok: true, replayed: true, durableAck: true, processed: false };
  };
  h.runtime.ackImpl = async () => { order.push("ack"); };
  await h.service.start();
  await h.clock.flushDue();
  h.runtime.emit(event);
  await h.clock.flushDue();
  await persistStarted;
  h.runtime.emitRejection(rejection);
  finishPersist?.();
  await h.clock.flushDue();
  assert.deepEqual(order, ["persist-intent-start", "persist-intent-done", "persist-rejection", "ack"]);
  assert.equal(h.receipts.intents.length, 1);
  assert.equal(h.receipts.rejections.length, 1);
  assert.equal(h.runtime.mediaReads, 0);
  assert.equal(h.runtime.acknowledgements.length, 1);
  await h.service.stop();
});

test("same-receipt expiry identity or hash conflict blocks ingress without persistence, media read or ACK", async () => {
  const h = harness();
  const event = mediaIngress();
  const conflicting = rejectionFor(event, { eventHash: "f".repeat(64) });
  await h.service.start();
  await h.clock.flushDue();
  h.runtime.emit(event);
  h.runtime.emitRejection(conflicting);
  await h.clock.flushDue();
  assert.deepEqual(h.service.getReadiness(), { configured: true, ready: false, reason: "ingress_blocked" });
  assert.equal(h.receipts.intents.length, 0);
  assert.equal(h.receipts.rejections.length, 0);
  assert.equal(h.runtime.mediaReads, 0);
  assert.equal(h.runtime.acknowledgements.length, 0);
  await h.service.stop();
});

test("media-expiry ACK evidence retries without repeating rejection persistence or sidecar ACK", async () => {
  const h = harness();
  let evidenceAttempts = 0;
  h.receipts.acknowledgeImpl = async () => {
    evidenceAttempts += 1;
    if (evidenceAttempts === 1) throw new Error("database temporarily unavailable");
    return true;
  };
  await h.service.start();
  await h.clock.flushDue();
  h.runtime.emitRejection(rejectionFor(mediaIngress()));
  await h.clock.flushDue();
  assert.equal(h.receipts.rejections.length, 1);
  assert.equal(h.runtime.acknowledgements.length, 1);
  assert.equal(evidenceAttempts, 1);
  await h.clock.advance(1_000);
  assert.equal(h.receipts.rejections.length, 1);
  assert.equal(h.runtime.acknowledgements.length, 1);
  assert.equal(evidenceAttempts, 2);
  await h.service.stop();
});

test("ACK evidence retries without repeating the already-applied sidecar ACK", async () => {
  const h = harness();
  let evidenceAttempts = 0;
  h.receipts.acknowledgeImpl = async () => {
    evidenceAttempts += 1;
    if (evidenceAttempts === 1) throw new Error("database temporarily unavailable");
    return true;
  };
  await h.service.start();
  await h.clock.flushDue();
  h.runtime.emit(ingress());
  await h.clock.flushDue();
  assert.equal(h.runtime.acknowledgements.length, 1);
  assert.equal(evidenceAttempts, 1);
  await h.clock.advance(1_000);
  assert.equal(h.runtime.acknowledgements.length, 1);
  assert.equal(evidenceAttempts, 2);
  await h.service.stop();
});

test("media never ACKs without a durable consumer", async () => {
  const h = harness({ mediaConsumer: null });
  h.receipts.persistIntentImpl = async () => ({ ok: true, replayed: false, durableAck: false, processed: false });
  await h.service.start();
  await h.clock.flushDue();
  h.runtime.emit(ingress({
    body: null,
    media: Object.freeze([{
      handle: `${"1".repeat(32)}-${"2".repeat(24)}.pdf`,
      declaredMime: "application/pdf",
      length: 8,
      sha256: "3".repeat(64)
    }])
  }));
  await h.clock.flushDue();
  assert.equal(h.receipts.intents.length, 1);
  assert.equal(h.runtime.acknowledgements.length, 0);
  assert.equal(h.service.getReadiness().reason, "media_consumer_unavailable");
  await h.service.stop();
});

test("media uses eventHash idempotency, caches its stable receipt across DB failure, and wipes bytes", async () => {
  const bytes = Buffer.from("%PDF-1.7", "ascii");
  const object = Object.freeze({
    handle: `${"1".repeat(32)}-${"2".repeat(24)}.pdf`,
    declaredMime: "application/pdf" as const,
    length: bytes.byteLength,
    sha256: "3".repeat(64),
    bytes
  });
  let consumerCalls = 0;
  let observedEventHash = "";
  let markerCalls = 0;
  const h = harness({
    mediaConsumer: async ({ eventHash, objects }) => {
      consumerCalls += 1;
      observedEventHash = eventHash;
      assert.equal(objects[0]?.bytes.toString("ascii"), "%PDF-1.7");
      return { eventHash, consumptionReceiptHash: "8".repeat(64) };
    }
  });
  h.runtime.readMediaImpl = async () => [object];
  h.receipts.persistIntentImpl = async () => ({ ok: true, replayed: false, durableAck: false, processed: false });
  h.receipts.markMediaConsumedImpl = async () => {
    markerCalls += 1;
    if (markerCalls === 1) throw new Error("commit response unavailable");
    return true;
  };
  await h.service.start();
  await h.clock.flushDue();
  h.runtime.emit(ingress({ body: null, media: Object.freeze([object]) }));
  await h.clock.flushDue();
  assert.match(observedEventHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual([...bytes], new Array(bytes.byteLength).fill(0));
  assert.equal(consumerCalls, 1);
  assert.equal(markerCalls, 1);
  assert.equal(h.runtime.acknowledgements.length, 0);
  await h.clock.advance(1_000);
  assert.equal(consumerCalls, 1);
  assert.equal(markerCalls, 2);
  assert.equal(h.runtime.acknowledgements.length, 1);
  await h.service.stop();
});

test("media buffers are wiped when the durable consumer throws", async () => {
  const bytes = Buffer.from("sensitive media", "utf8");
  const object = Object.freeze({
    handle: `${"1".repeat(32)}-${"2".repeat(24)}.pdf`,
    declaredMime: "application/pdf" as const,
    length: bytes.byteLength,
    sha256: "3".repeat(64),
    bytes
  });
  const h = harness({ mediaConsumer: async () => { throw new Error("consumer unavailable"); } });
  h.runtime.readMediaImpl = async () => [object];
  h.receipts.persistIntentImpl = async () => ({ ok: true, replayed: false, durableAck: false, processed: false });
  await h.service.start();
  await h.clock.flushDue();
  h.runtime.emit(ingress({ body: null, media: Object.freeze([object]) }));
  await h.clock.flushDue();
  assert.deepEqual([...bytes], new Array(bytes.byteLength).fill(0));
  assert.equal(h.runtime.acknowledgements.length, 0);
  await h.service.stop();
});

test("outbox inspects the strict head before a 60-second lease and publishes the deterministic transaction once", async () => {
  const h = harness();
  const record = lease();
  let inspections = 0;
  let leases = 0;
  h.outbox.inspectImpl = async () => (++inspections === 1 ? "available" : "idle");
  h.outbox.leaseImpl = async () => (++leases === 1 ? record : undefined);
  await h.service.start();
  await h.clock.flushDue();
  assert.deepEqual(h.outbox.calls.slice(0, 4), ["inspect", "lease", "markAccepted", "inspect"]);
  assert.equal(h.outbox.leases[0]?.leaseMilliseconds, 60_000);
  assert.equal(h.runtime.sent[0]?.transactionId, record.transactionId);
  assert.equal(h.outbox.accepted, 1);
  await h.service.stop();
});

test("a MySQL failure after Matrix acceptance never releases the lease for a fresh send", async () => {
  const h = harness();
  let inspections = 0;
  h.outbox.inspectImpl = async () => (++inspections === 1 ? "available" : "waiting");
  h.outbox.leaseImpl = async () => lease();
  h.outbox.markAcceptedImpl = async () => { throw new Error("commit response unavailable"); };
  await h.service.start();
  await h.clock.flushDue();
  assert.equal(h.runtime.sent.length, 1);
  assert.equal(h.outbox.accepted, 1);
  assert.equal(h.outbox.releases, 0);
  assert.equal(h.outbox.blocks, 0);
  await h.service.stop();
});

test("a publication that acquires the shared permit first completes acceptance before a generation fence", async () => {
  const synchronizer = new SerialPublicationSynchronizer();
  const h = harness({ publicationSynchronizer: synchronizer });
  const order: string[] = [];
  let inspections = 0;
  let finishSend: (() => void) | undefined;
  const sendGate = new Promise<void>((resolve) => { finishSend = resolve; });
  h.outbox.inspectImpl = async () => (++inspections === 1 ? "available" : "idle");
  h.outbox.leaseImpl = async () => lease();
  h.runtime.sendImpl = async (input) => {
    order.push("send-start");
    await sendGate;
    order.push("send-done");
    return { transactionId: input.transactionId, eventId: "$accepted-event:matrix.org", status: "accepted" };
  };
  h.outbox.markAcceptedImpl = async () => {
    order.push("mark-accepted");
    return { ok: true };
  };
  await h.service.start();
  await h.clock.flushDue();
  assert.deepEqual(order, ["send-start"]);
  const fenced = synchronizer.withGenerationFence({ generation: 1 }, async () => {
    order.push("fence");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["send-start"]);
  finishSend?.();
  await fenced;
  await h.clock.flushDue();
  assert.deepEqual(order, ["send-start", "send-done", "mark-accepted", "fence"]);
  await h.service.stop();
});

test("a generation fence that acquires first cancels pending work before the service can inspect or lease", async () => {
  const synchronizer = new SerialPublicationSynchronizer();
  const h = harness({ publicationSynchronizer: synchronizer });
  let releaseFence: (() => void) | undefined;
  let fenceStarted: (() => void) | undefined;
  const fenceGate = new Promise<void>((resolve) => { releaseFence = resolve; });
  const startedFence = new Promise<void>((resolve) => { fenceStarted = resolve; });
  h.outbox.inspectImpl = async () => "available";
  h.outbox.leaseImpl = async () => lease();
  const fenced = synchronizer.withGenerationFence({ generation: 1 }, async () => {
    fenceStarted?.();
    await fenceGate;
    h.outbox.inspectImpl = async () => "idle";
  });
  await startedFence;
  await h.service.start();
  await h.clock.flushDue();
  assert.equal(h.outbox.calls.length, 0);
  assert.equal(h.runtime.sent.length, 0);
  releaseFence?.();
  await fenced;
  await h.clock.flushDue();
  assert.deepEqual(h.outbox.calls, ["inspect"]);
  assert.equal(h.runtime.sent.length, 0);
  await h.service.stop();
});

test("send failures release only proven pre-dispatch leases and retain outcome-ambiguous leases", async () => {
  for (const scenario of ["pre-dispatch", "policy", "exhausted"] as const) {
    const h = harness();
    h.outbox.inspectImpl = async () => "available";
    h.outbox.leaseImpl = async () => lease(scenario === "exhausted" ? 8 : 1);
    h.runtime.sendImpl = async () => {
      throw new MatrixSidecarError(
        scenario === "policy" ? "policy_denied"
          : "request_limit"
      );
    };
    await h.service.start();
    await h.clock.flushDue();
    if (scenario === "pre-dispatch") {
      assert.equal(h.outbox.releases, 1);
      assert.equal(h.outbox.blocks, 0);
    } else if (scenario === "policy") {
      assert.equal(h.outbox.releases, 0);
      assert.equal(h.outbox.blocks, 1);
      assert.equal(h.service.getReadiness().ready, false);
    } else {
      assert.equal(h.outbox.releases, 0);
      assert.equal(h.outbox.blocks, 0);
      assert.equal(h.service.getReadiness().reason, "retry_exhausted");
    }
    await h.service.stop().catch(() => undefined);
  }

  for (const code of ["transport_failed", "request_timeout", "not_ready", "backpressure_timeout", "stopped"] as const) {
    const h = harness();
    h.outbox.inspectImpl = async () => "available";
    h.outbox.leaseImpl = async () => lease();
    h.runtime.sendImpl = async () => {
      h.outbox.inspectImpl = async () => "waiting";
      throw new MatrixSidecarError(code);
    };
    await h.service.start();
    await h.clock.flushDue();
    assert.equal(h.outbox.releases, 0, code);
    assert.equal(h.outbox.blocks, 0, code);
    assert.equal(h.service.getReadiness().reason, "sidecar_not_ready", code);
    assert.notEqual(h.runtime.subscriber, undefined, code);
    await h.service.stop().catch(() => undefined);
  }
});

test("lost acceptance stays fenced through a pre-dispatch retry failure and reconciles the same transaction", async () => {
  const h = harness();
  const publication = lease();
  const visibleEvents = new Map<string, string>();
  let leaseExpiresAt = 0;
  let leased = false;
  let accepted = false;
  let attempts = 0;
  h.outbox.inspectImpl = async () => accepted ? "idle"
    : leased && h.clock.now() < leaseExpiresAt ? "waiting" : "available";
  h.outbox.leaseImpl = async () => {
    leased = true;
    attempts += 1;
    leaseExpiresAt = h.clock.now() + 60_000;
    return { ...publication, attemptCount: attempts, leaseEpoch: attempts };
  };
  h.outbox.markAcceptedImpl = async () => {
    accepted = true;
    leased = false;
    return { ok: true };
  };
  h.runtime.sendImpl = async (input) => {
    if (attempts === 2) throw new MatrixSidecarError("request_limit");
    const eventId = visibleEvents.get(input.transactionId) ?? "$accepted-event:matrix.org";
    visibleEvents.set(input.transactionId, eventId);
    if (attempts === 1) {
      h.runtime.readiness = { liveness: "dead", matrixReadiness: "not_ready", reason: "crash_backoff", circuitOpen: false };
      throw new MatrixSidecarError("request_timeout");
    }
    return { transactionId: input.transactionId, eventId, status: "accepted" };
  };
  await h.service.start();
  await h.clock.flushDue();
  assert.equal(h.runtime.sent.length, 1);
  assert.equal(leased, true);
  assert.equal(h.outbox.releases, 0);
  assert.equal(h.outbox.blocks, 0);
  assert.equal(h.service.getReadiness().ready, false);
  assert.notEqual(h.runtime.subscriber, undefined);
  // Recovery alone must not bypass the outstanding lease/generation fence.
  h.runtime.readiness = { liveness: "alive", matrixReadiness: "ready", reason: "ready", circuitOpen: false };
  await h.clock.advance(59_999);
  h.service.wakeOutbox();
  await h.clock.flushDue();
  assert.equal(h.runtime.sent.length, 1);
  assert.equal(h.service.getReadiness().ready, false);
  await h.clock.advance(1_001);
  assert.equal(h.runtime.sent.length, 2);
  assert.equal(h.outbox.accepted, 0);
  assert.equal(h.outbox.releases, 0);
  assert.equal(h.outbox.blocks, 0);
  assert.equal(leased, true);
  assert.equal(h.service.getReadiness().ready, false);
  await h.clock.advance(60_000);
  assert.equal(h.runtime.sent.length, 3);
  assert.deepEqual(h.runtime.sent.map((input) => input.transactionId), Array(3).fill(publication.transactionId));
  assert.equal(visibleEvents.size, 1);
  assert.equal(h.outbox.accepted, 1);
  assert.equal(leased, false);
  assert.equal(h.service.getReadiness().ready, true);
  h.runtime.emit(ingress());
  await h.clock.flushDue();
  assert.equal(h.receipts.intents.length, 1);
  assert.equal(h.runtime.acknowledgements.length, 1);
  await h.service.stop();
});

test("exhausted ambiguous publication remains fenced and stops retrying", async () => {
  const h = harness();
  h.outbox.inspectImpl = async () => "available";
  h.outbox.leaseImpl = async () => lease(8);
  h.runtime.sendImpl = async () => { throw new MatrixSidecarError("transport_failed"); };
  await h.service.start();
  await h.clock.flushDue();
  assert.equal(h.service.getReadiness().reason, "retry_exhausted");
  assert.equal(h.outbox.releases, 0);
  assert.equal(h.outbox.blocks, 0);
  await h.clock.advance(120_000);
  h.service.wakeOutbox();
  await h.clock.flushDue();
  assert.equal(h.runtime.sent.length, 1);
  await h.service.stop();
});

test("policy denial on a reclaimed lease preserves any prior acceptance fence", async () => {
  const h = harness();
  h.outbox.inspectImpl = async () => "available";
  h.outbox.leaseImpl = async () => lease(2);
  h.runtime.sendImpl = async () => { throw new MatrixSidecarError("policy_denied"); };
  await h.service.start();
  await h.clock.flushDue();
  assert.equal(h.service.getReadiness().reason, "outbox_blocked");
  assert.equal(h.outbox.releases, 0);
  assert.equal(h.outbox.blocks, 0);
  await h.service.stop();
});

test("stop blocks new intake, drains the current ACK/evidence, then stops the sidecar exactly once", async () => {
  const h = harness();
  let finishEvidence: (() => void) | undefined;
  let finishRuntimeStop: (() => void) | undefined;
  const evidence = new Promise<void>((resolve) => { finishEvidence = resolve; });
  const runtimeDrain = new Promise<void>((resolve) => { finishRuntimeStop = resolve; });
  const order: string[] = [];
  h.receipts.acknowledgeImpl = async () => {
    order.push("evidence-start");
    await evidence;
    order.push("evidence-done");
    finishRuntimeStop?.();
    return true;
  };
  h.runtime.stopImpl = async () => {
    order.push("runtime-stop-start");
    await runtimeDrain;
    order.push("runtime-stop-done");
  };
  await h.service.start();
  await h.clock.flushDue();
  h.runtime.emit(ingress());
  await h.clock.flushDue();
  const stopped = h.service.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.runtime.stops, 1);
  assert.deepEqual(order, ["evidence-start", "runtime-stop-start"]);
  h.runtime.emit(ingress({ receiptId: "receipt-0002", eventId: "$event-0002:matrix.org" }));
  finishEvidence?.();
  await stopped;
  assert.deepEqual(order, ["evidence-start", "runtime-stop-start", "evidence-done", "runtime-stop-done"]);
  assert.equal(h.runtime.stops, 1);
  assert.equal(h.receipts.intents.length, 1);
  await h.service.stop();
  assert.equal(h.runtime.stops, 1);
});

test("stop drains cancelled zero-delay ingress and leaves not-yet-leased outbox work durable", async () => {
  const h = harness();
  await h.service.start();
  await h.clock.flushDue();
  h.outbox.inspectImpl = async () => h.outbox.accepted === 0 ? "available" : "idle";
  h.outbox.leaseImpl = async () => lease();
  h.runtime.emit(ingress());
  h.runtime.emit(ingress({ receiptId: "receipt-0002", eventId: "$event-0002:matrix.org" }));
  h.service.wakeOutbox();

  await h.service.stop();

  assert.equal(h.receipts.intents.length, 2);
  assert.equal(h.runtime.acknowledgements.length, 2);
  assert.equal(h.runtime.sent.length, 0);
  assert.equal(h.outbox.accepted, 0);
  assert.equal(h.runtime.stops, 1);
});

test("stop drains an active expiry receipt, ignores new intake, and removes both runtime subscribers", async () => {
  const h = harness();
  const order: string[] = [];
  let signalPersistStarted: (() => void) | undefined;
  let finishPersist: (() => void) | undefined;
  let finishRuntimeStop: (() => void) | undefined;
  const persistStarted = new Promise<void>((resolve) => { signalPersistStarted = resolve; });
  const persistGate = new Promise<void>((resolve) => { finishPersist = resolve; });
  const runtimeDrain = new Promise<void>((resolve) => { finishRuntimeStop = resolve; });
  h.receipts.persistRejectionImpl = async () => {
    order.push("persist-start");
    signalPersistStarted?.();
    await persistGate;
    order.push("persist-done");
    return { ok: true, replayed: false, durableAck: true, processed: false };
  };
  h.runtime.ackImpl = async () => { order.push("ack"); };
  h.receipts.acknowledgeImpl = async () => {
    order.push("evidence");
    finishRuntimeStop?.();
    return true;
  };
  h.runtime.stopImpl = async () => {
    order.push("runtime-stop-start");
    await runtimeDrain;
    order.push("runtime-stop-done");
  };
  await h.service.start();
  await h.clock.flushDue();
  h.runtime.emitRejection(rejectionFor(mediaIngress()));
  await h.clock.flushDue();
  await persistStarted;
  const stopping = h.service.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.runtime.stops, 1);
  assert.deepEqual(order, ["persist-start", "runtime-stop-start"]);
  h.runtime.emitRejection(rejectionFor(mediaIngress({
    receiptId: "receipt-0002",
    eventId: "$event-0002:matrix.org"
  })));
  finishPersist?.();
  await stopping;
  assert.deepEqual(order, ["persist-start", "runtime-stop-start", "persist-done", "ack", "evidence", "runtime-stop-done"]);
  assert.equal(h.receipts.rejections.length, 1);
  assert.equal(h.runtime.acknowledgements.length, 1);
  assert.equal(h.runtime.subscriber, undefined);
  assert.equal(h.runtime.rejectionSubscriber, undefined);
});

test("stop racing an unresolved store read cannot resume startup or spawn afterward", async () => {
  let releaseBinding: (() => void) | undefined;
  const bindingGate = new Promise<void>((resolve) => { releaseBinding = resolve; });
  const h = harness({
    readBinding: async () => {
      await bindingGate;
      return { ok: true, value: { deviceId: configuration.botDeviceId, storeFingerprint: "1".repeat(64) } };
    }
  });
  const starting = h.service.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.bindingReads(), 1);
  const stopping = h.service.stop();
  releaseBinding?.();
  await Promise.all([starting, stopping]);
  assert.equal(h.supervisorOptions.length, 0);
  assert.equal(h.runtime.starts, 0);
  assert.equal(h.service.getReadiness().reason, "stopped");
});
