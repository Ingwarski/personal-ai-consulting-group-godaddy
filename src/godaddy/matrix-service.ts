import { createHash, randomBytes } from "node:crypto";

import { formatConfirmedMessageForMatrix, isSecretLikeMatrixContent } from "../matrix/bridge.ts";
import type { RoomBinding } from "../matrix/room-invariant.ts";
import {
  createMatrixRuntime,
  type MatrixIngressMediaObject,
  type MatrixRoomPolicySnapshot,
  type MatrixRuntime,
  type MatrixRuntimeDependencyReadiness,
  type ValidatedMatrixIngress,
  type ValidatedMatrixIngressRejection
} from "./matrix-runtime.ts";
import {
  parseGoDaddyMatrixConfiguration,
  type GoDaddyMatrixConfiguration,
  type GoDaddyMatrixConfigurationResult
} from "./matrix-service-config.ts";
import {
  MatrixSidecarError,
  MatrixSidecarSupervisor,
  type MatrixSidecarErrorCode,
  type MatrixSidecarSupervisorOptions
} from "./matrix-sidecar-supervisor.ts";
import {
  readExistingMatrixStoreBinding,
  type MatrixStoreBindingResult
} from "./matrix-store-binding.ts";
import {
  GODADDY_MATRIX_INGRESS_TABLE,
  GODADDY_MATRIX_OUTBOX_TABLE,
  type LeasedMatrixOutboxRecord,
  type MatrixIngressIntent
} from "./mysql-matrix-outbox.ts";
import { GODADDY_STATE_TABLE, type MySqlPool } from "./mysql-storage.ts";
import type { GoDaddyRegistrarRuntime } from "./registrar-runtime.ts";

const OUTBOX_LEASE_MILLISECONDS = 60_000;
const OUTBOX_BURST_LIMIT = 32;
const MAX_OUTBOX_ATTEMPTS = 8;
const MAX_INGRESS_QUEUE = 64;
const DEFAULT_POLL_MILLISECONDS = 1_000;
const DEFAULT_PROBE_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_STOP_TIMEOUT_MILLISECONDS = 8_000;
const MAX_RETRY_MILLISECONDS = 30_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const LEASE_OWNER = /^[A-Za-z0-9_-]{8,128}$/u;

type SupervisorPort = Parameters<typeof createMatrixRuntime>[0]["supervisor"];

type ConfigurationFailureCode = Extract<GoDaddyMatrixConfigurationResult, { ok: false }>["code"];
type StoreBindingFailureCode = Extract<MatrixStoreBindingResult, { ok: false }>["code"];

export type GoDaddyMatrixServiceReason = ConfigurationFailureCode | StoreBindingFailureCode;

type ServiceReason = GoDaddyMatrixServiceReason
  | "not_started"
  | "starting"
  | "ready"
  | "database_unavailable"
  | "schema_unavailable"
  | "outbox_blocked"
  | "ingress_blocked"
  | "media_consumer_unavailable"
  | "sidecar_not_ready"
  | "lock_contended"
  | "circuit_open"
  | "retry_exhausted"
  | "publication_fence_unavailable"
  | "stopping"
  | "stopped"
  | "termination_failed";

type KnownErrorCode = MatrixSidecarErrorCode | "matrix_outbox_corrupt" | "matrix_ingress_corrupt";

export type GoDaddyMatrixServiceReadiness = Readonly<{
  configured: boolean;
  ready: boolean;
  reason: ServiceReason;
}>;

/**
 * The consumer must durably dedupe by eventHash and return the same stable
 * receipt hash on every replay. This is the crash boundary between ephemeral
 * sidecar bytes and durable downstream work.
 */
export type DurableMatrixMediaConsumer = (input: Readonly<{
  eventHash: string;
  event: ValidatedMatrixIngress;
  objects: readonly MatrixIngressMediaObject[];
}>) => Promise<Readonly<{
  eventHash: string;
  consumptionReceiptHash: string;
}>>;

export type GoDaddyMatrixDatabaseProbe = Readonly<{
  mysqlAvailable: boolean;
  schemaAvailable: boolean;
  outboxAvailable: boolean;
  ingressAvailable: boolean;
}>;

export type MatrixPublicationSynchronizer = Readonly<{
  withPublicationPermit: <Value>(publish: () => Promise<Value>) => Promise<Value>;
  withGenerationFence: <Value>(
    input: Readonly<{ generation: number }>,
    fence: () => Promise<Value>
  ) => Promise<Value>;
}>;

export type MatrixServiceClock = Readonly<{
  now: () => number;
  setTimeout: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}>;

export type GoDaddyMatrixServiceDependencies = Readonly<{
  parseConfiguration?: typeof parseGoDaddyMatrixConfiguration;
  readStoreBinding?: typeof readExistingMatrixStoreBinding;
  createSupervisor?: (options: MatrixSidecarSupervisorOptions) => SupervisorPort;
  createRuntime?: (input: Parameters<typeof createMatrixRuntime>[0]) => MatrixRuntime;
  probeDatabase?: (pool: MySqlPool) => Promise<GoDaddyMatrixDatabaseProbe>;
  publicationSynchronizer?: MatrixPublicationSynchronizer;
  mediaConsumer?: DurableMatrixMediaConsumer;
  leaseOwner?: () => string;
  clock?: MatrixServiceClock;
  pollMilliseconds?: number;
  probeTimeoutMilliseconds?: number;
  stopTimeoutMilliseconds?: number;
}>;

export type GoDaddyMatrixService = Readonly<{
  configured: boolean;
  start: () => Promise<void>;
  wakeOutbox: () => void;
  getReadiness: () => GoDaddyMatrixServiceReadiness;
  assertReadyForNewSession: () => void;
  stop: () => Promise<void>;
}>;

type IngressTask = {
  event: ValidatedMatrixIngress | undefined;
  rejection?: ValidatedMatrixIngressRejection;
  attemptCount: number;
  eventHash?: string;
  mediaManifestHash?: string;
  mediaConsumptionReceiptHash?: string;
  normalPersisted: boolean;
  rejectionPersisted: boolean;
  durableAck: boolean;
  ackApplied: boolean;
  evidenceRecorded: boolean;
};

type TimerSlot = {
  handle?: unknown;
  dueAt: number;
};

const nativeClock: MatrixServiceClock = Object.freeze({
  now: Date.now,
  setTimeout(callback, milliseconds) {
    const handle = setTimeout(callback, milliseconds);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
});

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function safeRows(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Readonly<Record<string, unknown>> =>
    typeof row === "object" && row !== null && !Array.isArray(row)
  );
}

type RequiredSchemaColumn = Readonly<{
  table: string;
  column: string;
  columnType: string;
  nullable: "YES" | "NO";
  defaultValue: string | null;
  collation?: "ascii_bin" | "utf8mb4_bin";
}>;

const requiredColumn = (
  table: string,
  column: string,
  columnType: string,
  nullable: "YES" | "NO",
  defaultValue: string | null = null,
  collation?: "ascii_bin" | "utf8mb4_bin"
): RequiredSchemaColumn => Object.freeze({
  table,
  column,
  columnType,
  nullable,
  defaultValue,
  ...(collation === undefined ? {} : { collation })
});

