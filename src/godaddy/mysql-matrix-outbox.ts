import type {
  ConfirmedMessageOutboxProjection,
  MatrixOutboxRecord,
  MatrixOutboxState
} from "../session/registrar-do.ts";
import { confirmedMessageFingerprint, isConfirmedAgentAuthority, matrixTransactionIdFor } from "../session/registrar-do.ts";
import { confirmedMessageFitsMatrixRuntimeLimits } from "../matrix/bridge.ts";
import type { RegistrarStorage } from "../session/storage.ts";
import { GODADDY_STATE_TABLE, type MySqlConnection, type MySqlPool } from "./mysql-storage.ts";

export const GODADDY_MATRIX_OUTBOX_TABLE = "personal_consultant_matrix_outbox";
export const GODADDY_MATRIX_INGRESS_TABLE = "personal_consultant_matrix_ingress";

type Executor = Pick<MySqlPool, "execute"> | Pick<MySqlConnection, "execute">;
type Row = Readonly<Record<string, unknown>>;

class AsyncSerialGate {
  #tail: Promise<void> = Promise.resolve();

  async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    const predecessor = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const registrarTransactionGates = new WeakMap<object, Map<string, AsyncSerialGate>>();

function registrarTransactionGate(pool: MySqlPool, namespace: string): AsyncSerialGate {
  let byNamespace = registrarTransactionGates.get(pool);
  if (byNamespace === undefined) {
    byNamespace = new Map();
    registrarTransactionGates.set(pool, byNamespace);
  }
  let gate = byNamespace.get(namespace);
  if (gate === undefined) {
    gate = new AsyncSerialGate();
    byNamespace.set(namespace, gate);
  }
  return gate;
}

const SELECT_STATE_FOR_UPDATE = `SELECT state_value AS stateValue FROM ${GODADDY_STATE_TABLE} WHERE state_namespace = ? AND state_key = ? LIMIT 1 FOR UPDATE`;
const SELECT_STATE = `SELECT state_value AS stateValue FROM ${GODADDY_STATE_TABLE} WHERE state_namespace = ? AND state_key = ? LIMIT 1`;
const UPSERT_STATE = `INSERT INTO ${GODADDY_STATE_TABLE} (state_namespace, state_key, state_value)
  VALUES (?, ?, CAST(? AS JSON))
  ON DUPLICATE KEY UPDATE state_value = VALUES(state_value), updated_at = UTC_TIMESTAMP(6)`;

const INSERT_OUTBOX = `INSERT INTO ${GODADDY_MATRIX_OUTBOX_TABLE}
  (generation, sequence_no, transaction_id, state, record_kind, message_json, body_hash, delivery_hash,
   reply_to_event_id, available_at, created_at)
  VALUES (?, ?, ?, 'pending', ?, CAST(? AS JSON), ?, ?, ?, ?, ?)`;
const SELECT_HEAD = `SELECT generation, sequence_no AS sequenceNo, transaction_id AS transactionId,
  state, record_kind AS recordKind, message_json AS messageJson, body_hash AS bodyHash,
  delivery_hash AS deliveryHash, reply_to_event_id AS replyToEventId,
  created_at AS createdAt, lease_owner AS leaseOwner, lease_epoch AS leaseEpoch,
  lease_expires_at AS leaseExpiresAt, matrix_event_id AS matrixEventId, attempt_count AS attemptCount,
  available_at AS availableAt
  FROM ${GODADDY_MATRIX_OUTBOX_TABLE}
  WHERE state IN ('pending', 'leased', 'blocked')
  ORDER BY generation ASC, sequence_no ASC LIMIT 1`;
const SELECT_HEAD_FOR_UPDATE = `${SELECT_HEAD} FOR UPDATE`;
const LEASE_OUTBOX = `UPDATE ${GODADDY_MATRIX_OUTBOX_TABLE}
  SET state = 'leased', lease_owner = ?, lease_epoch = lease_epoch + 1,
      lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
  WHERE generation = ? AND sequence_no = ? AND lease_epoch = ?`;
const ACCEPT_OUTBOX = `UPDATE ${GODADDY_MATRIX_OUTBOX_TABLE}
  SET state = 'accepted', matrix_event_id = ?, accepted_at = ?, lease_owner = NULL,
      lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
  WHERE generation = ? AND sequence_no = ? AND state = 'leased' AND lease_owner = ? AND lease_epoch = ?`;
const BLOCK_OUTBOX = `UPDATE ${GODADDY_MATRIX_OUTBOX_TABLE}
  SET state = 'blocked', last_error_code = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
  WHERE generation = ? AND sequence_no = ? AND state = 'leased' AND lease_owner = ? AND lease_epoch = ?`;
const RELEASE_OUTBOX = `UPDATE ${GODADDY_MATRIX_OUTBOX_TABLE}
  SET state = 'pending', available_at = ?, last_error_code = ?, lease_owner = NULL,
      lease_expires_at = NULL, updated_at = ?
  WHERE generation = ? AND sequence_no = ? AND state = 'leased' AND lease_owner = ? AND lease_epoch = ?`;
const QUARANTINE_OUTBOX = `UPDATE ${GODADDY_MATRIX_OUTBOX_TABLE}
  SET state = 'blocked', last_error_code = 'outbox_corrupt', lease_owner = NULL,
      lease_expires_at = NULL, updated_at = ?
  WHERE generation = ? AND sequence_no = ? AND state IN ('pending', 'leased')`;
const FENCE_GENERATION = `UPDATE ${GODADDY_MATRIX_OUTBOX_TABLE}
  SET state = 'cancelled', last_error_code = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
  WHERE generation = ? AND record_kind = 'message' AND state IN ('pending', 'blocked')`;
const DEVICE_DELIVERED = `UPDATE ${GODADDY_MATRIX_OUTBOX_TABLE}
  SET state = 'device_delivered', device_delivery_evidence_id = ?, device_delivery_evidence_hash = ?,
      device_delivered_at = ?, updated_at = ?
  WHERE matrix_event_id = ? AND state = 'accepted'`;
const READ_OUTBOX = `UPDATE ${GODADDY_MATRIX_OUTBOX_TABLE}
  SET state = 'read', read_evidence_id = ?, read_evidence_hash = ?, read_at = ?, updated_at = ?
  WHERE matrix_event_id = ? AND state IN ('accepted', 'device_delivered')`;

const ENSURE_REGISTRAR_LOCK = `INSERT IGNORE INTO ${GODADDY_STATE_TABLE} (state_namespace, state_key, state_value)
  VALUES (?, 'registrar:transaction-lock', CAST('{"version":1}' AS JSON))`;
const LOCK_REGISTRAR = `SELECT state_key FROM ${GODADDY_STATE_TABLE}
  WHERE state_namespace = ? AND state_key = 'registrar:transaction-lock' FOR UPDATE`;

const INSERT_INGRESS = `INSERT INTO ${GODADDY_MATRIX_INGRESS_TABLE}
  (event_id, event_hash, state, room_id, owner_mxid, body_hash, media_manifest_hash,
   work_intent_json, ack_eligible_at, received_at)
  VALUES (?, ?, 'ready', ?, ?, ?, ?, CAST(? AS JSON), ?, ?)`;
const INSERT_REJECTED_INGRESS = `INSERT INTO ${GODADDY_MATRIX_INGRESS_TABLE}
  (event_id, event_hash, state, room_id, owner_mxid, body_hash, media_manifest_hash,
   work_intent_json, ack_eligible_at, received_at)
  VALUES (?, ?, 'rejected', ?, ?, ?, ?, CAST(? AS JSON), ?, ?)`;
const EXPIRE_MEDIA_INGRESS = `UPDATE ${GODADDY_MATRIX_INGRESS_TABLE}
  SET state = 'rejected', work_intent_json = CAST(? AS JSON), ack_eligible_at = ?,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
  WHERE event_id = ? AND event_hash = ? AND state = 'ready' AND ack_eligible_at IS NULL`;
const SELECT_INGRESS_FOR_UPDATE = `SELECT event_id AS eventId, event_hash AS eventHash, state,
  room_id AS roomId, owner_mxid AS ownerMxid, body_hash AS bodyHash,
  lease_owner AS leaseOwner, lease_epoch AS leaseEpoch, lease_expires_at AS leaseExpiresAt,
  work_intent_json AS workIntentJson, media_manifest_hash AS mediaManifestHash,
  ack_eligible_at AS ackEligibleAt, media_consumption_receipt_hash AS mediaConsumptionReceiptHash,
  media_consumed_at AS mediaConsumedAt, session_id AS sessionId, generation,
  acknowledged_at AS acknowledgedAt
  FROM ${GODADDY_MATRIX_INGRESS_TABLE} WHERE event_id = ? LIMIT 1 FOR UPDATE`;
const SELECT_INGRESS_HEAD_FOR_UPDATE = `SELECT event_id AS eventId, event_hash AS eventHash, state,
  room_id AS roomId, owner_mxid AS ownerMxid,
  lease_owner AS leaseOwner, lease_epoch AS leaseEpoch, lease_expires_at AS leaseExpiresAt,
  work_intent_json AS workIntentJson, body_hash AS bodyHash,
  media_manifest_hash AS mediaManifestHash, ack_eligible_at AS ackEligibleAt,
  media_consumption_receipt_hash AS mediaConsumptionReceiptHash, media_consumed_at AS mediaConsumedAt
  FROM ${GODADDY_MATRIX_INGRESS_TABLE} WHERE state IN ('ready', 'leased')
  ORDER BY received_at ASC, event_id ASC LIMIT 1 FOR UPDATE`;
const LEASE_INGRESS = `UPDATE ${GODADDY_MATRIX_INGRESS_TABLE}
  SET state = 'leased', lease_owner = ?, lease_epoch = lease_epoch + 1, lease_expires_at = ?, updated_at = ?
  WHERE event_id = ? AND lease_epoch = ? AND state IN ('ready', 'leased')`;
const REGISTER_INGRESS = `UPDATE ${GODADDY_MATRIX_INGRESS_TABLE}
  SET state = 'processed', session_id = ?, generation = ?, lease_owner = NULL,
      lease_expires_at = NULL, updated_at = ?
  WHERE event_id = ? AND event_hash = ? AND state = 'leased' AND lease_owner = ? AND lease_epoch = ?`;
const ACK_INGRESS = `UPDATE ${GODADDY_MATRIX_INGRESS_TABLE}
  SET acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ?
  WHERE event_id = ? AND event_hash = ? AND ack_eligible_at IS NOT NULL
    AND state IN ('ready', 'leased', 'processed', 'rejected')`;
const CONSUME_INGRESS_MEDIA = `UPDATE ${GODADDY_MATRIX_INGRESS_TABLE}
  SET media_consumption_receipt_hash = ?, media_consumed_at = ?, ack_eligible_at = ?, updated_at = ?
  WHERE event_id = ? AND event_hash = ? AND media_manifest_hash = ?
    AND state = 'ready' AND (media_consumption_receipt_hash IS NULL OR media_consumption_receipt_hash = ?)`;
const QUARANTINE_INGRESS = `UPDATE ${GODADDY_MATRIX_INGRESS_TABLE}
  SET state = 'blocked', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
  WHERE event_id = ? AND state IN ('ready', 'leased')`;

function rowsOf(result: unknown): readonly Row[] {
  if (!Array.isArray(result)) return [];
  return result.filter((value): value is Row => typeof value === "object" && value !== null && !Array.isArray(value));
}

function affectedRows(result: unknown): number {
  if (typeof result !== "object" || result === null || !("affectedRows" in result)) return 0;
  return typeof result.affectedRows === "number" ? result.affectedRows : 0;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return JSON.parse(value) as unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function isoTimestampMillis(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : undefined;
}

function retryableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Readonly<{ code?: unknown; errno?: unknown }>;
  return candidate.code === "ER_LOCK_DEADLOCK" || candidate.code === "ER_LOCK_WAIT_TIMEOUT" ||
    candidate.errno === 1_213 || candidate.errno === 1_205;
}

async function inTransaction<T>(
  pool: MySqlPool,
  operation: (connection: MySqlConnection) => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      if (!retryableTransactionError(error) || attempt === maxAttempts) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 5));
    } finally {
      connection.release();
    }
  }
  throw new Error("Unreachable transaction retry state.");
}

