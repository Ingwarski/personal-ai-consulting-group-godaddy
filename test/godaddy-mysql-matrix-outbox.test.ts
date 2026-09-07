import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import {
  MySqlAtomicRegistrarStorage,
  MySqlMatrixIngressReceipts,
  MySqlMatrixOutbox,
  MatrixIngressCorruptionError,
  MatrixOutboxCorruptionError
} from "../src/godaddy/mysql-matrix-outbox.ts";
import type { MySqlConnection, MySqlPool } from "../src/godaddy/mysql-storage.ts";
import { confirmedMessageFingerprint } from "../src/session/registrar-do.ts";

const jsonHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ingressEventHash = (intent: Readonly<{
  eventId: string;
  roomId: string;
  ownerMxid: string;
  senderDeviceId: string;
  body: string | null;
  relationEventId?: string;
  media: readonly unknown[];
}>): string => jsonHash({
  eventId: intent.eventId,
  roomId: intent.roomId,
  senderMxid: intent.ownerMxid,
  senderDeviceId: intent.senderDeviceId,
  encrypted: true,
  bodyHash: jsonHash(intent.body),
  relationEventId: intent.relationEventId ?? null,
  mediaManifestHash: jsonHash(intent.media)
});

const replyToEventId = "$owner-event-0001";
const canonicalBodyHash = await confirmedMessageFingerprint({
  role: "Стратег",
  body: "Канонічний текст.",
  replyToEventId
});
const message = {
  generation: 1,
  sequence: 1,
  internalEventId: "agent-message-event-0001",
  role: "Стратег",
  visibleTime: "12:00",
  body: "Канонічний текст.",
  bodyFormat: "markdown" as const,
  bodyHash: canonicalBodyHash,
  confirmedAt: "2026-09-04T12:00:00.000Z"
};
const canonicalTransactionId = `pc-1-1-${message.bodyHash.slice(0, 24)}`;
const canonicalDeliveryHash = jsonHash({
  generation: 1,
  sequence: 1,
  transactionId: canonicalTransactionId,
  recordKind: "message",
  message: {
    generation: message.generation,
    sequence: message.sequence,
    internalEventId: message.internalEventId,
    role: message.role,
    visibleTime: message.visibleTime,
    body: message.body,
    bodyFormat: message.bodyFormat,
    addressedTo: null,
    bodyHash: message.bodyHash,
    confirmedAt: message.confirmedAt
  },
  replyToEventId,
  createdAt: message.confirmedAt
});

const canonicalOutboxRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  generation: 1,
  sequenceNo: 1,
  transactionId: canonicalTransactionId,
  state: "pending",
  recordKind: "message",
  messageJson: JSON.stringify(message),
  bodyHash: message.bodyHash,
  deliveryHash: canonicalDeliveryHash,
  replyToEventId,
  leaseOwner: null,
  leaseEpoch: 0,
  leaseExpiresAt: null,
  attemptCount: 0,
  availableAt: "2026-09-04T12:00:00.000Z",
  createdAt: message.confirmedAt,
  ...overrides
});

class ScriptedConnection implements MySqlConnection {
  readonly #execute: (statement: string, values: readonly unknown[]) => Promise<readonly [unknown, unknown]>;
  commits = 0;
  rollbacks = 0;

  constructor(execute: (statement: string, values: readonly unknown[]) => Promise<readonly [unknown, unknown]>) {
    this.#execute = execute;
  }

  async beginTransaction() {}
  async commit() { this.commits += 1; }
  async rollback() { this.rollbacks += 1; }
  release() {}
  execute(statement: string, values: readonly unknown[]) {
    assertTimestampBoundary(statement, values);
    return this.#execute(statement, values);
  }
}