const REQUIRED_SCHEMA_COLUMNS: readonly RequiredSchemaColumn[] = Object.freeze([
  requiredColumn(GODADDY_STATE_TABLE, "state_namespace", "varchar(64)", "NO", null, "utf8mb4_bin"),
  requiredColumn(GODADDY_STATE_TABLE, "state_key", "varchar(191)", "NO", null, "utf8mb4_bin"),
  requiredColumn(GODADDY_STATE_TABLE, "state_value", "json", "NO"),
  requiredColumn(GODADDY_STATE_TABLE, "updated_at", "timestamp(6)", "NO", "current_timestamp(6)"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "generation", "bigint unsigned", "NO"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "sequence_no", "bigint unsigned", "NO"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "transaction_id", "varchar(128)", "NO", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "state", "enum('pending','leased','accepted','device_delivered','read','blocked','cancelled')", "NO"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "record_kind", "enum('message','control')", "NO"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "message_json", "json", "NO"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "body_hash", "char(64)", "NO", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "delivery_hash", "char(64)", "NO", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "reply_to_event_id", "varchar(255)", "YES", null, "utf8mb4_bin"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "matrix_event_id", "varchar(255)", "YES", null, "utf8mb4_bin"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "lease_owner", "varchar(128)", "YES", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "lease_epoch", "bigint unsigned", "NO", "0"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "lease_expires_at", "varchar(64)", "YES"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "attempt_count", "bigint unsigned", "NO", "0"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "last_error_code", "varchar(96)", "YES", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "available_at", "varchar(64)", "NO"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "created_at", "varchar(64)", "NO"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "accepted_at", "varchar(64)", "YES"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "device_delivered_at", "varchar(64)", "YES"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "read_at", "varchar(64)", "YES"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "device_delivery_evidence_id", "varchar(128)", "YES", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "device_delivery_evidence_hash", "char(64)", "YES", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "read_evidence_id", "varchar(128)", "YES", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "read_evidence_hash", "char(64)", "YES", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_OUTBOX_TABLE, "updated_at", "timestamp(6)", "NO", "current_timestamp(6)"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "event_id", "varchar(255)", "NO", null, "utf8mb4_bin"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "event_hash", "char(64)", "NO", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "state", "enum('ready','leased','processed','rejected','blocked')", "NO"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "room_id", "varchar(255)", "NO", null, "utf8mb4_bin"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "owner_mxid", "varchar(255)", "NO", null, "utf8mb4_bin"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "body_hash", "char(64)", "NO", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "media_manifest_hash", "char(64)", "NO", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "work_intent_json", "json", "NO"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "ack_eligible_at", "varchar(64)", "YES"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "media_consumption_receipt_hash", "char(64)", "YES", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "media_consumed_at", "varchar(64)", "YES"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "lease_owner", "varchar(128)", "YES", null, "ascii_bin"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "lease_epoch", "bigint unsigned", "NO", "0"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "lease_expires_at", "varchar(64)", "YES"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "session_id", "varchar(128)", "YES"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "generation", "bigint unsigned", "YES"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "received_at", "varchar(64)", "NO"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "acknowledged_at", "varchar(64)", "YES"),
  requiredColumn(GODADDY_MATRIX_INGRESS_TABLE, "updated_at", "timestamp(6)", "NO", "current_timestamp(6)")
]);

const REQUIRED_SCHEMA_INDEXES = Object.freeze([
  { table: GODADDY_STATE_TABLE, name: "PRIMARY", unique: true, columns: Object.freeze(["state_namespace", "state_key"]) },
  { table: GODADDY_MATRIX_OUTBOX_TABLE, name: "PRIMARY", unique: true, columns: Object.freeze(["generation", "sequence_no"]) },
  { table: GODADDY_MATRIX_OUTBOX_TABLE, name: "uq_matrix_outbox_transaction", unique: true, columns: Object.freeze(["transaction_id"]) },
  { table: GODADDY_MATRIX_OUTBOX_TABLE, name: "uq_matrix_outbox_event", unique: true, columns: Object.freeze(["matrix_event_id"]) },
  { table: GODADDY_MATRIX_OUTBOX_TABLE, name: "ix_matrix_outbox_head", unique: false, columns: Object.freeze(["state", "generation", "sequence_no"]) },
  { table: GODADDY_MATRIX_INGRESS_TABLE, name: "PRIMARY", unique: true, columns: Object.freeze(["event_id"]) },
  { table: GODADDY_MATRIX_INGRESS_TABLE, name: "ix_matrix_ingress_recovery", unique: false, columns: Object.freeze(["state", "lease_expires_at"]) }
]);

const schemaText = (row: Readonly<Record<string, unknown>>, camel: string, upper: string): string | undefined => {
  const value = row[camel] ?? row[upper];
  return typeof value === "string" ? value : undefined;
};

const schemaValue = (row: Readonly<Record<string, unknown>>, camel: string, upper: string): unknown =>
  Object.hasOwn(row, camel) ? row[camel] : row[upper];

function schemaMatches(rows: readonly Readonly<Record<string, unknown>>[]): boolean {
  const byColumn = new Map(rows.map((row) => [
    `${schemaText(row, "tableName", "TABLE_NAME")}\0${schemaText(row, "columnName", "COLUMN_NAME")}`,
    row
  ]));
  return REQUIRED_SCHEMA_COLUMNS.every((requirement) => {
    const row = byColumn.get(`${requirement.table}\0${requirement.column}`);
    if (row === undefined) return false;
    const collation = schemaText(row, "collationName", "COLLATION_NAME")?.toLowerCase();
    const columnType = schemaText(row, "columnType", "COLUMN_TYPE")?.toLowerCase();
    const nullable = schemaText(row, "isNullable", "IS_NULLABLE")?.toUpperCase();
    const rawDefault = schemaValue(row, "columnDefault", "COLUMN_DEFAULT");
    const defaultValue = rawDefault === null || rawDefault === undefined ? null : String(rawDefault).toLowerCase();
    return columnType === requirement.columnType
      && nullable === requirement.nullable
      && defaultValue === requirement.defaultValue
      && (requirement.collation === undefined || collation === requirement.collation);
  });
}

function tablesMatch(rows: readonly Readonly<Record<string, unknown>>[]): boolean {
  const tables = new Map(rows.map((row) => [
    schemaText(row, "tableName", "TABLE_NAME"),
    Object.freeze({
      engine: schemaText(row, "engine", "ENGINE")?.toLowerCase(),
      tableType: schemaText(row, "tableType", "TABLE_TYPE")?.toLowerCase()
    })
  ]));
  return [GODADDY_STATE_TABLE, GODADDY_MATRIX_OUTBOX_TABLE, GODADDY_MATRIX_INGRESS_TABLE]
    .every((table) => tables.get(table)?.engine === "innodb" && tables.get(table)?.tableType === "base table");
}

function indexesMatch(rows: readonly Readonly<Record<string, unknown>>[]): boolean {
  return REQUIRED_SCHEMA_INDEXES.every((requirement) => {
    const entries = rows.filter((row) =>
      schemaText(row, "tableName", "TABLE_NAME") === requirement.table
      && schemaText(row, "indexName", "INDEX_NAME") === requirement.name
    ).sort((left, right) =>
      Number(schemaValue(left, "sequenceInIndex", "SEQ_IN_INDEX"))
      - Number(schemaValue(right, "sequenceInIndex", "SEQ_IN_INDEX"))
    );
    if (entries.length !== requirement.columns.length) return false;
    return entries.every((row, index) =>
      Number(schemaValue(row, "nonUnique", "NON_UNIQUE")) === (requirement.unique ? 0 : 1)
      && Number(schemaValue(row, "sequenceInIndex", "SEQ_IN_INDEX")) === index + 1
      && schemaText(row, "columnName", "COLUMN_NAME") === requirement.columns[index]
      && (schemaValue(row, "subPart", "SUB_PART") === null || schemaValue(row, "subPart", "SUB_PART") === undefined)
      && schemaText(row, "indexType", "INDEX_TYPE")?.toLowerCase() === "btree"
    );
  });
}