/**
 * Registrar key/value state and Matrix outbox projection share this exact
 * connection. A failed outbox insert therefore rolls back the confirmed
 * message, event ledger and sequence increment as one MySQL transaction.
 */
export class MySqlAtomicRegistrarStorage implements RegistrarStorage {
  readonly #executor: Executor;
  readonly #pool: MySqlPool | undefined;
  readonly #namespace: string;
  readonly #transactionGate: AsyncSerialGate | undefined;

  constructor(input: Readonly<{ executor: MySqlPool | MySqlConnection; namespace: string }>) {
    this.#executor = input.executor;
    this.#pool = "getConnection" in input.executor ? input.executor : undefined;
    this.#namespace = input.namespace;
    this.#transactionGate = this.#pool === undefined
      ? undefined
      : registrarTransactionGate(this.#pool, this.#namespace);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const [rows] = await this.#executor.execute(this.#pool === undefined ? SELECT_STATE_FOR_UPDATE : SELECT_STATE, [this.#namespace, key]);
    const row = rowsOf(rows)[0];
    if (row === undefined) return undefined;
    return parseJson(row.stateValue) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Registrar state cannot be serialized.");
    await this.#executor.execute(UPSERT_STATE, [this.#namespace, key, serialized]);
  }

  async transaction<T>(operation: (storage: RegistrarStorage) => Promise<T>): Promise<T> {
    if (this.#pool === undefined) return operation(this);
    const pool = this.#pool;
    const gate = this.#transactionGate;
    if (gate === undefined) throw new Error("Registrar transaction gate is unavailable.");
    // Do not let same-process requests occupy the bounded pool while waiting
    // for the registrar row. Besides reducing lock contention, this preserves
    // one connection for a publication callback that already owns the global
    // advisory lock and prevents a Stop/publication pool-exhaustion cycle.
    return gate.run(() => inTransaction(pool, async (connection) => {
        // Every Registrar mutation takes the same row first. This gives first
        // append, generation change and Stop a stable lock order, while the
        // bounded outer retry handles MySQL deadlock/lock-timeout victims.
        await connection.execute(ENSURE_REGISTRAR_LOCK, [this.#namespace]);
        await connection.execute(LOCK_REGISTRAR, [this.#namespace]);
        return operation(new MySqlAtomicRegistrarStorage({
          executor: connection,
          namespace: this.#namespace
        }));
      }));
  }

  async insertOutboxRecord(record: MatrixOutboxRecord): Promise<void> {
    if (!confirmedMessageFitsMatrixRuntimeLimits(record.message)) {
      throw new Error("Confirmed message exceeds the Matrix runtime delivery envelope limits.");
    }
    const deliveryHash = await matrixOutboxDeliveryFingerprint(record);
    await this.#executor.execute(INSERT_OUTBOX, [
      record.generation,
      record.sequence,
      record.transactionId,
      record.kind,
      JSON.stringify(record.message),
      record.message.bodyHash,
      deliveryHash,
      record.replyToEventId ?? null,
      record.createdAt,
      record.createdAt
    ]);
  }

  async fenceGeneration(generation: number, reason: "stopped" | "new_task", fencedAt: string): Promise<void> {
    await this.#executor.execute(FENCE_GENERATION, [reason, fencedAt, generation]);
  }
}

export const projectConfirmedMessageToMySqlOutbox: ConfirmedMessageOutboxProjection = async (storage, record) => {
  if (!(storage instanceof MySqlAtomicRegistrarStorage)) {
    throw new Error("Matrix outbox projection requires the registrar transaction connection.");
  }
  await storage.insertOutboxRecord(record);
};

export async function fenceMySqlOutboxGeneration(
  storage: RegistrarStorage,
  input: Readonly<{ generation: number; reason: "stopped" | "new_task"; fencedAt: string }>
): Promise<void> {
  if (!(storage instanceof MySqlAtomicRegistrarStorage)) {
    throw new Error("Matrix outbox fencing requires the registrar transaction connection.");
  }
  await storage.fenceGeneration(input.generation, input.reason, input.fencedAt);
}

export type LeasedMatrixOutboxRecord = Readonly<{
  generation: number;
  sequence: number;
  transactionId: string;
  message: MatrixOutboxRecord["message"];
  replyToEventId?: string;
  leaseOwner: string;
  leaseEpoch: number;
  attemptCount: number;
}>;

export type OutboxMutationResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: "stale_lease" }>;

export class MatrixOutboxCorruptionError extends Error {
  readonly code = "matrix_outbox_corrupt" as const;
}

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

async function jsonSha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const allowedConfirmedMessageKeys = new Set([
  "generation", "sequence", "internalEventId", "role", "visibleTime", "body", "bodyFormat",
  "addressedTo", "bodyHash", "confirmedAt", "authority"
]);

async function matrixOutboxDeliveryFingerprint(record: Pick<
  MatrixOutboxRecord,
  "generation" | "sequence" | "transactionId" | "kind" | "message" | "replyToEventId" | "createdAt"
>): Promise<string> {
  const message = record.message;
  return jsonSha256({
    generation: record.generation,
    sequence: record.sequence,
    transactionId: record.transactionId,
    recordKind: record.kind,
    message: {
      generation: message.generation,
      sequence: message.sequence,
      internalEventId: message.internalEventId,
      role: message.role,
      visibleTime: message.visibleTime,
      body: message.body,
      bodyFormat: message.bodyFormat,
      addressedTo: message.addressedTo ?? null,
      bodyHash: message.bodyHash,
      confirmedAt: message.confirmedAt
    },
    replyToEventId: record.replyToEventId ?? null,
    createdAt: record.createdAt
  });
}

async function validLeasedRecord(input: Readonly<{
  generation: number;
  sequence: number;
  transactionId: string;
  bodyHash: string | undefined;
  deliveryHash: string | undefined;
  recordKind: string | undefined;
  message: MatrixOutboxRecord["message"];
  replyToEventId?: string;
  createdAt: string;
}>): Promise<boolean> {
  const message = input.message;
  if (
    !isRecord(message) || !hasOnlyKeys(message, allowedConfirmedMessageKeys) ||
    (message.authority !== undefined && !isConfirmedAgentAuthority(message.authority)) ||
    message.generation !== input.generation || message.sequence !== input.sequence ||
    message.bodyFormat !== "markdown" || typeof message.role !== "string" || message.role.trim().length === 0 || message.role.length > 160 ||
    typeof message.internalEventId !== "string" || !/^[A-Za-z0-9:_-]{8,255}$/.test(message.internalEventId) ||
    typeof message.visibleTime !== "string" || !/^\d{2}:\d{2}$/.test(message.visibleTime) ||
    typeof message.confirmedAt !== "string" || isoTimestampMillis(message.confirmedAt) === undefined ||
    message.confirmedAt !== input.createdAt ||
    typeof message.body !== "string" || message.body.length === 0 || utf8Length(message.body) > 65_536 ||
    typeof message.bodyHash !== "string" || !/^[a-f0-9]{64}$/.test(message.bodyHash) ||
    message.bodyHash !== input.bodyHash || input.deliveryHash === undefined || !/^[a-f0-9]{64}$/u.test(input.deliveryHash) ||
    !/^pc-\d+-\d+-[a-f0-9]{24}$/.test(input.transactionId) ||
    (input.replyToEventId !== undefined && !/^\$[A-Za-z0-9$:_-]{8,255}$/.test(input.replyToEventId)) ||
    (message.addressedTo !== undefined && (typeof message.addressedTo !== "string" || message.addressedTo.length > 160)) ||
    matrixTransactionIdFor(message) !== input.transactionId
  ) return false;
  if (input.recordKind !== "message" && input.recordKind !== "control") return false;
  if (!confirmedMessageFitsMatrixRuntimeLimits(message)) return false;
  if (await confirmedMessageFingerprint({
    role: message.role,
    body: message.body,
    ...(message.addressedTo === undefined ? {} : { addressedTo: message.addressedTo }),
    ...(input.replyToEventId === undefined ? {} : { replyToEventId: input.replyToEventId }),
    ...(message.authority === undefined ? {} : { authority: message.authority })
  }) !== message.bodyHash) return false;
  return await matrixOutboxDeliveryFingerprint({
    generation: input.generation,
    sequence: input.sequence,
    transactionId: input.transactionId,
    kind: input.recordKind,
    message,
    ...(input.replyToEventId === undefined ? {} : { replyToEventId: input.replyToEventId }),
    createdAt: input.createdAt
  }) === input.deliveryHash;
}

export class MySqlMatrixOutbox {
  readonly #pool: MySqlPool;
  readonly #deliveryEvidencePolicy: MatrixDeliveryEvidencePolicy | undefined;

  constructor(pool: MySqlPool, deliveryEvidencePolicy?: MatrixDeliveryEvidencePolicy) {
    if (deliveryEvidencePolicy !== undefined && (
      !/^![^\s:]+:[^\s:]+$/.test(deliveryEvidencePolicy.roomId) ||
      !/^@[^\s:]+:[^\s:]+$/.test(deliveryEvidencePolicy.ownerMxid) ||
      deliveryEvidencePolicy.ownerDeviceIds.length === 0 ||
      deliveryEvidencePolicy.ownerDeviceIds.some((value) => !/^[\x21-\x7e]{1,255}$/u.test(value)) ||
      !Number.isSafeInteger(deliveryEvidencePolicy.maxAgeMilliseconds) ||
      deliveryEvidencePolicy.maxAgeMilliseconds < 1_000 ||
      deliveryEvidencePolicy.maxAgeMilliseconds > 300_000
    )) throw new Error("Invalid Matrix delivery evidence policy.");
    this.#pool = pool;
    this.#deliveryEvidencePolicy = deliveryEvidencePolicy;
  }

  async inspectHead(now: Date): Promise<"idle" | "available" | "waiting" | "blocked" | "corrupt"> {
    const [rawRows] = await this.#pool.execute(SELECT_HEAD, []);
    const row = rowsOf(rawRows)[0];
    if (row === undefined) return "idle";
    const generation = asNumber(row.generation);
    const sequence = asNumber(row.sequenceNo);
    const transactionId = asString(row.transactionId);
    const replyToEventId = asString(row.replyToEventId);
    const bodyHash = asString(row.bodyHash);
    const deliveryHash = asString(row.deliveryHash);
    const recordKind = asString(row.recordKind);
    const state = asString(row.state);
    const leaseOwner = asString(row.leaseOwner);
    const leaseEpoch = asNumber(row.leaseEpoch);
    const attemptCount = asNumber(row.attemptCount);
    const leaseExpiry = isoTimestampMillis(row.leaseExpiresAt);
    const availableAt = isoTimestampMillis(row.availableAt);
    const createdAt = asString(row.createdAt);
    let message: MatrixOutboxRecord["message"] | undefined;
    try {
      message = parseJson(row.messageJson) as MatrixOutboxRecord["message"];
    } catch {
      message = undefined;
    }
    if (
      generation === undefined || sequence === undefined || transactionId === undefined || message === undefined
      || state === undefined || !["pending", "leased", "blocked"].includes(state)
      || leaseEpoch === undefined || leaseEpoch < 0 || attemptCount === undefined || attemptCount < 0
      || availableAt === undefined || createdAt === undefined || isoTimestampMillis(createdAt) === undefined
      || (state === "leased" && (
        leaseOwner === undefined || !/^[A-Za-z0-9_-]{8,128}$/u.test(leaseOwner) || leaseEpoch < 1 || leaseExpiry === undefined
      ))
      || (state !== "leased" && (leaseOwner !== undefined || row.leaseExpiresAt !== null))
      || !await validLeasedRecord({
        generation,
        sequence,
        transactionId,
        bodyHash,
        deliveryHash,
        recordKind,
        message,
        ...(replyToEventId === undefined ? {} : { replyToEventId }),
        createdAt
      })
    ) return "corrupt";
    if (state === "blocked") return "blocked";
    if (state === "leased" && (leaseExpiry as number) > now.getTime()) return "waiting";
    if (state === "pending" && availableAt > now.getTime()) return "waiting";
    return "available";
  }

  async leaseHead(input: Readonly<{ leaseOwner: string; now: Date; leaseMilliseconds: number }>): Promise<LeasedMatrixOutboxRecord | undefined> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.leaseOwner) || input.leaseMilliseconds < 1_000 || input.leaseMilliseconds > 60_000) {
      throw new Error("Invalid Matrix outbox lease request.");
    }
    const outcome = await inTransaction<LeasedMatrixOutboxRecord | Readonly<{ corrupt: true }> | undefined>(this.#pool, async (connection) => {
      const [rawRows] = await connection.execute(SELECT_HEAD_FOR_UPDATE, []);
      const row = rowsOf(rawRows)[0];
      // A blocked canonical head is an intentional fail-closed barrier. It is
      // never skipped: operator reconciliation must resolve it before any
      // later sequence can be leased.
      if (row === undefined || row.state === "blocked") return undefined;
      const state = asString(row.state);
      const priorEpoch = asNumber(row.leaseEpoch);
      const priorExpiry = isoTimestampMillis(row.leaseExpiresAt);
      const availableAt = isoTimestampMillis(row.availableAt);
      const leaseOwner = asString(row.leaseOwner);
      const attemptCount = asNumber(row.attemptCount);
      const generation = asNumber(row.generation);
      const sequence = asNumber(row.sequenceNo);
      const transactionId = asString(row.transactionId);
      const replyToEventId = asString(row.replyToEventId);
      const createdAt = asString(row.createdAt);
      let message: MatrixOutboxRecord["message"] | undefined;
      try {
        message = parseJson(row.messageJson) as MatrixOutboxRecord["message"];
      } catch {
        message = undefined;
      }
      const bodyHash = asString(row.bodyHash);
      const deliveryHash = asString(row.deliveryHash);
      const recordKind = asString(row.recordKind);
      if (
        generation === undefined || sequence === undefined || transactionId === undefined || message === undefined ||
        state === undefined || !["pending", "leased"].includes(state) || priorEpoch === undefined || priorEpoch < 0 ||
        attemptCount === undefined || attemptCount < 0 || availableAt === undefined ||
        createdAt === undefined || isoTimestampMillis(createdAt) === undefined ||
        (state === "leased" && (
          leaseOwner === undefined || !/^[A-Za-z0-9_-]{8,128}$/u.test(leaseOwner) || priorEpoch < 1 || priorExpiry === undefined
        )) ||
        (state === "pending" && (leaseOwner !== undefined || row.leaseExpiresAt !== null)) ||
        !await validLeasedRecord({
          generation,
          sequence,
          transactionId,
          bodyHash,
          deliveryHash,
          recordKind,
          message,
          ...(replyToEventId === undefined ? {} : { replyToEventId }),
          createdAt
        })
      ) {
        if (generation !== undefined && sequence !== undefined) {
          await connection.execute(QUARANTINE_OUTBOX, [input.now.toISOString(), generation, sequence]);
        }
        return { corrupt: true };
      }
      if (state === "leased" && (priorExpiry as number) > input.now.getTime()) return undefined;
      if (state === "pending" && availableAt > input.now.getTime()) return undefined;
      const leaseEpoch = priorEpoch + 1;
      const now = input.now.toISOString();
      const expiresAt = new Date(input.now.getTime() + input.leaseMilliseconds).toISOString();
      const [result] = await connection.execute(LEASE_OUTBOX, [
        input.leaseOwner, expiresAt, now, generation, sequence, priorEpoch
      ]);
      if (affectedRows(result) !== 1) return undefined;
      return Object.freeze({
        generation,
        sequence,
        transactionId,
        message,
        ...(replyToEventId === undefined ? {} : { replyToEventId }),
        leaseOwner: input.leaseOwner,
        leaseEpoch,
        attemptCount: attemptCount + 1
      });
    });
    if (outcome !== undefined && "corrupt" in outcome) {
      throw new MatrixOutboxCorruptionError("Matrix outbox row failed canonical validation.");
    }
    return outcome;
  }

  async markAccepted(lease: LeasedMatrixOutboxRecord, matrixEventId: string, now: Date): Promise<OutboxMutationResult> {
    if (
      !/^\$[A-Za-z0-9$:_-]{8,255}$/.test(matrixEventId)
      || !(now instanceof Date)
      || !Number.isFinite(now.getTime())
    ) throw new MatrixOutboxCorruptionError("Matrix acceptance receipt is invalid.");
    const [result] = await this.#pool.execute(ACCEPT_OUTBOX, [
      matrixEventId, now.toISOString(), now.toISOString(), lease.generation, lease.sequence, lease.leaseOwner, lease.leaseEpoch
    ]);
    return affectedRows(result) === 1 ? { ok: true } : { ok: false, code: "stale_lease" };
  }

  async markBlocked(lease: LeasedMatrixOutboxRecord, errorCode: string, now: Date): Promise<OutboxMutationResult> {
    const [result] = await this.#pool.execute(BLOCK_OUTBOX, [
      errorCode.slice(0, 96), now.toISOString(), lease.generation, lease.sequence, lease.leaseOwner, lease.leaseEpoch
    ]);
    return affectedRows(result) === 1 ? { ok: true } : { ok: false, code: "stale_lease" };
  }

  async releaseTransient(
    lease: LeasedMatrixOutboxRecord,
    errorCode: string,
    now: Date,
    backoffMilliseconds: number
  ): Promise<OutboxMutationResult> {
    const availableAt = new Date(now.getTime() + Math.max(1_000, Math.min(backoffMilliseconds, 300_000))).toISOString();
    const [result] = await this.#pool.execute(RELEASE_OUTBOX, [
      availableAt, errorCode.slice(0, 96), now.toISOString(), lease.generation, lease.sequence,
      lease.leaseOwner, lease.leaseEpoch
    ]);
    return affectedRows(result) === 1 ? { ok: true } : { ok: false, code: "stale_lease" };
  }

  async markDeviceDelivered(evidence: MatrixDeliveryEvidence): Promise<boolean> {
    if (!await this.#permitsDeliveryEvidence(evidence, "device_delivery")) return false;
    const [result] = await this.#pool.execute(DEVICE_DELIVERED, [
      evidence.evidenceId, evidence.evidenceHash, evidence.observedAt,
      evidence.observedAt, evidence.matrixEventId
    ]);
    return affectedRows(result) === 1;
  }

  async markRead(evidence: MatrixDeliveryEvidence): Promise<boolean> {
    if (!await this.#permitsDeliveryEvidence(evidence, "owner_read")) return false;
    const [result] = await this.#pool.execute(READ_OUTBOX, [
      evidence.evidenceId, evidence.evidenceHash, evidence.observedAt,
      evidence.observedAt, evidence.matrixEventId
    ]);
    return affectedRows(result) === 1;
  }

  async #permitsDeliveryEvidence(
    evidence: MatrixDeliveryEvidence,
    kind: MatrixDeliveryEvidence["kind"]
  ): Promise<boolean> {
    const policy = this.#deliveryEvidencePolicy;
    if (policy === undefined || !validDeliveryEvidence(evidence, kind)) return false;
    const observedAt = isoTimestampMillis(evidence.observedAt);
    const now = policy.now().getTime();
    if (
      observedAt === undefined || !Number.isFinite(now) ||
      observedAt > now + 5_000 || now - observedAt > policy.maxAgeMilliseconds ||
      evidence.roomId !== policy.roomId || evidence.ownerMxid !== policy.ownerMxid ||
      !policy.ownerDeviceIds.includes(evidence.ownerDeviceId) ||
      await deliveryEvidenceHash(evidence) !== evidence.evidenceHash
    ) return false;
    try {
      return await policy.verifyEvidence(evidence);
    } catch {
      return false;
    }
  }
}