// These scripted tests do not run MySQL's parser. Enforce the production SQL
// boundary explicitly, so an ISO-Z value cannot silently pass a fake executor.
function assertTimestampBoundary(statement: string, values: readonly unknown[]): void {
  if (!statement.startsWith("UPDATE personal_consultant_matrix_")) return;
  const offset = statement.indexOf("updated_at = ");
  assert.notEqual(offset, -1);
  assert.match(statement.slice(offset), /^updated_at = REPLACE\(\?, 'Z', '\+00:00'\)/u);
  const parameter = (statement.slice(0, offset).match(/\?/gu) ?? []).length;
  assert.match(String(values[parameter]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
}

class ScriptedPool implements MySqlPool {
  readonly connection: ScriptedConnection;
  readonly direct: (statement: string, values: readonly unknown[]) => Promise<readonly [unknown, unknown]>;

  constructor(input: Readonly<{
    transaction: (statement: string, values: readonly unknown[]) => Promise<readonly [unknown, unknown]>;
    direct?: (statement: string, values: readonly unknown[]) => Promise<readonly [unknown, unknown]>;
  }>) {
    this.connection = new ScriptedConnection(input.transaction);
    this.direct = input.direct ?? input.transaction;
  }

  async getConnection() { return this.connection; }
  execute(statement: string, values: readonly unknown[]) {
    assertTimestampBoundary(statement, values);
    return this.direct(statement, values);
  }
}

test("same-process registrar transactions queue before borrowing the bounded pool", async () => {
  let connectionBorrows = 0;
  let releaseFirst: (() => void) | undefined;
  let signalFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const connection: MySqlConnection = Object.freeze({
    execute: async () => [[], []] as const,
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined
  });
  const pool: MySqlPool = Object.freeze({
    execute: async () => [[], []] as const,
    getConnection: async () => {
      connectionBorrows += 1;
      return connection;
    }
  });
  const storage = new MySqlAtomicRegistrarStorage({ executor: pool, namespace: "registrar-v1" });
  const first = storage.transaction(async () => {
    signalFirstStarted?.();
    await firstGate;
  });
  await firstStarted;
  const second = storage.transaction(async () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(connectionBorrows, 1);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.equal(connectionBorrows, 2);
});

test("leases only the strict outbox head and preserves its deterministic transaction ID across crash retry", async () => {
  let leaseUpdates = 0;
  const now = new Date("2026-09-04T12:00:00.000Z");
  const pool = new ScriptedPool({
    transaction: async (statement) => {
      if (statement.startsWith("SELECT generation")) return [[canonicalOutboxRow({
        state: "leased",
        leaseOwner: "previous-worker",
        leaseEpoch: 4,
        leaseExpiresAt: "2026-09-04T11:59:59.000Z",
        attemptCount: 4
      })], []];
      if (statement.startsWith("UPDATE personal_consultant_matrix_outbox")) {
        leaseUpdates += 1;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    }
  });
  const outbox = new MySqlMatrixOutbox(pool);
  const leased = await outbox.leaseHead({ leaseOwner: "node-worker-01", now, leaseMilliseconds: 30_000 });
  assert.equal(leased?.transactionId, `pc-1-1-${message.bodyHash.slice(0, 24)}`);
  assert.equal(leased?.leaseEpoch, 5);
  assert.equal(leased?.replyToEventId, replyToEventId);
  assert.equal(leased?.attemptCount, 5);
  assert.equal(leaseUpdates, 1);
  assert.equal(pool.connection.commits, 1);
});

test("leases identity-bound critic messages and rejects altered, malformed or stripped authority", async () => {
  const authority = { agentId: "critic", provider: "codex" as const, runtimeSessionRef: "thread-critic-01", kind: "critique" as const };
  const bodyHash = await confirmedMessageFingerprint({ role: message.role, body: message.body, replyToEventId, authority });
  const identityMessage = { ...message, bodyHash, authority };
  const transactionId = `pc-1-1-${bodyHash.slice(0, 24)}`;
  const deliveryHash = jsonHash({ generation: 1, sequence: 1, transactionId, recordKind: "message",
    message: { generation: 1, sequence: 1, internalEventId: identityMessage.internalEventId, role: identityMessage.role,
      visibleTime: identityMessage.visibleTime, body: identityMessage.body, bodyFormat: identityMessage.bodyFormat,
      addressedTo: null, bodyHash, confirmedAt: identityMessage.confirmedAt }, replyToEventId, createdAt: identityMessage.confirmedAt });
  for (const [caseName, candidate] of [
    ["valid", identityMessage],
    ["mysql-key-order", { ...identityMessage, authority: {
      kind: authority.kind, agentId: authority.agentId, provider: authority.provider, runtimeSessionRef: authority.runtimeSessionRef
    } }],
    ["changed", { ...identityMessage, authority: { ...authority, runtimeSessionRef: "thread-other" } }],
    ["unknown-field", { ...identityMessage, authority: { ...authority, token: "must-be-rejected" } }],
    ["stripped", { ...message, bodyHash }]
  ] as const) {
    const pool = new ScriptedPool({ transaction: async (statement) => {
      if (statement.startsWith("SELECT generation")) return [[canonicalOutboxRow({ transactionId, bodyHash, deliveryHash, messageJson: JSON.stringify(candidate) })], []];
      if (statement.startsWith("UPDATE personal_consultant_matrix_outbox")) return [{ affectedRows: 1 }, []];
      throw new Error("Unexpected SQL");
    } });
    const pending = new MySqlMatrixOutbox(pool).leaseHead({ leaseOwner: "node-worker-01", now: new Date(message.confirmedAt), leaseMilliseconds: 30_000 });
    if (caseName === "valid" || caseName === "mysql-key-order") assert.deepEqual((await pending)?.message.authority, authority);
    else await assert.rejects(pending, MatrixOutboxCorruptionError);
  }
});

test("a blocked strict head intentionally halts all later publication, as does an active head lease", async () => {
  for (const row of [
    canonicalOutboxRow({ state: "blocked", leaseEpoch: 1 }),
    canonicalOutboxRow({
      state: "leased",
      leaseOwner: "previous-worker",
      leaseEpoch: 1,
      leaseExpiresAt: "2026-09-04T12:01:00.000Z"
    })
  ]) {
    let updates = 0;
    const pool = new ScriptedPool({
      transaction: async (statement) => {
        if (statement.startsWith("SELECT generation")) return [[row], []];
        updates += 1;
        return [{ affectedRows: 1 }, []];
      }
    });
    const leased = await new MySqlMatrixOutbox(pool).leaseHead({
      leaseOwner: "node-worker-01",
      now: new Date("2026-09-04T12:00:00.000Z"),
      leaseMilliseconds: 30_000
    });
    assert.equal(leased, undefined);
    assert.equal(updates, 0);
  }
});

test("head inspection distinguishes idle, waiting, available, blocked and corrupt state without leasing", async () => {
  const now = new Date("2026-09-04T12:00:00.000Z");
  const cases = [
    { row: undefined, expected: "idle" },
    {
      row: canonicalOutboxRow({ availableAt: "2026-09-04T12:00:01.000Z" }),
      expected: "waiting"
    },
    { row: canonicalOutboxRow(), expected: "available" },
    { row: canonicalOutboxRow({ state: "blocked", leaseEpoch: 1 }), expected: "blocked" },
    {
      row: canonicalOutboxRow({
        state: "leased",
        leaseOwner: "previous-worker",
        leaseEpoch: 1,
        leaseExpiresAt: "2026-09-04T11:59:59.000Z"
      }),
      expected: "available"
    },
    { row: canonicalOutboxRow({ availableAt: "not-a-timestamp" }), expected: "corrupt" }
  ] as const;

  for (const { row, expected } of cases) {
    let transactions = 0;
    const pool = new ScriptedPool({
      transaction: async () => {
        transactions += 1;
        return [[], []];
      },
      direct: async (statement) => {
        assert.match(statement, /^SELECT generation/u);
        return [row === undefined ? [] : [row], []];
      }
    });
    assert.equal(await new MySqlMatrixOutbox(pool).inspectHead(now), expected);
    assert.equal(transactions, 0);
  }
});

test("delivery digest rejects visible-time or record-kind relabeling under the same transaction ID", async () => {
  for (const row of [
    canonicalOutboxRow({ messageJson: JSON.stringify({ ...message, visibleTime: "12:01" }) }),
    canonicalOutboxRow({ recordKind: "control" })
  ]) {
    const pool = new ScriptedPool({
      transaction: async () => { throw new Error("unused"); },
      direct: async () => [[row], []]
    });
    assert.equal(
      await new MySqlMatrixOutbox(pool).inspectHead(new Date("2026-09-04T12:00:00.000Z")),
      "corrupt"
    );
  }
});

test("recomputes every leased row and quarantines canonical corruption before send", async () => {
  let quarantined = false;
  const pool = new ScriptedPool({
    transaction: async (statement) => {
      if (statement.startsWith("SELECT generation")) return [[canonicalOutboxRow({
        messageJson: JSON.stringify({ ...message, body: "tampered" })
      })], []];
      if (statement.includes("last_error_code = 'outbox_corrupt'")) {
        quarantined = true;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    }
  });
  await assert.rejects(
    new MySqlMatrixOutbox(pool).leaseHead({ leaseOwner: "node-worker-01", now: new Date(), leaseMilliseconds: 30_000 }),
    MatrixOutboxCorruptionError
  );
  assert.equal(quarantined, true);
  assert.equal(pool.connection.commits, 1);
  assert.equal(pool.connection.rollbacks, 0);
});

test("quarantines a canonical row whose real formatted Matrix envelope exceeds the runtime limit", async () => {
  const escapedBody = "<".repeat(40_000);
  const bodyHash = await confirmedMessageFingerprint({ role: "Стратег", body: escapedBody });
  const oversizedMessage = { ...message, body: escapedBody, bodyHash };
  let quarantined = false;
  const pool = new ScriptedPool({
    transaction: async (statement) => {
      if (statement.startsWith("SELECT generation")) return [[canonicalOutboxRow({
        transactionId: `pc-1-1-${bodyHash.slice(0, 24)}`,
        messageJson: JSON.stringify(oversizedMessage),
        bodyHash
      })], []];
      if (statement.includes("last_error_code = 'outbox_corrupt'")) {
        quarantined = true;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    }
  });
  await assert.rejects(
    new MySqlMatrixOutbox(pool).leaseHead({ leaseOwner: "node-worker-01", now: new Date(), leaseMilliseconds: 30_000 }),
    MatrixOutboxCorruptionError
  );
  assert.equal(quarantined, true);
  assert.equal(pool.connection.commits, 1);
});

test("accepted, device-delivered and read are separate fenced transitions", async () => {
  const statements: string[] = [];
  const pool = new ScriptedPool({
    transaction: async () => [[], []],
    direct: async (statement) => {
      statements.push(statement);
      return [{ affectedRows: 1 }, []];
    }
  });
  const policy = {
    roomId: "!consultant:matrix.org",
    ownerMxid: "@owner:matrix.org",
    ownerDeviceIds: ["OWNER_DEVICE_1"],
    maxAgeMilliseconds: 60_000,
    now: () => new Date("2026-09-04T12:00:30.000Z"),
    verifyEvidence: async () => true
  };
  const outbox = new MySqlMatrixOutbox(pool, policy);
  const lease = {
    generation: 1,
    sequence: 1,
    transactionId: "pc-1-1-aaaaaaaaaaaaaaaaaaaaaaaa",
    message,
    leaseOwner: "node-worker-01",
    leaseEpoch: 2,
    attemptCount: 1
  };
  assert.deepEqual(await outbox.markAccepted(lease, "$matrix-event-accepted", new Date()), { ok: true });
  const evidenceBase = {
    evidenceId: "receipt-evidence-0001",
    matrixEventId: "$matrix-event-accepted",
    roomId: "!consultant:matrix.org",
    ownerMxid: "@owner:matrix.org",
    ownerDeviceId: "OWNER_DEVICE_1",
    observedAt: "2026-09-04T12:00:00.000Z"
  };
  const deliveredWithoutHash = { kind: "device_delivery" as const, ...evidenceBase };
  const delivered = { ...deliveredWithoutHash, evidenceHash: jsonHash(deliveredWithoutHash) };
  const readWithoutHash = { kind: "owner_read" as const, ...evidenceBase, evidenceId: "receipt-evidence-0002" };
  const read = { ...readWithoutHash, evidenceHash: jsonHash(readWithoutHash) };
  assert.equal(await new MySqlMatrixOutbox(pool).markDeviceDelivered(delivered), false);
  assert.equal(await outbox.markDeviceDelivered({ ...delivered, ownerDeviceId: "UNTRUSTED_DEVICE" }), false);
  assert.equal(await outbox.markDeviceDelivered({ ...delivered, evidenceHash: "d".repeat(64) }), false);
  assert.equal(await outbox.markDeviceDelivered(delivered), true);
  assert.equal(await outbox.markRead(read), true);
  assert.match(statements[0] ?? "", /state = 'accepted'/);
  assert.match(statements[1] ?? "", /state = 'device_delivered'/);
  assert.match(statements[2] ?? "", /state = 'read'/);
});

test("an invalid Matrix acceptance ID is rejected before touching durable state", async () => {
  let writes = 0;
  const pool = new ScriptedPool({
    transaction: async () => [[], []],
    direct: async () => {
      writes += 1;
      return [{ affectedRows: 1 }, []];
    }
  });
  await assert.rejects(new MySqlMatrixOutbox(pool).markAccepted({
    generation: 1,
    sequence: 1,
    transactionId: "pc-1-1-aaaaaaaaaaaaaaaaaaaaaaaa",
    message,
    leaseOwner: "node-worker-01",
    leaseEpoch: 2,
    attemptCount: 1
  }, "not-a-matrix-event", new Date()), MatrixOutboxCorruptionError);
  assert.equal(writes, 0);
});

test("ingress receipt and work intent commit before ACK, then lease idempotent consumer work", async () => {
  let state: "ready" | "leased" | "processed" | undefined;
  let acked = false;
  let epoch = 0;
  const bodyHash = jsonHash("Текст");
  const mediaManifestHash = jsonHash([]);
  const workIntent = {
    eventId: "$owner-event-0001", roomId: "!consultant:matrix.org",
    ownerMxid: "@owner:matrix.org", senderDeviceId: "OWNER_DEVICE_1", body: "Текст", media: []
  } as const;
  const eventHash = ingressEventHash(workIntent);
  const pool = new ScriptedPool({
    transaction: async (statement, values) => {
      if (statement.startsWith("SELECT event_id") && statement.includes("WHERE event_id")) return [[{
        ...(state === undefined ? {} : {
          eventId: values[0], eventHash, state, leaseOwner: null, leaseEpoch: epoch, leaseExpiresAt: null,
          roomId: workIntent.roomId, ownerMxid: workIntent.ownerMxid, bodyHash, mediaManifestHash,
          workIntentJson: JSON.stringify(workIntent), ackEligibleAt: "2026-09-04T12:00:00.000Z",
          mediaConsumptionReceiptHash: null, mediaConsumedAt: null
        })
      }].filter((row) => "eventId" in row), []];
      if (statement.startsWith("INSERT INTO personal_consultant_matrix_ingress")) {
        state = "ready";
        return [{ affectedRows: 1 }, []];
      }
      if (statement.startsWith("SELECT event_id")) return [[{
        eventId: "$owner-event-0001", eventHash, state, leaseOwner: null, leaseEpoch: epoch, leaseExpiresAt: null,
        roomId: workIntent.roomId, ownerMxid: workIntent.ownerMxid, bodyHash, mediaManifestHash,
        workIntentJson: JSON.stringify(workIntent), ackEligibleAt: "2026-09-04T12:00:00.000Z",
        mediaConsumptionReceiptHash: null, mediaConsumedAt: null
      }], []];
      if (statement.includes("SET state = 'leased'")) {
        state = "leased";
        epoch += 1;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected transaction SQL: ${statement}`);
    },
    direct: async (statement) => {
      if (statement.includes("SET state = 'processed'")) {
        state = "processed";
        return [{ affectedRows: 1 }, []];
      }
      if (statement.includes("acknowledged_at")) {
        acked = true;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected direct SQL: ${statement}`);
    }
  });
  const receipts = new MySqlMatrixIngressReceipts(pool);
  const first = await receipts.persistIntent({
    eventId: "$owner-event-0001",
    eventHash,
    roomId: "!consultant:matrix.org",
    ownerMxid: "@owner:matrix.org",
    bodyHash,
    workIntent,
    mediaManifestHash,
    requiresMediaConsumption: false,
    now: new Date("2026-09-04T12:00:00.000Z")
  });
  assert.deepEqual(first, { ok: true, replayed: false, durableAck: true, processed: false });
  const replayBeforeDispatch = await receipts.persistIntent({
    eventId: "$owner-event-0001", eventHash, roomId: "!consultant:matrix.org",
    ownerMxid: "@owner:matrix.org", bodyHash, workIntent, mediaManifestHash,
    requiresMediaConsumption: false,
    now: new Date("2026-09-04T12:00:00.500Z")
  });
  assert.deepEqual(replayBeforeDispatch, { ok: true, replayed: true, durableAck: true, processed: false });
  const lease = await receipts.leaseNext({
    leaseOwner: "node-worker-01",
    now: new Date("2026-09-04T12:00:01.000Z"),
    leaseMilliseconds: 30_000
  });
  assert.equal(lease?.eventId, "$owner-event-0001");
  assert.equal(await receipts.markProcessed({
    eventId: "$owner-event-0001", eventHash, leaseOwner: "node-worker-01", leaseEpoch: 1,
    sessionId: "task-1",
    generation: 1,
    now: new Date("2026-09-04T12:00:02.000Z")
  }), true);
  assert.equal(await receipts.acknowledge("$owner-event-0001", eventHash, new Date("2026-09-04T12:00:03.000Z")), true);
  assert.equal(state, "processed");
  assert.equal(acked, true);
});

test("media ingress persists nullable body, reply relation and metadata but withholds ACK until durable consumption", async () => {
  const media = [{ declaredMime: "application/pdf" as const, length: 4096, sha256: "d".repeat(64) }];
  const workIntent = {
    eventId: "$owner-media-event-0001", roomId: "!consultant:matrix.org", ownerMxid: "@owner:matrix.org",
    senderDeviceId: "OWNER_DEVICE_1", body: null, relationEventId: "$owner-reply-event-0001", media
  } as const;
  const bodyHash = jsonHash(null);
  const mediaManifestHash = jsonHash(media);
  const eventHash = ingressEventHash(workIntent);
  let stored = false;
  let consumed = false;
  const consumptionReceiptHash = "e".repeat(64);
  const pool = new ScriptedPool({
    transaction: async (statement, values) => {
      if (statement.startsWith("SELECT event_id") && statement.includes("WHERE event_id")) {
        if (!stored) return [[], []];
        return [[{
          eventId: workIntent.eventId, eventHash, state: "ready", roomId: workIntent.roomId,
          ownerMxid: workIntent.ownerMxid, bodyHash, mediaManifestHash, workIntentJson: JSON.stringify(workIntent),
          ackEligibleAt: consumed ? "2026-09-04T12:00:02.000Z" : null,
          mediaConsumptionReceiptHash: consumed ? consumptionReceiptHash : null,
          mediaConsumedAt: consumed ? "2026-09-04T12:00:02.000Z" : null
        }], []];
      }
      if (statement.startsWith("INSERT INTO personal_consultant_matrix_ingress")) {
        stored = true;
        return [{ affectedRows: 1 }, []];
      }
      if (statement.includes("media_consumption_receipt_hash = ?")) {
        consumed = true;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected transaction SQL: ${statement} ${JSON.stringify(values)}`);
    },
    direct: async () => [{ affectedRows: consumed ? 1 : 0 }, []]
  });
  const receipts = new MySqlMatrixIngressReceipts(pool);
  const persisted = await receipts.persistIntent({
    eventId: workIntent.eventId, eventHash, roomId: workIntent.roomId,
    ownerMxid: workIntent.ownerMxid, bodyHash, workIntent, mediaManifestHash,
    requiresMediaConsumption: true, now: new Date("2026-09-04T12:00:00.000Z")
  });
  assert.deepEqual(persisted, { ok: true, replayed: false, durableAck: false, processed: false });
  assert.equal(await receipts.acknowledge(workIntent.eventId, eventHash, new Date()), false);
  assert.equal(await receipts.markMediaConsumed({
    eventId: workIntent.eventId, eventHash, mediaManifestHash,
    consumptionReceiptHash, now: new Date("2026-09-04T12:00:02.000Z")
  }), true);
  const replay = await receipts.persistIntent({
    eventId: workIntent.eventId, eventHash, roomId: workIntent.roomId,
    ownerMxid: workIntent.ownerMxid, bodyHash, workIntent, mediaManifestHash,
    requiresMediaConsumption: true, now: new Date("2026-09-04T12:00:03.000Z")
  });
  assert.deepEqual(replay, { ok: true, replayed: true, durableAck: true, processed: false });
});

test("a blocked or corrupted existing ingress row cannot become durable ACK on replay", async () => {
  const workIntent = {
    eventId: "$owner-replay-event-0001",
    roomId: "!consultant:matrix.org",
    ownerMxid: "@owner:matrix.org",
    senderDeviceId: "OWNER_DEVICE_1",
    body: "Текст",
    media: []
  } as const;
  const bodyHash = jsonHash(workIntent.body);
  const mediaManifestHash = jsonHash(workIntent.media);
  const eventHash = ingressEventHash(workIntent);
  for (const row of [
    {
      state: "blocked",
      workIntentJson: JSON.stringify(workIntent),
      ackEligibleAt: "2026-09-04T12:00:00.000Z"
    },
    {
      state: "ready",
      workIntentJson: JSON.stringify({ ...workIntent, senderDeviceId: "OTHER_DEVICE" }),
      ackEligibleAt: "2026-09-04T12:00:00.000Z"
    }
  ]) {
    const pool = new ScriptedPool({
      transaction: async (statement) => {
        assert.match(statement, /^SELECT event_id/u);
        return [[{
          eventId: workIntent.eventId,
          eventHash,
          roomId: workIntent.roomId,
          ownerMxid: workIntent.ownerMxid,
          bodyHash,
          mediaManifestHash,
          ...row
        }], []];
      }
    });
    assert.deepEqual(await new MySqlMatrixIngressReceipts(pool).persistIntent({
      eventId: workIntent.eventId,
      eventHash,
      roomId: workIntent.roomId,
      ownerMxid: workIntent.ownerMxid,
      bodyHash,
      workIntent,
      mediaManifestHash,
      requiresMediaConsumption: false,
      now: new Date("2026-09-04T12:00:01.000Z")
    }), { ok: false, code: "event_conflict" });
  }
});

test("persists a content-free rejected ingress receipt that is ACK eligible but never dispatchable", async () => {
  let storedIntent: unknown;
  let acknowledged = false;
  const pool = new ScriptedPool({
    transaction: async (statement, values) => {
      if (statement.startsWith("SELECT event_id")) return [[], []];
      if (statement.includes("VALUES (?, ?, 'rejected'")) {
        storedIntent = JSON.parse(String(values[6]));
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected transaction SQL: ${statement}`);
    },
    direct: async (statement) => {
      assert.match(statement, /state IN \('ready', 'leased', 'processed', 'rejected'\)/u);
      acknowledged = true;
      return [{ affectedRows: 1 }, []];
    }
  });
  const receipts = new MySqlMatrixIngressReceipts(pool);
  const result = await receipts.persistRejection({
    eventId: "$owner-secret-event-0001",
    eventHash: "a".repeat(64),
    roomId: "!consultant:matrix.org",
    ownerMxid: "@owner:matrix.org",
    bodyHash: "b".repeat(64),
    mediaManifestHash: "c".repeat(64),
    rejectionCode: "secret_like_content",
    now: new Date("2026-09-04T12:00:00.000Z")
  });
  assert.deepEqual(result, { ok: true, replayed: false, durableAck: true, processed: false });
  assert.deepEqual(storedIntent, { rejectionCode: "secret_like_content" });
  assert.equal(await receipts.acknowledge(
    "$owner-secret-event-0001",
    "a".repeat(64),
    new Date("2026-09-04T12:00:01.000Z")
  ), true);
  assert.equal(acknowledged, true);
});

test("invalid media stores one content-free rejection across replay and never becomes work", async () => {
  const input = {
    eventId: "$invalid-media-event-0001",
    eventHash: "a".repeat(64),
    roomId: "!consultant:matrix.org",
    ownerMxid: "@owner:matrix.org",
    bodyHash: "b".repeat(64),
    mediaManifestHash: "c".repeat(64),
    rejectionCode: "invalid_media" as const,
    now: new Date("2026-09-04T12:00:00.000Z")
  };
  let row: Readonly<Record<string, unknown>> | undefined;
  let inserts = 0;
  const pool = new ScriptedPool({ transaction: async (statement, values) => {
    if (statement.startsWith("SELECT event_id")) {
      if (statement.includes("state IN ('ready', 'leased')")) return [[], []];
      return [row === undefined ? [] : [row], []];
    }
    if (statement.includes("VALUES (?, ?, 'rejected'")) {
      inserts += 1;
      row = {
        ...input, state: "rejected", workIntentJson: String(values[6]),
        ackEligibleAt: input.now.toISOString()
      };
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  } });
  const receipts = new MySqlMatrixIngressReceipts(pool);
  assert.deepEqual(await receipts.persistRejection(input), { ok: true, replayed: false, durableAck: true, processed: false });
  assert.deepEqual(await receipts.persistRejection(input), { ok: true, replayed: true, durableAck: true, processed: false });
  assert.equal(inserts, 1);
  assert.deepEqual(JSON.parse(String(row?.workIntentJson)), { rejectionCode: "invalid_media" });
  assert.equal(await receipts.leaseNext({ leaseOwner: "node-worker-test", now: input.now, leaseMilliseconds: 30_000 }), undefined);
  assert.deepEqual(await receipts.persistRejection({ ...input, rejectionCode: "media_expired" }), { ok: false, code: "event_conflict" });
  // A contradictory rejection must never erase previously accepted work.
  row = { ...row, state: "ready" };
  assert.deepEqual(await receipts.persistRejection(input), { ok: false, code: "event_conflict" });
  assert.equal(inserts, 1);
});

test("media expiry durably replaces only the exact unconsumed ready intent before ACK", async () => {
  const media = [{ declaredMime: "application/pdf" as const, length: 128, sha256: "d".repeat(64) }];
  const intent = {
    eventId: "$owner-media-expired-0001",
    roomId: "!consultant:matrix.org",
    ownerMxid: "@owner:matrix.org",
    senderDeviceId: "OWNER_DEVICE_1",
    body: "Attachment",
    media
  };
  const bodyHash = jsonHash(intent.body);
  const mediaManifestHash = jsonHash(media);
  const eventHash = ingressEventHash(intent);
  let replacement: unknown;
  const pool = new ScriptedPool({
    transaction: async (statement, values) => {
      if (statement.startsWith("SELECT event_id")) return [[{
        eventId: intent.eventId,
        eventHash,
        state: "ready",
        roomId: intent.roomId,
        ownerMxid: intent.ownerMxid,
        bodyHash,
        mediaManifestHash,
        workIntentJson: JSON.stringify(intent),
        ackEligibleAt: null,
        mediaConsumptionReceiptHash: null,
        mediaConsumedAt: null
      }], []];
      if (statement.includes("SET state = 'rejected'")) {
        replacement = JSON.parse(String(values[0]));
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    }
  });
  assert.deepEqual(await new MySqlMatrixIngressReceipts(pool).persistRejection({
    eventId: intent.eventId,
    eventHash,
    roomId: intent.roomId,
    ownerMxid: intent.ownerMxid,
    bodyHash,
    mediaManifestHash,
    rejectionCode: "media_expired",
    now: new Date("2026-09-04T12:15:00.000Z")
  }), { ok: true, replayed: true, durableAck: true, processed: false });
  assert.deepEqual(replacement, { rejectionCode: "media_expired" });
  assert.equal(pool.connection.commits, 1);
});

test("media expiry leaves an already-consumed durable intent intact and ACK eligible", async () => {
  const media = [{ declaredMime: "image/png" as const, length: 64, sha256: "e".repeat(64) }];
  const intent = {
    eventId: "$owner-media-consumed-0001",
    roomId: "!consultant:matrix.org",
    ownerMxid: "@owner:matrix.org",
    senderDeviceId: "OWNER_DEVICE_1",
    body: null,
    media
  };
  const bodyHash = jsonHash(intent.body);
  const mediaManifestHash = jsonHash(media);
  const eventHash = ingressEventHash(intent);
  const consumptionReceiptHash = "f".repeat(64);
  let updates = 0;
  const pool = new ScriptedPool({
    transaction: async (statement) => {
      if (statement.startsWith("SELECT event_id")) return [[{
        eventId: intent.eventId,
        eventHash,
        state: "processed",
        roomId: intent.roomId,
        ownerMxid: intent.ownerMxid,
        bodyHash,
        mediaManifestHash,
        workIntentJson: JSON.stringify(intent),
        ackEligibleAt: "2026-09-04T12:01:00.000Z",
        mediaConsumptionReceiptHash: consumptionReceiptHash,
        mediaConsumedAt: "2026-09-04T12:01:00.000Z"
      }], []];
      updates += 1;
      return [{ affectedRows: 1 }, []];
    }
  });
  assert.deepEqual(await new MySqlMatrixIngressReceipts(pool).persistRejection({
    eventId: intent.eventId,
    eventHash,
    roomId: intent.roomId,
    ownerMxid: intent.ownerMxid,
    bodyHash,
    mediaManifestHash,
    rejectionCode: "media_expired",
    now: new Date("2026-09-04T12:16:00.000Z")
  }), { ok: true, replayed: true, durableAck: true, processed: false });
  assert.equal(updates, 0);
});

test("replayed rejection requires its exact content-free code and canonical ACK timestamp", async () => {
  for (const row of [
    { workIntentJson: JSON.stringify({ rejectionCode: "secret_like_content" }), ackEligibleAt: "2026-09-04T12:00:00.000Z" },
    { workIntentJson: JSON.stringify({ rejectionCode: "media_expired", extra: true }), ackEligibleAt: "2026-09-04T12:00:00.000Z" },
    { workIntentJson: JSON.stringify({ rejectionCode: "media_expired" }), ackEligibleAt: "not-canonical" }
  ]) {
    const pool = new ScriptedPool({
      transaction: async () => [[{
        eventId: "$owner-media-rejection-0001",
        eventHash: "a".repeat(64),
        state: "rejected",
        roomId: "!consultant:matrix.org",
        ownerMxid: "@owner:matrix.org",
        bodyHash: "b".repeat(64),
        mediaManifestHash: "c".repeat(64),
        ...row
      }], []]
    });
    assert.deepEqual(await new MySqlMatrixIngressReceipts(pool).persistRejection({
      eventId: "$owner-media-rejection-0001",
      eventHash: "a".repeat(64),
      roomId: "!consultant:matrix.org",
      ownerMxid: "@owner:matrix.org",
      bodyHash: "b".repeat(64),
      mediaManifestHash: "c".repeat(64),
      rejectionCode: "media_expired",
      now: new Date("2026-09-04T12:15:00.000Z")
    }), { ok: false, code: "event_conflict" });
  }
});

test("an unconsumed media intent remains the strict ingress head and cannot be leased", async () => {
  let leaseUpdates = 0;
  const media = [{ declaredMime: "image/png" as const, length: 64, sha256: "e".repeat(64) }];
  const intent = {
    eventId: "$owner-media-event-0002",
    roomId: "!consultant:matrix.org",
    ownerMxid: "@owner:matrix.org",
    senderDeviceId: "OWNER_DEVICE_1",
    body: null,
    media
  };
  const bodyHash = jsonHash(intent.body);
  const mediaManifestHash = jsonHash(media);
  const eventHash = ingressEventHash(intent);
  const pool = new ScriptedPool({
    transaction: async (statement) => {
      if (statement.startsWith("SELECT event_id")) return [[{
        eventId: intent.eventId, eventHash, state: "ready", roomId: intent.roomId,
        ownerMxid: intent.ownerMxid, bodyHash, mediaManifestHash, workIntentJson: JSON.stringify(intent),
        leaseOwner: null, leaseEpoch: 0, leaseExpiresAt: null, ackEligibleAt: null,
        mediaConsumptionReceiptHash: null, mediaConsumedAt: null
      }], []];
      leaseUpdates += 1;
      return [{ affectedRows: 1 }, []];
    }
  });
  assert.equal(await new MySqlMatrixIngressReceipts(pool).leaseNext({
    leaseOwner: "node-worker-01", now: new Date(), leaseMilliseconds: 30_000
  }), undefined);
  assert.equal(leaseUpdates, 0);
});

test("media consumption cannot mutate a rejected row while ACK evidence remains lease-safe", async () => {
  let consumeStatement = "";
  let acknowledgeStatement = "";
  const pool = new ScriptedPool({
    transaction: async (statement) => {
      if (statement.includes("media_consumption_receipt_hash = ?")) {
        consumeStatement = statement;
        return [{ affectedRows: 0 }, []];
      }
      if (statement.startsWith("SELECT event_id")) {
        return [[{
          eventHash: "a".repeat(64),
          mediaManifestHash: "b".repeat(64),
          mediaConsumptionReceiptHash: null,
          ackEligibleAt: "2026-09-04T12:00:00.000Z",
          state: "rejected"
        }], []];
      }
      throw new Error(`Unexpected transaction SQL: ${statement}`);
    },
    direct: async (statement) => {
      acknowledgeStatement = statement;
      return [{ affectedRows: 1 }, []];
    }
  });
  const receipts = new MySqlMatrixIngressReceipts(pool);
  assert.equal(await receipts.markMediaConsumed({
    eventId: "$owner-media-rejected-0001",
    eventHash: "a".repeat(64),
    mediaManifestHash: "b".repeat(64),
    consumptionReceiptHash: "c".repeat(64),
    now: new Date("2026-09-04T12:00:01.000Z")
  }), false);
  assert.match(consumeStatement, /state = 'ready'/u);
  assert.equal(await receipts.acknowledge(
    "$owner-media-rejected-0001",
    "a".repeat(64),
    new Date("2026-09-04T12:00:02.000Z")
  ), true);
  assert.match(acknowledgeStatement, /state IN \('ready', 'leased', 'processed', 'rejected'\)/u);
});

test("quarantines a durable ingress intent containing an ephemeral handle or mismatched metadata", async () => {
  const bodyHash = jsonHash(null);
  const media = [{ declaredMime: "image/png", length: 128, sha256: "f".repeat(64), handle: "ephemeral-1" }];
  let quarantined = false;
  const pool = new ScriptedPool({
    transaction: async (statement) => {
      if (statement.startsWith("SELECT event_id") && !statement.includes("WHERE event_id")) return [[{
        eventId: "$corrupt-media-event-0001", eventHash: "a".repeat(64), state: "ready", leaseEpoch: 0,
        ackEligibleAt: "2026-09-04T12:00:00.000Z",
        roomId: "!consultant:matrix.org", ownerMxid: "@owner:matrix.org", bodyHash,
        mediaManifestHash: jsonHash(media), workIntentJson: JSON.stringify({
          eventId: "$corrupt-media-event-0001", roomId: "!consultant:matrix.org", ownerMxid: "@owner:matrix.org",
          senderDeviceId: "OWNER_DEVICE_1", body: null, media
        })
      }], []];
      if (statement.includes("SET state = 'leased'")) return [{ affectedRows: 1 }, []];
      if (statement.includes("SET state = 'blocked'")) {
        quarantined = true;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    }
  });
  await assert.rejects(
    new MySqlMatrixIngressReceipts(pool).leaseNext({ leaseOwner: "node-worker-01", now: new Date(), leaseMilliseconds: 30_000 }),
    MatrixIngressCorruptionError
  );
  assert.equal(quarantined, true);
  assert.equal(pool.connection.commits, 1);
  assert.equal(pool.connection.rollbacks, 0);
});

test("schema uses binary comparison for byte-significant IDs, hashes, keys and lease owners", async () => {
  const schema = await readFile(new URL("../scripts/godaddy-state-schema.sql", import.meta.url), "utf8");
  assert.match(schema, /state_key VARCHAR\(191\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin/);
  assert.match(schema, /event_id VARCHAR\(255\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin/);
  assert.match(schema, /transaction_id VARCHAR\(128\) CHARACTER SET ascii COLLATE ascii_bin/);
  assert.match(schema, /body_hash CHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin/);
  assert.match(schema, /delivery_hash CHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/);
  assert.match(schema, /media_manifest_hash CHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin/);
  assert.match(schema, /lease_owner VARCHAR\(128\) CHARACTER SET ascii COLLATE ascii_bin/);
  assert.match(schema, /ack_eligible_at VARCHAR\(64\) NULL/);
  assert.match(schema, /ENUM\('ready', 'leased', 'processed', 'rejected', 'blocked'\)/u);
});