async function defaultDatabaseProbe(pool: MySqlPool): Promise<GoDaddyMatrixDatabaseProbe> {
  let schemaRows: readonly Readonly<Record<string, unknown>>[];
  let tableRows: readonly Readonly<Record<string, unknown>>[];
  let indexRows: readonly Readonly<Record<string, unknown>>[];
  try {
    const [rawSchemaRows] = await pool.execute(
      `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType,
              IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS columnDefault, COLLATION_NAME AS collationName
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?)
       ORDER BY TABLE_NAME ASC, ORDINAL_POSITION ASC`,
      [GODADDY_STATE_TABLE, GODADDY_MATRIX_OUTBOX_TABLE, GODADDY_MATRIX_INGRESS_TABLE]
    );
    schemaRows = safeRows(rawSchemaRows);
    const [rawTableRows] = await pool.execute(
      `SELECT TABLE_NAME AS tableName, ENGINE AS engine, TABLE_TYPE AS tableType
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?)
       ORDER BY TABLE_NAME ASC`,
      [GODADDY_STATE_TABLE, GODADDY_MATRIX_OUTBOX_TABLE, GODADDY_MATRIX_INGRESS_TABLE]
    );
    tableRows = safeRows(rawTableRows);
    const [rawIndexRows] = await pool.execute(
      `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
              SEQ_IN_INDEX AS sequenceInIndex, COLUMN_NAME AS columnName,
              SUB_PART AS subPart, INDEX_TYPE AS indexType
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?)
       ORDER BY TABLE_NAME ASC, INDEX_NAME ASC, SEQ_IN_INDEX ASC`,
      [GODADDY_STATE_TABLE, GODADDY_MATRIX_OUTBOX_TABLE, GODADDY_MATRIX_INGRESS_TABLE]
    );
    indexRows = safeRows(rawIndexRows);
  } catch {
    return Object.freeze({
      mysqlAvailable: false,
      schemaAvailable: false,
      outboxAvailable: false,
      ingressAvailable: false
    });
  }
  if (!schemaMatches(schemaRows) || !tablesMatch(tableRows) || !indexesMatch(indexRows)) {
    return Object.freeze({
      mysqlAvailable: true,
      schemaAvailable: false,
      outboxAvailable: false,
      ingressAvailable: false
    });
  }
  try {
    const [outboxRows] = await pool.execute(
      `SELECT state FROM ${GODADDY_MATRIX_OUTBOX_TABLE}
       WHERE state IN ('pending', 'leased', 'blocked')
       ORDER BY generation ASC, sequence_no ASC LIMIT 1`,
      []
    );
    const [ingressRows] = await pool.execute(
      `SELECT state FROM ${GODADDY_MATRIX_INGRESS_TABLE} WHERE state = 'blocked' LIMIT 1`,
      []
    );
    if (!Array.isArray(outboxRows) || !Array.isArray(ingressRows)) throw new Error("invalid_schema_probe");
    const outboxHead = safeRows(outboxRows)[0];
    const ingressBlocked = safeRows(ingressRows).some((row) => row.state === "blocked");
    return Object.freeze({
      mysqlAvailable: true,
      schemaAvailable: true,
      outboxAvailable: outboxHead?.state !== "blocked",
      ingressAvailable: !ingressBlocked
    });
  } catch {
    return Object.freeze({
      mysqlAvailable: true,
      schemaAvailable: false,
      outboxAvailable: false,
      ingressAvailable: false
    });
  }
}

function defaultLeaseOwner(): string {
  return `mx-${Buffer.from(randomBytes(16)).toString("hex")}`;
}

function positiveBounded(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum
    ? value as number
    : fallback;
}

function errorCode(error: unknown): KnownErrorCode | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as Readonly<{ code?: unknown }>).code;
  return typeof code === "string" ? code as KnownErrorCode : undefined;
}

function transientSidecarError(code: KnownErrorCode | undefined): boolean {
  return code === "not_ready"
    || code === "transport_failed"
    || code === "request_timeout"
    || code === "backpressure_timeout"
    || code === "request_limit"
    || code === "stopped"
    || code === "spawn_failed"
    || code === "handshake_timeout"
    || code === "lock_contended";
}

function provablyPreDispatchPublicationError(code: KnownErrorCode | undefined): boolean {
  // `request_limit` is rejected before the supervisor writes a frame. Other
  // runtime/transient errors can reject an already-written in-flight request
  // after its Matrix effect became outcome-ambiguous.
  return code === "request_limit";
}

function retryDelay(attemptCount: number): number {
  return Math.min(MAX_RETRY_MILLISECONDS, 1_000 * (2 ** Math.max(0, Math.min(attemptCount - 1, 5))));
}

function exactRoomPolicy(configuration: GoDaddyMatrixConfiguration, observedAtMs: number): MatrixRoomPolicySnapshot {
  return Object.freeze({
    encrypted: true,
    inviteOnly: true,
    joinedMembers: Object.freeze([configuration.ownerMxid, configuration.botMxid]),
    pendingInvites: 0,
    historyVisibilityJoined: true,
    publicAlias: false,
    publicListing: false,
    guestsAllowed: false,
    bridgesPresent: false,
    widgetsPresent: false,
    ownerDevicesTrusted: true,
    botDeviceTrusted: true,
    devicesNonRevoked: true,
    observedAtMs
  });
}

function ingressMediaManifest(event: ValidatedMatrixIngress): MatrixIngressIntent["media"] {
  return Object.freeze(event.media.map((item) => Object.freeze({
    declaredMime: item.declaredMime,
    length: item.length,
    sha256: item.sha256
  })));
}

function ingressHashes(event: ValidatedMatrixIngress): Readonly<{
  bodyHash: string;
  mediaManifestHash: string;
  eventHash: string;
  media: MatrixIngressIntent["media"];
}> {
  const media = ingressMediaManifest(event);
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
  return Object.freeze({ bodyHash, mediaManifestHash, eventHash, media });
}

function sameIngress(left: ValidatedMatrixIngress, right: ValidatedMatrixIngress): boolean {
  return sha256Json(left) === sha256Json(right);
}

function sameIngressRejection(
  left: ValidatedMatrixIngressRejection,
  right: ValidatedMatrixIngressRejection
): boolean {
  return left.receiptId === right.receiptId
    && left.eventId === right.eventId
    && left.roomId === right.roomId
    && left.senderMxid === right.senderMxid
    && left.senderDeviceId === right.senderDeviceId
    && left.bodyHash === right.bodyHash
    && left.mediaManifestHash === right.mediaManifestHash
    && left.eventHash === right.eventHash
    && left.reason === right.reason;
}