export type MatrixDeliveryEvidence = Readonly<{
  kind: "device_delivery" | "owner_read";
  evidenceId: string;
  evidenceHash: string;
  matrixEventId: string;
  roomId: string;
  ownerMxid: string;
  ownerDeviceId: string;
  observedAt: string;
}>;

/**
 * Delivery/read transitions are disabled unless the composition root supplies
 * an exact identity binding and a verifier for a trusted sidecar receipt.
 * Shape alone is never evidence that a device displayed or read an event.
 */
export type MatrixDeliveryEvidencePolicy = Readonly<{
  roomId: string;
  ownerMxid: string;
  ownerDeviceIds: readonly string[];
  maxAgeMilliseconds: number;
  now: () => Date;
  verifyEvidence: (evidence: MatrixDeliveryEvidence) => boolean | Promise<boolean>;
}>;

async function deliveryEvidenceHash(evidence: MatrixDeliveryEvidence): Promise<string> {
  return jsonSha256({
    kind: evidence.kind,
    evidenceId: evidence.evidenceId,
    matrixEventId: evidence.matrixEventId,
    roomId: evidence.roomId,
    ownerMxid: evidence.ownerMxid,
    ownerDeviceId: evidence.ownerDeviceId,
    observedAt: evidence.observedAt
  });
}