function rejectionMatchesIngress(
  rejection: ValidatedMatrixIngressRejection,
  event: ValidatedMatrixIngress
): boolean {
  if (
    event.media.length === 0
    || rejection.receiptId !== event.receiptId
    || rejection.eventId !== event.eventId
    || rejection.roomId !== event.roomId
    || rejection.senderMxid !== event.senderMxid
    || rejection.senderDeviceId !== event.senderDeviceId
  ) return false;
  const hashes = ingressHashes(event);
  return rejection.bodyHash === hashes.bodyHash
    && rejection.mediaManifestHash === hashes.mediaManifestHash
    && rejection.eventHash === hashes.eventHash;
}

function containsSecretLikeContent(event: ValidatedMatrixIngress): boolean {
  const body = event.body;
  return body !== null && isSecretLikeMatrixContent(body);
}

function safeDisabledService(reason: ServiceReason): GoDaddyMatrixService {
  const readiness: GoDaddyMatrixServiceReadiness = Object.freeze({ configured: false, ready: false, reason });
  return Object.freeze({
    configured: false,
    async start(): Promise<void> {},
    wakeOutbox(): void {},
    getReadiness: () => readiness,
    assertReadyForNewSession(): void { throw new MatrixSidecarError("not_ready"); },
    async stop(): Promise<void> {}
  });
}

/**
 * Owns the one Published Matrix process and its MySQL ingress/outbox pumps.
 * The factory deliberately accepts an already-shared pool and registrar so it
 * cannot create a second state pool. Preview/test return before any stateful
 * dependency, filesystem path, timer or sidecar is touched.
 */