function validDeliveryEvidence(evidence: MatrixDeliveryEvidence, kind: MatrixDeliveryEvidence["kind"]): boolean {
  return evidence.kind === kind && /^\$[A-Za-z0-9$:_-]{8,255}$/.test(evidence.matrixEventId) &&
    /^[A-Za-z0-9:_-]{8,128}$/.test(evidence.evidenceId) && /^[a-f0-9]{64}$/.test(evidence.evidenceHash) &&
    /^![^\s:]+:[^\s:]+$/.test(evidence.roomId) && /^@[^\s:]+:[^\s:]+$/.test(evidence.ownerMxid) &&
    /^[\x21-\x7e]{1,255}$/u.test(evidence.ownerDeviceId) && isoTimestampMillis(evidence.observedAt) !== undefined;
}

export type MatrixIngressState = "ready" | "leased" | "processed" | "rejected" | "blocked";
export type MatrixIngressIntent = Readonly<{
  eventId: string;
  roomId: string;
  ownerMxid: string;
  senderDeviceId: string;
  body: string | null;
  relationEventId?: string;
  media: readonly Readonly<{
    declaredMime: "image/jpeg" | "image/png" | "application/pdf";
    length: number;
    sha256: string;
  }>[];
}>;
export type MatrixIngressPersistResult =
  | Readonly<{ ok: true; replayed: boolean; durableAck: boolean; processed: boolean }>
  | Readonly<{ ok: false; code: "event_conflict" }>;
export type LeasedMatrixIngressIntent = Readonly<{
  eventId: string;
  eventHash: string;
  workIntent: MatrixIngressIntent;
  leaseOwner: string;
  leaseEpoch: number;
}>;

export class MatrixIngressCorruptionError extends Error {
  readonly code = "matrix_ingress_corrupt";

  constructor() {
    super("Matrix ingress work intent failed integrity validation and was quarantined.");
    this.name = "MatrixIngressCorruptionError";
  }
}

const allowedIngressIntentKeys = new Set(["eventId", "roomId", "ownerMxid", "senderDeviceId", "body", "relationEventId", "media"]);
const allowedIngressMediaKeys = new Set(["declaredMime", "length", "sha256"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function sameIngressIntent(left: MatrixIngressIntent, right: MatrixIngressIntent): boolean {
  return left.eventId === right.eventId && left.roomId === right.roomId && left.ownerMxid === right.ownerMxid &&
    left.senderDeviceId === right.senderDeviceId && left.body === right.body &&
    left.relationEventId === right.relationEventId && left.media.length === right.media.length &&
    left.media.every((item, index) => {
      const other = right.media[index];
      return other !== undefined && item.declaredMime === other.declaredMime && item.length === other.length &&
        item.sha256 === other.sha256;
    });
}

type MatrixIngressRejectionCode = "secret_like_content" | "media_expired" | "invalid_media";

function storedRejectionCode(value: unknown): MatrixIngressRejectionCode | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["rejectionCode"]))) return undefined;
  return value.rejectionCode === "secret_like_content" || value.rejectionCode === "media_expired"
    || value.rejectionCode === "invalid_media"
    ? value.rejectionCode
    : undefined;
}