export function createGoDaddyMatrixService(
  input: Readonly<{
    environment: Record<string, unknown>;
    pool: MySqlPool;
    registrarRuntime: GoDaddyRegistrarRuntime;
    now?: () => Date;
  }>,
  dependencies: GoDaddyMatrixServiceDependencies = {}
): GoDaddyMatrixService {
  if (input.environment.RUNTIME_MODE !== "production") {
    return safeDisabledService("matrix_disabled_for_runtime");
  }
  if (input.environment.GODADDY_STATE_DATABASE_ROLE !== "published") {
    return safeDisabledService("matrix_state_database_not_enabled");
  }

  const parsed = (dependencies.parseConfiguration ?? parseGoDaddyMatrixConfiguration)(input.environment);
  if (!parsed.ok) return safeDisabledService(parsed.code);
  const publicationSynchronizer = dependencies.publicationSynchronizer
    ?? (input.registrarRuntime as GoDaddyRegistrarRuntime & Readonly<{
      matrixPublicationSynchronizer?: MatrixPublicationSynchronizer;
    }>).matrixPublicationSynchronizer;
  if (publicationSynchronizer === undefined) return safeDisabledService("publication_fence_unavailable");
  const requiredPublicationSynchronizer: MatrixPublicationSynchronizer = publicationSynchronizer;
  const configuration = parsed.value;
  const now = input.now ?? (() => new Date());
  const clock = dependencies.clock ?? nativeClock;
  const pollMilliseconds = positiveBounded(dependencies.pollMilliseconds, DEFAULT_POLL_MILLISECONDS, 60_000);
  const probeTimeoutMilliseconds = positiveBounded(
    dependencies.probeTimeoutMilliseconds,
    DEFAULT_PROBE_TIMEOUT_MILLISECONDS,
    60_000
  );
  const stopTimeoutMilliseconds = positiveBounded(
    dependencies.stopTimeoutMilliseconds,
    DEFAULT_STOP_TIMEOUT_MILLISECONDS,
    60_000
  );
  const leaseOwner = (dependencies.leaseOwner ?? defaultLeaseOwner)();
  if (!LEASE_OWNER.test(leaseOwner)) return safeDisabledService("matrix_configuration_invalid");
  const probeDatabase = dependencies.probeDatabase ?? defaultDatabaseProbe;
  const readStoreBinding = dependencies.readStoreBinding ?? readExistingMatrixStoreBinding;
  const createSupervisor = dependencies.createSupervisor ?? ((options) => new MatrixSidecarSupervisor(options));
  const createRuntime = dependencies.createRuntime ?? createMatrixRuntime;
  const binding: RoomBinding = Object.freeze({
    roomId: configuration.roomId,
    ownerMxid: configuration.ownerMxid,
    botMxid: configuration.botMxid,
    homeserver: "matrix.org",
    botDeviceId: configuration.botDeviceId
  });

  let runtime: MatrixRuntime | undefined;
  let unsubscribeIngress: (() => void) | undefined;
  let unsubscribeRejectedIngress: (() => void) | undefined;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let initializationPromise: Promise<void> | undefined;
  let probePromise: Promise<void> | undefined;
  let outboxRun: Promise<void> | undefined;
  let ingressRun: Promise<void> | undefined;
  let started = false;
  let stopping = false;
  let stopped = false;
  let lifecycleGeneration = 0;
  let terminalReason: ServiceReason | undefined;
  let mediaConsumerUnavailable = dependencies.mediaConsumer === undefined;
  let database: GoDaddyMatrixDatabaseProbe = Object.freeze({
    mysqlAvailable: false,
    schemaAvailable: false,
    outboxAvailable: false,
    ingressAvailable: false
  });
  let wakeEpoch = 0;
  const maintenanceTimer: TimerSlot = { dueAt: Number.POSITIVE_INFINITY };
  const outboxTimer: TimerSlot = { dueAt: Number.POSITIVE_INFINITY };
  const ingressTimer: TimerSlot = { dueAt: Number.POSITIVE_INFINITY };
  const ingressQueue: string[] = [];
  const ingressTasks = new Map<string, IngressTask>();

  const active = (generation = lifecycleGeneration): boolean =>
    started && !stopping && !stopped && terminalReason === undefined && generation === lifecycleGeneration;
  const draining = (): boolean =>
    started && stopping && !stopped && terminalReason === undefined;

  const clearTimerSlot = (slot: TimerSlot): void => {
    if (slot.handle !== undefined) clock.clearTimeout(slot.handle);
    slot.handle = undefined;
    slot.dueAt = Number.POSITIVE_INFINITY;
  };

  const schedule = (slot: TimerSlot, delay: number, callback: () => void): void => {
    if (!active()) return;
    const boundedDelay = Math.max(0, Math.min(delay, MAX_RETRY_MILLISECONDS));
    const dueAt = clock.now() + boundedDelay;
    if (slot.handle !== undefined && slot.dueAt <= dueAt) return;
    clearTimerSlot(slot);
    slot.dueAt = dueAt;
    slot.handle = clock.setTimeout(() => {
      slot.handle = undefined;
      slot.dueAt = Number.POSITIVE_INFINITY;
      callback();
    }, boundedDelay);
  };

  const scheduleMaintenance = (delay = pollMilliseconds): void => {
    schedule(maintenanceTimer, delay, () => { void runMaintenance(); });
  };

  const scheduleIngress = (delay = 0): void => {
    schedule(ingressTimer, delay, () => { void runIngress(); });
  };

  const scheduleOutbox = (delay = 0): void => {
    schedule(outboxTimer, delay, () => { void runOutbox(); });
  };

  const scheduleIngressIfIdle = (): void => {
    if (ingressTimer.handle === undefined && ingressRun === undefined) scheduleIngress(0);
  };

  const scheduleOutboxIfIdle = (): void => {
    if (outboxTimer.handle === undefined && outboxRun === undefined) scheduleOutbox(0);
  };

  const markDatabaseUnavailable = (): void => {
    database = Object.freeze({
      mysqlAvailable: false,
      schemaAvailable: database.schemaAvailable,
      outboxAvailable: false,
      ingressAvailable: false
    });
    scheduleMaintenance(0);
  };

  const runtimeDependencyReadiness = (): MatrixRuntimeDependencyReadiness => Object.freeze({
    mysqlAvailable: (active() || draining()) && database.mysqlAvailable && database.schemaAvailable,
    outboxAvailable: (active() || draining()) && database.outboxAvailable && database.ingressAvailable,
    egressPolicyPass: true
  });

  const unsubscribeRuntimeIngress = (): void => {
    unsubscribeRejectedIngress?.();
    unsubscribeRejectedIngress = undefined;
    unsubscribeIngress?.();
    unsubscribeIngress = undefined;
  };

  const setTerminal = (reason: ServiceReason): void => {
    if (terminalReason === undefined) terminalReason = reason;
    unsubscribeRuntimeIngress();
    clearTimerSlot(maintenanceTimer);
    clearTimerSlot(outboxTimer);
    clearTimerSlot(ingressTimer);
  };

  const currentReadiness = (): GoDaddyMatrixServiceReadiness => {
    if (stopped) return Object.freeze({ configured: true, ready: false, reason: terminalReason ?? "stopped" });
    if (stopping) return Object.freeze({ configured: true, ready: false, reason: "stopping" });
    if (!started) return Object.freeze({ configured: true, ready: false, reason: "not_started" });
    if (terminalReason !== undefined) return Object.freeze({ configured: true, ready: false, reason: terminalReason });
    if (!database.mysqlAvailable) return Object.freeze({ configured: true, ready: false, reason: "database_unavailable" });
    if (!database.schemaAvailable) return Object.freeze({ configured: true, ready: false, reason: "schema_unavailable" });
    if (!database.outboxAvailable) return Object.freeze({ configured: true, ready: false, reason: "outbox_blocked" });
    if (!database.ingressAvailable) return Object.freeze({ configured: true, ready: false, reason: "ingress_blocked" });
    if (mediaConsumerUnavailable) {
      return Object.freeze({ configured: true, ready: false, reason: "media_consumer_unavailable" });
    }
    let matrix: ReturnType<MatrixRuntime["getReadiness"]> | undefined;
    try {
      matrix = runtime?.getReadiness();
    } catch {
      return Object.freeze({ configured: true, ready: false, reason: "sidecar_not_ready" });
    }
    if (matrix === undefined) return Object.freeze({ configured: true, ready: false, reason: "starting" });
    if (matrix.circuitOpen) return Object.freeze({ configured: true, ready: false, reason: "circuit_open" });
    if (matrix.reason === "lock_contended") {
      return Object.freeze({ configured: true, ready: false, reason: "lock_contended" });
    }
    if (matrix.reason === "termination_failed") {
      return Object.freeze({ configured: true, ready: false, reason: "termination_failed" });
    }
    if (matrix.matrixReadiness !== "ready") {
      return Object.freeze({ configured: true, ready: false, reason: "sidecar_not_ready" });
    }
    return Object.freeze({ configured: true, ready: true, reason: "ready" });
  };

  const probeOnce = (): Promise<void> => {
    if (probePromise !== undefined) return probePromise;
    const generation = lifecycleGeneration;
    let timeoutHandle: unknown;
    const timeout = new Promise<undefined>((resolve) => {
      timeoutHandle = clock.setTimeout(() => resolve(undefined), probeTimeoutMilliseconds);
    });
    const databaseOperation = Promise.resolve(probeDatabase(input.pool)).then((value) => value, () => undefined);
    const operation = (async (): Promise<void> => {
      const result = await Promise.race([databaseOperation, timeout]);
      clock.clearTimeout(timeoutHandle);
      if (!active(generation)) return;
      database = result === undefined
        ? Object.freeze({ mysqlAvailable: false, schemaAvailable: false, outboxAvailable: false, ingressAvailable: false })
        : Object.freeze({
            mysqlAvailable: result.mysqlAvailable === true,
            schemaAvailable: result.schemaAvailable === true,
            outboxAvailable: result.outboxAvailable === true,
            ingressAvailable: result.ingressAvailable === true
      });
      if (database.mysqlAvailable && database.schemaAvailable) {
        wakeEpoch = wakeEpoch >= Number.MAX_SAFE_INTEGER ? 1 : wakeEpoch + 1;
        scheduleIngressIfIdle();
        scheduleOutboxIfIdle();
      }
    })();
    let tracked: Promise<void>;
    tracked = operation.finally(() => {
      if (probePromise === tracked) probePromise = undefined;
    });
    probePromise = tracked;
    return tracked;
  };

  const enqueueIngress = (event: ValidatedMatrixIngress): void => {
    if (!active()) return;
    const existing = ingressTasks.get(event.receiptId);
    if (existing !== undefined) {
      if (
        (existing.rejection !== undefined && !rejectionMatchesIngress(existing.rejection, event))
        || (existing.rejection === undefined && (existing.event === undefined || !sameIngress(existing.event, event)))
      ) setTerminal("ingress_blocked");
      return;
    }
    if (ingressTasks.size >= MAX_INGRESS_QUEUE) {
      setTerminal("ingress_blocked");
      return;
    }
    ingressTasks.set(event.receiptId, {
      event,
      attemptCount: 0,
      normalPersisted: false,
      rejectionPersisted: false,
      durableAck: false,
      ackApplied: false,
      evidenceRecorded: false
    });
    ingressQueue.push(event.receiptId);
    scheduleIngress(0);
  };

  const enqueueIngressRejection = (rejection: ValidatedMatrixIngressRejection): void => {
    if (!active()) return;
    const existing = ingressTasks.get(rejection.receiptId);
    if (existing !== undefined) {
      if (
        (existing.rejection !== undefined && !sameIngressRejection(existing.rejection, rejection))
        || (existing.event !== undefined && !rejectionMatchesIngress(rejection, existing.event))
        || (existing.rejection === undefined && existing.event === undefined)
      ) {
        setTerminal("ingress_blocked");
        return;
      }
      if (existing.rejection === undefined) {
        existing.rejection = rejection;
        // The rejection carries the authenticated identity and hashes needed
        // for durable reconciliation. Drop the plaintext/media-bearing event
        // from the queued task immediately so no later phase can consume it.
        existing.event = undefined;
        existing.eventHash = rejection.eventHash;
        existing.mediaManifestHash = rejection.mediaManifestHash;
        existing.rejectionPersisted = false;
        existing.durableAck = false;
        existing.attemptCount = 0;
      }
      scheduleIngress(0);
      return;
    }
    if (ingressTasks.size >= MAX_INGRESS_QUEUE) {
      setTerminal("ingress_blocked");
      return;
    }
    ingressTasks.set(rejection.receiptId, {
      event: undefined,
      rejection,
      attemptCount: 0,
      eventHash: rejection.eventHash,
      mediaManifestHash: rejection.mediaManifestHash,
      normalPersisted: false,
      rejectionPersisted: false,
      durableAck: false,
      ackApplied: false,
      evidenceRecorded: false
    });
    ingressQueue.push(rejection.receiptId);
    scheduleIngress(0);
  };

  const classifyStartError = (error: unknown, generation: number): void => {
    if (!active(generation)) return;
    const code = errorCode(error);
    if (code === "termination_failed") {
      setTerminal("termination_failed");
      return;
    }
    if (transientSidecarError(code)) {
      scheduleMaintenance(retryDelay(1));
      return;
    }
    setTerminal("sidecar_not_ready");
  };

  const ensureRuntimeStarted = (generation: number): Promise<void> => {
    if (initializationPromise !== undefined) return initializationPromise;
    const operation = (async (): Promise<void> => {
      if (!active(generation) || !database.mysqlAvailable || !database.schemaAvailable) return;
      if (runtime === undefined) {
        const storeBinding = await readStoreBinding({
          storeDir: configuration.storeDir,
          expectedDeviceId: configuration.botDeviceId
        });
        if (!active(generation)) return;
        if (!storeBinding.ok) {
          setTerminal(storeBinding.code);
          return;
        }
        try {
          const supervisor = createSupervisor({
            binaryPath: configuration.binaryPath,
            expectedSha256: configuration.expectedSha256,
            protocolVersion: configuration.protocolVersion,
            expectedIdentity: Object.freeze({
              build: configuration.expectedBuild,
              homeserverOrigin: configuration.homeserverOrigin,
              ...configuration.expectedIdentityHashes,
              storeFingerprint: storeBinding.value.storeFingerprint
            }),
            argumentsList: Object.freeze(["--application-root", configuration.applicationRoot]),
            spawnEnvironment: configuration.spawnEnvironment,
            cwd: configuration.applicationRoot
          });
          if (!active(generation)) return;
          const createdRuntime = createRuntime({
            supervisor,
            config: Object.freeze({
              homeserverUrl: configuration.homeserverOrigin,
              roomId: configuration.roomId,
              ownerMxid: configuration.ownerMxid,
              botMxid: configuration.botMxid,
              botDeviceId: configuration.botDeviceId,
              mediaSpoolParent: configuration.mediaSpoolDir
            }),
            readiness: runtimeDependencyReadiness
          });
          if (!active(generation)) {
            await createdRuntime.stop().catch(() => undefined);
            return;
          }
          let nextUnsubscribeIngress: (() => void) | undefined;
          let nextUnsubscribeRejectedIngress: (() => void) | undefined;
          try {
            nextUnsubscribeIngress = createdRuntime.onIngress((event) => {
              try {
                enqueueIngress(event);
              } catch {
                setTerminal("ingress_blocked");
              }
            });
            nextUnsubscribeRejectedIngress = createdRuntime.onRejectedIngress((rejection) => {
              try {
                enqueueIngressRejection(rejection);
              } catch {
                setTerminal("ingress_blocked");
              }
            });
          } catch (error) {
            nextUnsubscribeRejectedIngress?.();
            nextUnsubscribeIngress?.();
            await createdRuntime.stop().catch(() => undefined);
            throw error;
          }
          if (!active(generation)) {
            nextUnsubscribeRejectedIngress();
            nextUnsubscribeIngress();
            await createdRuntime.stop().catch(() => undefined);
            return;
          }
          runtime = createdRuntime;
          unsubscribeIngress = nextUnsubscribeIngress;
          unsubscribeRejectedIngress = nextUnsubscribeRejectedIngress;
        } catch (error) {
          classifyStartError(error, generation);
          return;
        }
      }
      if (!active(generation)) return;
      try {
        await runtime.start();
      } catch (error) {
        classifyStartError(error, generation);
      }
    })();
    let tracked: Promise<void>;
    tracked = operation.finally(() => {
      if (initializationPromise === tracked) initializationPromise = undefined;
    });
    initializationPromise = tracked;
    return tracked;
  };

  async function runMaintenance(): Promise<void> {
    if (!active()) return;
    const generation = lifecycleGeneration;
    await probeOnce();
    if (!active(generation)) return;
    if (database.mysqlAvailable && database.schemaAvailable) await ensureRuntimeStarted(generation);
    if (!active(generation)) return;
    scheduleIngressIfIdle();
    scheduleOutboxIfIdle();
    scheduleMaintenance();
  }

  const persistIngress = async (task: IngressTask): Promise<boolean> => {
    const event = task.event;
    if (event === undefined) {
      setTerminal("ingress_blocked");
      return false;
    }
    const hashes = ingressHashes(event);
    task.eventHash = hashes.eventHash;
    task.mediaManifestHash = hashes.mediaManifestHash;
    try {
      if (containsSecretLikeContent(event)) {
        const rejected = await input.registrarRuntime.matrixIngressReceipts.persistRejection({
          eventId: event.eventId,
          eventHash: hashes.eventHash,
          roomId: event.roomId,
          ownerMxid: event.senderMxid,
          bodyHash: hashes.bodyHash,
          mediaManifestHash: hashes.mediaManifestHash,
          rejectionCode: "secret_like_content",
          now: now()
        });
        if (!rejected.ok) {
          setTerminal("ingress_blocked");
          return false;
        }
        task.normalPersisted = true;
        task.durableAck = rejected.durableAck;
        return true;
      }
      const workIntent: MatrixIngressIntent = Object.freeze({
        eventId: event.eventId,
        roomId: event.roomId,
        ownerMxid: event.senderMxid,
        senderDeviceId: event.senderDeviceId,
        body: event.body,
        ...(event.relationEventId === undefined ? {} : { relationEventId: event.relationEventId }),
        media: hashes.media
      });
      const persisted = await input.registrarRuntime.matrixIngressReceipts.persistIntent({
        eventId: event.eventId,
        eventHash: hashes.eventHash,
        roomId: event.roomId,
        ownerMxid: event.senderMxid,
        bodyHash: hashes.bodyHash,
        workIntent,
        mediaManifestHash: hashes.mediaManifestHash,
        requiresMediaConsumption: event.media.length > 0,
        now: now()
      });
      if (!persisted.ok) {
        setTerminal("ingress_blocked");
        return false;
      }
      task.normalPersisted = true;
      task.durableAck = persisted.durableAck;
      return true;
    } catch (error) {
      if (errorCode(error) === "matrix_ingress_corrupt") throw error;
      markDatabaseUnavailable();
      throw error;
    }
  };

  const persistIngressRejection = async (task: IngressTask): Promise<boolean> => {
    const rejection = task.rejection;
    if (rejection === undefined || rejection.reason !== "media_expired") {
      setTerminal("ingress_blocked");
      return false;
    }
    try {
      const persisted = await input.registrarRuntime.matrixIngressReceipts.persistRejection({
        eventId: rejection.eventId,
        eventHash: rejection.eventHash,
        roomId: rejection.roomId,
        ownerMxid: rejection.senderMxid,
        bodyHash: rejection.bodyHash,
        mediaManifestHash: rejection.mediaManifestHash,
        rejectionCode: "media_expired",
        now: now()
      });
      if (!persisted.ok || !persisted.durableAck) {
        setTerminal("ingress_blocked");
        return false;
      }
      task.eventHash = rejection.eventHash;
      task.mediaManifestHash = rejection.mediaManifestHash;
      task.rejectionPersisted = true;
      task.durableAck = true;
      return true;
    } catch (error) {
      if (errorCode(error) === "matrix_ingress_corrupt") throw error;
      markDatabaseUnavailable();
      throw error;
    }
  };

  const consumeMedia = async (task: IngressTask): Promise<boolean> => {
    const event = task.event;
    if (event === undefined) {
      setTerminal("ingress_blocked");
      return false;
    }
    if (event.media.length === 0 || task.durableAck) return true;
    const mediaConsumer = dependencies.mediaConsumer;
    if (mediaConsumer === undefined) {
      mediaConsumerUnavailable = true;
      return false;
    }
    const activeRuntime = runtime;
    if (activeRuntime === undefined || task.eventHash === undefined || task.mediaManifestHash === undefined) return false;
    if (task.mediaConsumptionReceiptHash === undefined) {
      let objects: readonly MatrixIngressMediaObject[] = Object.freeze([]);
      try {
        objects = await activeRuntime.readMedia(event.media);
        // Rust has already deleted expired spool objects and replaced the
        // receipt. Never hand bytes to a consumer once that replacement is
        // visible, even if a concurrent read completed successfully.
        if (task.rejection !== undefined) return false;
        const receipt = await mediaConsumer({ eventHash: task.eventHash, event, objects });
        if (
          receipt.eventHash !== task.eventHash
          || !SHA256.test(receipt.eventHash)
          || !SHA256.test(receipt.consumptionReceiptHash)
        ) {
          setTerminal("ingress_blocked");
          return false;
        }
        task.mediaConsumptionReceiptHash = receipt.consumptionReceiptHash;
      } finally {
        for (const object of objects) object.bytes.fill(0);
      }
    }
    let consumed: boolean;
    try {
      consumed = await input.registrarRuntime.matrixIngressReceipts.markMediaConsumed({
        eventId: event.eventId,
        eventHash: task.eventHash,
        mediaManifestHash: task.mediaManifestHash,
        consumptionReceiptHash: task.mediaConsumptionReceiptHash,
        now: now()
      });
    } catch (error) {
      markDatabaseUnavailable();
      throw error;
    }
    if (!consumed) {
      setTerminal("ingress_blocked");
      return false;
    }
    task.durableAck = true;
    mediaConsumerUnavailable = false;
    return true;
  };

  const completeIngress = async (task: IngressTask): Promise<boolean> => {
    const activeRuntime = runtime;
    const identity = task.rejection ?? task.event;
    if (activeRuntime === undefined || identity === undefined || task.eventHash === undefined || !task.durableAck) {
      return false;
    }
    if (!task.ackApplied) {
      await activeRuntime.ackIngress({
        receiptId: identity.receiptId,
        durableReceiptId: task.eventHash
      });
      task.ackApplied = true;
    }
    if (task.evidenceRecorded) return true;
    let recorded: boolean;
    try {
      recorded = await input.registrarRuntime.matrixIngressReceipts.acknowledge(
        identity.eventId,
        task.eventHash,
        now()
      );
    } catch (error) {
      markDatabaseUnavailable();
      throw error;
    }
    if (!recorded) throw new Error("matrix_ack_evidence_unavailable");
    task.evidenceRecorded = true;
    return true;
  };

  async function runIngress(allowStopping = false): Promise<void> {
    if (ingressRun !== undefined) return ingressRun;
    if (!(active() || (allowStopping && draining()))) return;
    const operation = (async (): Promise<void> => {
      while (!stopped && terminalReason === undefined && (!stopping || allowStopping)) {
        const receiptId = ingressQueue[0];
        if (receiptId === undefined) return;
        const task = ingressTasks.get(receiptId);
        if (task === undefined) {
          ingressQueue.shift();
          continue;
        }
        try {
          if (task.rejection !== undefined) {
            if (!task.rejectionPersisted && !(await persistIngressRejection(task))) return;
          } else if (!task.normalPersisted && !(await persistIngress(task))) {
            return;
          }
          if (task.rejection !== undefined && !task.rejectionPersisted) continue;
          if (task.rejection !== undefined) {
            if (!(await completeIngress(task))) return;
            ingressTasks.delete(receiptId);
            ingressQueue.shift();
            task.attemptCount = 0;
            if (stopping && !allowStopping) return;
            continue;
          }
          if (!(await consumeMedia(task))) {
            if (task.rejection !== undefined) continue;
            return;
          }
          if (task.rejection !== undefined) continue;
          if (!(await completeIngress(task))) return;
          if (task.rejection !== undefined && !task.rejectionPersisted) continue;
          ingressTasks.delete(receiptId);
          ingressQueue.shift();
          task.attemptCount = 0;
        } catch (error) {
          task.attemptCount += 1;
          const code = errorCode(error);
          if (
            code === "matrix_ingress_corrupt"
            || code === "protocol_error"
            || code === "media_denied"
            || code === "invalid_configuration"
          ) {
            setTerminal("ingress_blocked");
            return;
          }
          scheduleIngress(retryDelay(task.attemptCount));
          return;
        }
        if (stopping && !allowStopping) return;
      }
    })();
    let tracked: Promise<void>;
    tracked = operation.finally(() => {
      if (ingressRun === tracked) ingressRun = undefined;
    });
    ingressRun = tracked;
    return tracked;
  }

  const blockLease = async (lease: LeasedMatrixOutboxRecord, reason: "policy_denied" | "retry_exhausted"): Promise<void> => {
    try {
      await input.registrarRuntime.matrixOutbox.markBlocked(lease, reason, now());
    } catch {
      markDatabaseUnavailable();
    } finally {
      setTerminal(reason === "retry_exhausted" ? "retry_exhausted" : "outbox_blocked");
    }
  };

  const releaseLease = async (lease: LeasedMatrixOutboxRecord, code: string): Promise<void> => {
    if (lease.attemptCount >= MAX_OUTBOX_ATTEMPTS) {
      await blockLease(lease, "retry_exhausted");
      return;
    }
    try {
      await input.registrarRuntime.matrixOutbox.releaseTransient(
        lease,
        code,
        now(),
        retryDelay(lease.attemptCount)
      );
    } catch {
      markDatabaseUnavailable();
    }
  };

  const deliverLease = async (lease: LeasedMatrixOutboxRecord): Promise<"accepted" | "stop"> => {
    const activeRuntime = runtime;
    if (activeRuntime === undefined) return "stop";
    const delivery = formatConfirmedMessageForMatrix(binding, lease.message, lease.replyToEventId);
    let acceptedEventId: string;
    try {
      const accepted = await activeRuntime.send({
        transactionId: lease.transactionId,
        body: delivery.body,
        formattedBody: delivery.formattedBody,
        ...(delivery.replyToEventId === undefined ? {} : { relationEventId: delivery.replyToEventId }),
        roomPolicy: exactRoomPolicy(configuration, now().getTime())
      });
      acceptedEventId = accepted.eventId;
    } catch (error) {
      const code = errorCode(error);
      if (code === "policy_denied") {
        await blockLease(lease, "policy_denied");
        return "stop";
      }
      if (!provablyPreDispatchPublicationError(code)) {
        // The command may have reached Matrix before the transport/response
        // was lost. Retain the lease so Stop/new-task stays fenced until a
        // restart reconciles this same deterministic transaction ID.
        setTerminal(code === "termination_failed" ? "termination_failed" : "sidecar_not_ready");
        return "stop";
      }
      if (transientSidecarError(code)) {
        await releaseLease(lease, code as string);
        return "stop";
      }
      if (code === "termination_failed") setTerminal("termination_failed");
      else setTerminal("sidecar_not_ready");
      return "stop";
    }
    try {
      const marked = await input.registrarRuntime.matrixOutbox.markAccepted(lease, acceptedEventId, now());
      return marked.ok ? "accepted" : "stop";
    } catch {
      // Matrix already accepted this deterministic transaction. Never release
      // it for a fresh send: leave the lease to expire and reconcile the same
      // transaction ID after MySQL recovers.
      markDatabaseUnavailable();
      return "stop";
    }
  };

  const runtimeReadyForLease = (allowStopping = false): boolean => {
    if (!(active() || (allowStopping && draining())) || !database.mysqlAvailable || !database.schemaAvailable || !database.outboxAvailable || !database.ingressAvailable) {
      return false;
    }
    try {
      return runtime?.getReadiness().matrixReadiness === "ready";
    } catch {
      return false;
    }
  };

  async function runOutbox(allowStopping = false): Promise<void> {
    if (outboxRun !== undefined) return outboxRun;
    if (!(active() || (allowStopping && draining()))) return;
    const epochAtStart = wakeEpoch;
    const operation = (async (): Promise<void> => {
      let acceptedCount = 0;
      while (runtimeReadyForLease(allowStopping) && acceptedCount < OUTBOX_BURST_LIMIT) {
        try {
          const outcome = await requiredPublicationSynchronizer.withPublicationPermit(async () => {
            if (!runtimeReadyForLease(allowStopping)) return "stop" as const;
            const epochBeforeInspect = wakeEpoch;
            const head = await input.registrarRuntime.matrixOutbox.inspectHead(now());
            if (head === "blocked") {
              database = Object.freeze({ ...database, outboxAvailable: false });
              return "stop" as const;
            }
            if (head === "corrupt") {
              setTerminal("outbox_blocked");
              return "stop" as const;
            }
            if (head === "idle" || head === "waiting") {
              return wakeEpoch !== epochBeforeInspect ? "retry" as const : "stop" as const;
            }
            if (!runtimeReadyForLease(allowStopping)) return "stop" as const;
            const epochBeforeLease = wakeEpoch;
            const leased = await input.registrarRuntime.matrixOutbox.leaseHead({
              leaseOwner,
              now: now(),
              leaseMilliseconds: OUTBOX_LEASE_MILLISECONDS
            });
            if (leased === undefined) {
              return wakeEpoch !== epochBeforeLease ? "retry" as const : "stop" as const;
            }
            return await deliverLease(leased) === "accepted" ? "accepted" as const : "stop" as const;
          });
          if (outcome === "accepted") {
            acceptedCount += 1;
            continue;
          }
          if (outcome === "retry") continue;
          return;
        } catch (error) {
          if (errorCode(error) === "matrix_outbox_corrupt") setTerminal("outbox_blocked");
          else markDatabaseUnavailable();
          return;
        }
      }
      if (acceptedCount === OUTBOX_BURST_LIMIT) scheduleOutbox(0);
    })();
    let tracked: Promise<void>;
    tracked = operation.finally(() => {
      if (outboxRun === tracked) outboxRun = undefined;
      if (active() && wakeEpoch !== epochAtStart) scheduleOutbox(0);
    });
    outboxRun = tracked;
    return tracked;
  }

  const startInternal = async (generation: number): Promise<void> => {
    await probeOnce();
    if (!active(generation)) return;
    if (database.mysqlAvailable && database.schemaAvailable) await ensureRuntimeStarted(generation);
    if (!active(generation)) return;
    scheduleIngress(0);
    scheduleOutbox(0);
    scheduleMaintenance();
  };

  const settleBefore = async (operation: Promise<unknown>, deadline: number): Promise<boolean> => {
    const remaining = Math.max(0, deadline - clock.now());
    if (remaining === 0) {
      void operation.catch(() => undefined);
      return false;
    }
    let timeoutHandle: unknown;
    const timeout = new Promise<false>((resolve) => {
      timeoutHandle = clock.setTimeout(() => resolve(false), remaining);
    });
    const settled = operation.then(() => true as const, () => false as const);
    const result = await Promise.race([settled, timeout]);
    clock.clearTimeout(timeoutHandle);
    return result;
  };

  const service: GoDaddyMatrixService = Object.freeze({
    configured: true,
    start(): Promise<void> {
      if (stopped || stopping) return Promise.resolve();
      if (startPromise !== undefined) return startPromise;
      if (!started) {
        started = true;
        lifecycleGeneration += 1;
      }
      const generation = lifecycleGeneration;
      const operation = startInternal(generation);
      let tracked: Promise<void>;
      tracked = operation.finally(() => {
        if (startPromise === tracked) startPromise = undefined;
      });
      startPromise = tracked;
      return tracked;
    },
    wakeOutbox(): void {
      wakeEpoch = wakeEpoch >= Number.MAX_SAFE_INTEGER ? 1 : wakeEpoch + 1;
      scheduleOutbox(0);
    },
    getReadiness: currentReadiness,
    assertReadyForNewSession(): void {
      if (!currentReadiness().ready) throw new MatrixSidecarError("not_ready");
    },
    stop(): Promise<void> {
      if (stopPromise !== undefined) return stopPromise;
      stopping = true;
      lifecycleGeneration += 1;
      // Tell the runtime/supervisor to stop new Matrix intake first. Its
      // graceful shutdown remains pending on outstanding receipts and permits
      // only media inspection plus durable ACK while Node drains those tasks.
      const activeRuntime = runtime;
      let runtimeStop: Promise<void> = Promise.resolve();
      try {
        runtimeStop = activeRuntime?.stop() ?? Promise.resolve();
      } catch (error) {
        runtimeStop = Promise.reject(error);
      }
      void runtimeStop.catch(() => undefined);
      unsubscribeRuntimeIngress();
      clearTimerSlot(maintenanceTimer);
      clearTimerSlot(outboxTimer);
      clearTimerSlot(ingressTimer);
      const operation = (async (): Promise<void> => {
        const deadline = clock.now() + stopTimeoutMilliseconds;
        const drains = (async (): Promise<void> => {
          await Promise.all([ingressRun ?? Promise.resolve(), outboxRun ?? Promise.resolve()]);
          // A zero-delay timer may have been cancelled just before it ran, and
          // a running pass may have stopped after one item when `stopping`
          // flipped. Give the already-queued ingress an explicit final pass;
          // pending outbox rows remain durable, while any in-flight send above
          // was awaited and keeps an ambiguous lease unresolved.
          await runIngress(true);
        })();
        let clean = await settleBefore(drains, deadline);
        clean = await settleBefore(runtimeStop, deadline) && clean;
        const lifecycleWork = Promise.all([
          startPromise ?? Promise.resolve(),
          initializationPromise ?? Promise.resolve(),
          probePromise ?? Promise.resolve()
        ]);
        clean = await settleBefore(lifecycleWork, deadline) && clean;
        unsubscribeRuntimeIngress();
        clearTimerSlot(maintenanceTimer);
        clearTimerSlot(outboxTimer);
        clearTimerSlot(ingressTimer);
        stopping = false;
        if (!clean) {
          terminalReason = "termination_failed";
          throw new MatrixSidecarError("termination_failed");
        }
        stopped = true;
        terminalReason = "stopped";
      })();
      stopPromise = operation;
      return operation;
    }
  });
  return service;
}