async function validateIngressIntent(
  value: unknown,
  row: Readonly<{
    eventId: string;
    eventHash: string;
    roomId: string;
    ownerMxid: string;
    bodyHash: string;
    mediaManifestHash: string;
  }>
): Promise<MatrixIngressIntent | undefined> {
  if (!isRecord(value) || !hasOnlyKeys(value, allowedIngressIntentKeys)) return undefined;
  const { eventId, roomId, ownerMxid, senderDeviceId, body, relationEventId, media } = value;
  if (
    eventId !== row.eventId || !/^\$[A-Za-z0-9$:_-]{8,255}$/.test(row.eventId) ||
    roomId !== row.roomId || typeof roomId !== "string" || !/^![^\s:]+:[^\s:]+$/.test(roomId) ||
    ownerMxid !== row.ownerMxid || typeof ownerMxid !== "string" || !/^@[^\s:]+:[^\s:]+$/.test(ownerMxid) ||
    typeof senderDeviceId !== "string" || !/^[\x21-\x7e]{1,255}$/u.test(senderDeviceId) ||
    (body !== null && (typeof body !== "string" || body.length === 0 || utf8Length(body) > 65_536)) ||
    (relationEventId !== undefined && (typeof relationEventId !== "string" || !/^\$[A-Za-z0-9$:_-]{8,255}$/.test(relationEventId))) ||
    !Array.isArray(media) || media.length > 4 || (body === null && media.length === 0)
  ) return undefined;
  let totalLength = 0;
  for (const item of media) {
    if (!isRecord(item) || !hasOnlyKeys(item, allowedIngressMediaKeys)) return undefined;
    if (
      !["image/jpeg", "image/png", "application/pdf"].includes(String(item.declaredMime)) ||
      !Number.isSafeInteger(item.length) || Number(item.length) <= 0 || Number(item.length) > 20 * 1024 * 1024 ||
      typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)
    ) return undefined;
    totalLength += Number(item.length);
  }
  if (totalLength > 64 * 1024 * 1024) return undefined;
  if (await jsonSha256(body) !== row.bodyHash || await jsonSha256(media) !== row.mediaManifestHash) return undefined;
  if (await jsonSha256({
    eventId,
    roomId,
    senderMxid: ownerMxid,
    senderDeviceId,
    encrypted: true,
    bodyHash: row.bodyHash,
    relationEventId: relationEventId ?? null,
    mediaManifestHash: row.mediaManifestHash
  }) !== row.eventHash) return undefined;
  return value as MatrixIngressIntent;
}

function validateIngressAckState(
  intent: MatrixIngressIntent,
  row: Readonly<Record<"ackEligibleAt" | "mediaConsumptionReceiptHash" | "mediaConsumedAt", unknown>>
): Readonly<{ valid: boolean; durableAck: boolean }> {
  const ackEligibleAt = row.ackEligibleAt === null ? undefined : isoTimestampMillis(row.ackEligibleAt);
  const mediaReceipt = row.mediaConsumptionReceiptHash;
  const mediaConsumedAt = row.mediaConsumedAt === null ? undefined : isoTimestampMillis(row.mediaConsumedAt);
  if (row.ackEligibleAt !== null && ackEligibleAt === undefined) return { valid: false, durableAck: false };
  if (intent.media.length === 0) {
    return {
      valid: ackEligibleAt !== undefined && mediaReceipt === null && row.mediaConsumedAt === null,
      durableAck: ackEligibleAt !== undefined
    };
  }
  if (ackEligibleAt === undefined) {
    return {
      valid: mediaReceipt === null && row.mediaConsumedAt === null,
      durableAck: false
    };
  }
  return {
    valid: typeof mediaReceipt === "string" && /^[a-f0-9]{64}$/u.test(mediaReceipt)
      && mediaConsumedAt !== undefined && mediaConsumedAt === ackEligibleAt,
    durableAck: true
  };
}

export class MySqlMatrixIngressReceipts {
  readonly #pool: MySqlPool;

  constructor(pool: MySqlPool) {
    this.#pool = pool;
  }

  async persistIntent(input: Readonly<{
    eventId: string;
    eventHash: string;
    roomId: string;
    ownerMxid: string;
    bodyHash: string;
    workIntent: MatrixIngressIntent;
    mediaManifestHash: string;
    requiresMediaConsumption: boolean;
    now: Date;
  }>): Promise<MatrixIngressPersistResult> {
    if (!/^[a-f0-9]{64}$/.test(input.eventHash) || !/^[a-f0-9]{64}$/.test(input.bodyHash) ||
      !/^[a-f0-9]{64}$/.test(input.mediaManifestHash)) throw new MatrixIngressCorruptionError();
    const validatedIntent = await validateIngressIntent(input.workIntent, {
      eventId: input.eventId,
      eventHash: input.eventHash,
      roomId: input.roomId,
      ownerMxid: input.ownerMxid,
      bodyHash: input.bodyHash,
      mediaManifestHash: input.mediaManifestHash
    });
    if (validatedIntent === undefined || input.requiresMediaConsumption !== (input.workIntent.media.length > 0)) {
      throw new MatrixIngressCorruptionError();
    }
    return inTransaction(this.#pool, async (connection) => {
      const [rawRows] = await connection.execute(SELECT_INGRESS_FOR_UPDATE, [input.eventId]);
      const row = rowsOf(rawRows)[0];
      if (row !== undefined) {
        let storedRawIntent: unknown;
        try {
          storedRawIntent = parseJson(row.workIntentJson);
        } catch {
          storedRawIntent = undefined;
        }
        const storedIntent = await validateIngressIntent(storedRawIntent, {
          eventId: input.eventId,
          eventHash: input.eventHash,
          roomId: input.roomId,
          ownerMxid: input.ownerMxid,
          bodyHash: input.bodyHash,
          mediaManifestHash: input.mediaManifestHash
        });
        const state = asString(row.state);
        const ackState = storedIntent === undefined
          ? { valid: false, durableAck: false }
          : validateIngressAckState(storedIntent, row);
        if (
          row.eventHash !== input.eventHash || row.roomId !== input.roomId || row.ownerMxid !== input.ownerMxid ||
          row.bodyHash !== input.bodyHash || row.mediaManifestHash !== input.mediaManifestHash ||
          state === undefined || !["ready", "leased", "processed"].includes(state) ||
          storedIntent === undefined || !sameIngressIntent(storedIntent, validatedIntent) ||
          !ackState.valid ||
          (!input.requiresMediaConsumption && !ackState.durableAck)
        ) return { ok: false, code: "event_conflict" };
        return {
          ok: true,
          replayed: true,
          durableAck: ackState.durableAck,
          processed: state === "processed"
        };
      }
      await connection.execute(INSERT_INGRESS, [
        input.eventId, input.eventHash, input.roomId, input.ownerMxid, input.bodyHash, input.mediaManifestHash,
        JSON.stringify(input.workIntent), input.requiresMediaConsumption ? null : input.now.toISOString(), input.now.toISOString()
      ]);
      return {
        ok: true,
        replayed: false,
        durableAck: !input.requiresMediaConsumption,
        processed: false
      };
    });
  }

  /**
   * Persists only content-free hashes for policy rejection or an expired Rust
   * media receipt. Expiry may replace an exact, unconsumed ready intent, but it
   * never overwrites consumed/leased work or a mismatched durable identity.
   */
  async persistRejection(input: Readonly<{
    eventId: string;
    eventHash: string;
    roomId: string;
    ownerMxid: string;
    bodyHash: string;
    mediaManifestHash: string;
    rejectionCode: MatrixIngressRejectionCode;
    now: Date;
  }>): Promise<
    | Readonly<{ ok: true; replayed: boolean; durableAck: boolean; processed: false }>
    | Readonly<{ ok: false; code: "event_conflict" }>
  > {
    if (
      !/^\$[A-Za-z0-9$:_-]{8,255}$/.test(input.eventId)
      || !/^![^\s:]+:[^\s:]+$/.test(input.roomId)
      || !/^@[^\s:]+:[^\s:]+$/.test(input.ownerMxid)
      || !/^[a-f0-9]{64}$/.test(input.eventHash)
      || !/^[a-f0-9]{64}$/.test(input.bodyHash)
      || !/^[a-f0-9]{64}$/.test(input.mediaManifestHash)
      || !["secret_like_content", "media_expired", "invalid_media"].includes(input.rejectionCode)
      || !(input.now instanceof Date)
      || !Number.isFinite(input.now.getTime())
    ) throw new MatrixIngressCorruptionError();
    return inTransaction(this.#pool, async (connection) => {
      const [rawRows] = await connection.execute(SELECT_INGRESS_FOR_UPDATE, [input.eventId]);
      const row = rowsOf(rawRows)[0];
      if (row !== undefined) {
        let storedWork: unknown;
        try {
          storedWork = parseJson(row.workIntentJson);
        } catch {
          storedWork = undefined;
        }
        const state = asString(row.state);
        const ackEligibleAt = row.ackEligibleAt === null ? undefined : isoTimestampMillis(row.ackEligibleAt);
        if (
          row.eventHash !== input.eventHash
          || row.roomId !== input.roomId
          || row.ownerMxid !== input.ownerMxid
          || row.bodyHash !== input.bodyHash
          || row.mediaManifestHash !== input.mediaManifestHash
          || state === undefined
          || (row.ackEligibleAt !== null && ackEligibleAt === undefined)
        ) return { ok: false, code: "event_conflict" };

        if (state === "rejected") {
          if (storedRejectionCode(storedWork) !== input.rejectionCode || ackEligibleAt === undefined) {
            return { ok: false, code: "event_conflict" };
          }
          return { ok: true, replayed: true, durableAck: true, processed: false };
        }

        if (input.rejectionCode !== "media_expired") return { ok: false, code: "event_conflict" };
        const storedIntent = await validateIngressIntent(storedWork, {
          eventId: input.eventId,
          eventHash: input.eventHash,
          roomId: input.roomId,
          ownerMxid: input.ownerMxid,
          bodyHash: input.bodyHash,
          mediaManifestHash: input.mediaManifestHash
        });
        if (storedIntent === undefined || storedIntent.media.length === 0) {
          return { ok: false, code: "event_conflict" };
        }
        const ackState = validateIngressAckState(storedIntent, row);
        if (!ackState.valid) return { ok: false, code: "event_conflict" };
        // Already-consumed durable work keeps its full intent. It is safe to
        // ACK the Rust receipt because MySQL can still retry processing it.
        if (["ready", "leased", "processed"].includes(state) && ackState.durableAck) {
          return { ok: true, replayed: true, durableAck: true, processed: false };
        }
        if (state !== "ready" || row.ackEligibleAt !== null) {
          return { ok: false, code: "event_conflict" };
        }
        const now = input.now.toISOString();
        const [expired] = await connection.execute(EXPIRE_MEDIA_INGRESS, [
          JSON.stringify({ rejectionCode: input.rejectionCode }),
          now,
          now,
          input.eventId,
          input.eventHash
        ]);
        if (affectedRows(expired) !== 1) return { ok: false, code: "event_conflict" };
        return {
          ok: true,
          replayed: true,
          durableAck: true,
          processed: false
        };
      }
      const now = input.now.toISOString();
      await connection.execute(INSERT_REJECTED_INGRESS, [
        input.eventId,
        input.eventHash,
        input.roomId,
        input.ownerMxid,
        input.bodyHash,
        input.mediaManifestHash,
        JSON.stringify({ rejectionCode: input.rejectionCode }),
        now,
        now
      ]);
      return { ok: true, replayed: false, durableAck: true, processed: false };
    });
  }

  async leaseNext(input: Readonly<{
    leaseOwner: string;
    now: Date;
    leaseMilliseconds: number;
  }>): Promise<LeasedMatrixIngressIntent | undefined> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.leaseOwner) || input.leaseMilliseconds < 1_000 || input.leaseMilliseconds > 60_000) {
      throw new Error("Invalid Matrix ingress lease request.");
    }
    const result = await inTransaction(this.#pool, async (connection) => {
      const [rawRows] = await connection.execute(SELECT_INGRESS_HEAD_FOR_UPDATE, []);
      const row = rowsOf(rawRows)[0];
      if (row === undefined) return undefined;
      const eventId = asString(row.eventId);
      const eventHash = asString(row.eventHash);
      const roomId = asString(row.roomId);
      const ownerMxid = asString(row.ownerMxid);
      const bodyHash = asString(row.bodyHash);
      const mediaManifestHash = asString(row.mediaManifestHash);
      let rawWorkIntent: unknown;
      try {
        rawWorkIntent = parseJson(row.workIntentJson);
      } catch {
        rawWorkIntent = undefined;
      }
      const workIntent = eventId !== undefined && roomId !== undefined && ownerMxid !== undefined &&
        bodyHash !== undefined && mediaManifestHash !== undefined && eventHash !== undefined
        ? await validateIngressIntent(rawWorkIntent, { eventId, eventHash, roomId, ownerMxid, bodyHash, mediaManifestHash })
        : undefined;
      const state = asString(row.state);
      const priorEpoch = asNumber(row.leaseEpoch);
      const leaseOwner = asString(row.leaseOwner);
      const leaseExpiry = row.leaseExpiresAt === null ? undefined : isoTimestampMillis(row.leaseExpiresAt);
      const ackState = workIntent === undefined
        ? { valid: false, durableAck: false }
        : validateIngressAckState(workIntent, row);
      const leaseStateValid = state === "ready"
        ? row.leaseOwner === null && row.leaseExpiresAt === null && priorEpoch !== undefined && priorEpoch >= 0
        : state === "leased" && leaseOwner !== undefined && /^[A-Za-z0-9_-]{8,128}$/u.test(leaseOwner)
          && priorEpoch !== undefined && priorEpoch >= 1 && leaseExpiry !== undefined;
      if (
        eventHash === undefined || !/^[a-f0-9]{64}$/.test(eventHash) || workIntent === undefined ||
        !ackState.valid || !leaseStateValid
      ) {
        if (eventId !== undefined) await connection.execute(QUARANTINE_INGRESS, [input.now.toISOString(), eventId]);
        return { corrupt: true } as const;
      }
      // A valid media-backed intent is the strict ingress head but cannot
      // dispatch until its exact durable consumption receipt is committed.
      if (!ackState.durableAck) return undefined;
      if (state === "leased" && (leaseExpiry as number) > input.now.getTime()) return undefined;
      const leaseEpoch = (priorEpoch as number) + 1;
      const [result] = await connection.execute(LEASE_INGRESS, [
        input.leaseOwner,
        new Date(input.now.getTime() + input.leaseMilliseconds).toISOString(),
        input.now.toISOString(),
        eventId,
        priorEpoch
      ]);
      if (affectedRows(result) !== 1) return undefined;
      return {
        corrupt: false,
        lease: Object.freeze({ eventId: workIntent.eventId, eventHash, workIntent, leaseOwner: input.leaseOwner, leaseEpoch })
      } as const;
    });
    if (result?.corrupt === true) throw new MatrixIngressCorruptionError();
    return result?.lease;
  }

  async markProcessed(input: Readonly<{
    eventId: string;
    eventHash: string;
    leaseOwner: string;
    leaseEpoch: number;
    sessionId: string;
    generation: number;
    now: Date;
  }>): Promise<boolean> {
    const [result] = await this.#pool.execute(REGISTER_INGRESS, [
      input.sessionId, input.generation, input.now.toISOString(), input.eventId, input.eventHash,
      input.leaseOwner, input.leaseEpoch
    ]);
    return affectedRows(result) === 1;
  }

  async acknowledge(eventId: string, eventHash: string, now: Date): Promise<boolean> {
    const [result] = await this.#pool.execute(ACK_INGRESS, [
      now.toISOString(), now.toISOString(), eventId, eventHash
    ]);
    return affectedRows(result) === 1;
  }

  async markMediaConsumed(input: Readonly<{
    eventId: string;
    eventHash: string;
    mediaManifestHash: string;
    consumptionReceiptHash: string;
    now: Date;
  }>): Promise<boolean> {
    if (!/^\$[A-Za-z0-9$:_-]{8,255}$/.test(input.eventId) || !/^[a-f0-9]{64}$/.test(input.eventHash) ||
      !/^[a-f0-9]{64}$/.test(input.mediaManifestHash) || !/^[a-f0-9]{64}$/.test(input.consumptionReceiptHash) ||
      !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) return false;
    const now = input.now.toISOString();
    return inTransaction(this.#pool, async (connection) => {
      const [result] = await connection.execute(CONSUME_INGRESS_MEDIA, [
        input.consumptionReceiptHash, now, now, now, input.eventId, input.eventHash,
        input.mediaManifestHash, input.consumptionReceiptHash
      ]);
      if (affectedRows(result) === 1) return true;
      const [rawRows] = await connection.execute(SELECT_INGRESS_FOR_UPDATE, [input.eventId]);
      const row = rowsOf(rawRows)[0];
      return row?.eventHash === input.eventHash && row.mediaManifestHash === input.mediaManifestHash &&
        row.mediaConsumptionReceiptHash === input.consumptionReceiptHash &&
        isoTimestampMillis(row.ackEligibleAt) !== undefined &&
        isoTimestampMillis(row.mediaConsumedAt) === isoTimestampMillis(row.ackEligibleAt) &&
        row.state === "ready";
    });
  }
}

export function isFinalMatrixOutboxState(state: MatrixOutboxState): boolean {
  return state === "accepted" || state === "device_delivered" || state === "read" || state === "cancelled";
}
