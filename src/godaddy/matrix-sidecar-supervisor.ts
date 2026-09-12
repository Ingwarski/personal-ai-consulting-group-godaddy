import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { withMatrixPrivateUmask } from "./matrix-private-spawn.ts";

export const MATRIX_SIDECAR_MAX_LINE_BYTES = 256 * 1024;
export const MATRIX_SIDECAR_MAX_OUTSTANDING_REQUESTS = 32;
export const MATRIX_SIDECAR_MAX_UNACKED_EVENTS = 64;

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 1_000;
const DEFAULT_CRASH_WINDOW_MS = 60_000;
const DEFAULT_MAX_CRASHES = 3;
const DEFAULT_RESTART_BACKOFF_MS = Object.freeze([100, 500, 2_000]);
const DEFAULT_MAX_LOCK_CONTENTION_RETRIES = 8;
const DEFAULT_LOCK_CONTENTION_BACKOFF_MS = Object.freeze([250, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000]);
const MAX_TRACKED_IDS = 4_096;
// Retire the process before either peer's replay set fills. The remaining
// budget accommodates in-flight responses, durable ACKs and shutdown.
export const MATRIX_SIDECAR_GENERATION_FRAME_BUDGET = 3_072;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const BOOT_ID = /^[a-f0-9]{32}$/u;
const MEDIA_HANDLE = /^[a-f0-9]{32}-[a-f0-9]{24}\.(?:jpg|png|pdf|ogg)$/u;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_MEDIA_OBJECTS = 4;
const MAX_MEDIA_OBJECT_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_AGGREGATE_BYTES = 64 * 1024 * 1024;

export type MatrixSidecarErrorCode =
  | "invalid_configuration"
  | "binary_not_regular"
  | "binary_symlink"
  | "binary_not_executable"
  | "binary_unsafe_mode"
  | "binary_wrong_owner"
  | "binary_checksum_mismatch"
  | "binary_verification_failed"
  | "spawn_failed"
  | "handshake_timeout"
  | "handshake_rejected"
  | "protocol_error"
  | "not_ready"
  | "backpressure_timeout"
  | "request_limit"
  | "request_timeout"
  | "policy_denied"
  | "media_denied"
  | "lock_contended"
  | "store_quarantined"
  | "transport_failed"
  | "termination_failed"
  | "stopped";

export class MatrixSidecarError extends Error {
  readonly code: MatrixSidecarErrorCode;

  constructor(code: MatrixSidecarErrorCode) {
    super(code);
    this.name = "MatrixSidecarError";
    this.code = code;
  }
}

export type MatrixSidecarStatus = Readonly<{
  liveness: "stopped" | "starting" | "alive" | "dead";
  matrixReadiness: "not_ready" | "ready";
  reason:
    | "stopped"
    | "starting"
    | "ready"
    | "sidecar_not_ready"
    | "verification_failed"
    | "spawn_failed"
    | "handshake_failed"
    | "lock_contended"
    | "protocol_error"
    | "sidecar_exit"
    | "crash_backoff"
    | "circuit_open"
    | "shutting_down"
    | "generation_rollover"
    | "termination_failed";
  restartCount: number;
  circuitOpen: boolean;
}>;

export type MatrixSidecarEvent = Readonly<{
  receiptId: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type MatrixSidecarIngressRejection = Readonly<{
  receiptId: string;
  rejection: Readonly<Record<string, unknown>>;
}>;

export type MatrixSidecarDiagnostic = Readonly<{
  code: "stderr_redacted" | "subscriber_failed" | "lock_contended" | "restart_scheduled" | "circuit_open";
  byteCount?: number;
}>;

export type MatrixSidecarIdentityExpectation = Readonly<{
  build: string;
  homeserverOrigin: string;
  roomIdSha256: string;
  ownerMxidSha256: string;
  botMxidSha256: string;
  botDeviceIdSha256: string;
  storeFingerprint: string;
}>;

export type MatrixRuntimeBinding = Readonly<{
  homeserverOrigin: string;
  roomId: string;
  ownerMxid: string;
  botMxid: string;
  botDeviceId: string;
  mediaSpoolParent: string;
}>;

export type BinaryStat = Readonly<{
  mode: number;
  uid: number;
  dev: number;
  ino: number;
  size: number;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}>;

export type MatrixSidecarFileSystem = Readonly<{
  lstat: (path: string) => Promise<BinaryStat>;
  readFile: (path: string) => Promise<Buffer>;
}>;

export type MatrixSidecarWritable = Readonly<{
  write: (value: string, encoding: "utf8") => boolean;
  on: (event: "error", listener: (error: Error) => void) => unknown;
  once: (event: "drain", listener: () => void) => unknown;
  off?: (event: "drain", listener: () => void) => unknown;
}>;

export type MatrixSidecarReadable = Readonly<{
  on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
}>;

export type MatrixSidecarChildProcess = Readonly<{
  stdin: MatrixSidecarWritable | null;
  stdout: MatrixSidecarReadable | null;
  stderr: MatrixSidecarReadable | null;
  once: {
    (event: "close", listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): unknown;
    (event: "error", listener: (error: Error) => void): unknown;
  };
  kill: (signal: NodeJS.Signals) => boolean;
}>;

export type MatrixSidecarSpawn = (
  executable: string,
  argumentsList: readonly string[],
  options: Readonly<{
    cwd?: string;
    env: Readonly<Record<string, string>>;
    shell: false;
    stdio: readonly ["pipe", "pipe", "pipe"];
  }>
) => MatrixSidecarChildProcess;

export type MatrixSidecarClock = Readonly<{
  now: () => number;
  setTimeout: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}>;

export type MatrixSidecarSupervisorOptions = Readonly<{
  binaryPath: string;
  expectedSha256: string;
  protocolVersion: number;
  expectedIdentity: MatrixSidecarIdentityExpectation;
  argumentsList?: readonly string[];
  spawnEnvironment?: Readonly<Record<string, string>>;
  cwd?: string;
  expectedOwnerUid?: number | null;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  terminateTimeoutMs?: number;
  maxLineBytes?: number;
  maxOutstandingRequests?: number;
  maxUnackedEvents?: number;
  maxCrashes?: number;
  crashWindowMs?: number;
  restartBackoffMs?: readonly number[];
  circuitCooldownMs?: number;
  random?: () => number;
  maxLockContentionRetries?: number;
  lockContentionBackoffMs?: readonly number[];
  fileSystem?: MatrixSidecarFileSystem;
  spawnSidecar?: MatrixSidecarSpawn;
  clock?: MatrixSidecarClock;
  onDiagnostic?: (diagnostic: MatrixSidecarDiagnostic) => void;
}>;

type IncomingFrame =
  | Readonly<{ type: "hello"; version: number; id: string; build: string }>
  | Readonly<{
      type: "ready";
      version: number;
      id: string;
      readiness: SidecarReadiness;
      identity: MatrixSidecarWireIdentity;
    }>
  | Readonly<{ type: "response"; version: number; id: string; ok: true; result: Readonly<Record<string, unknown>>; error: null }>
  | Readonly<{ type: "response"; version: number; id: string; ok: false; result: null; error: string }>
  | Readonly<{ type: "event"; version: number; id: string; event: Readonly<Record<string, unknown>> }>
  | Readonly<{ type: "event_rejected"; version: number; id: string; rejection: Readonly<Record<string, unknown>> }>
  | Readonly<{ type: "status"; version: number; id: string; readiness: SidecarReadiness }>;

type MatrixSidecarPendingIngress = MatrixSidecarEvent | MatrixSidecarIngressRejection;

type SidecarReadiness = "starting" | "ready" | "blocked" | "quarantined" | "shutting_down";
type HandshakePhase =
  | "idle"
  | "waiting_sidecar_hello"
  | "waiting_supervisor_response"
  | "waiting_initialize_response"
  | "waiting_ready"
  | "blocked"
  | "lock_contended"
  | "failed"
  | "ready";

type MatrixSidecarWireIdentity = Readonly<{
  build: string;
  homeserver_origin: string;
  room_id_sha256: string;
  owner_mxid_sha256: string;
  bot_mxid_sha256: string;
  bot_device_id_sha256: string;
  store_fingerprint: string;
  spool_instance: string;
}>;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: MatrixSidecarError) => void;
  timeoutHandle: unknown;
};

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: MatrixSidecarError) => void;
};

async function readBoundedBinary(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > MAX_BINARY_BYTES) {
      throw new MatrixSidecarError("binary_verification_failed");
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > bytes.byteLength - offset) {
        throw new MatrixSidecarError("binary_verification_failed");
      }
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== stat.size) throw new MatrixSidecarError("binary_verification_failed");
    return Buffer.from(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

const nativeFileSystem: MatrixSidecarFileSystem = Object.freeze({
  lstat: async (path) => lstat(path),
  readFile: readBoundedBinary
});

const nativeClock: MatrixSidecarClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
});

const nativeSpawn: MatrixSidecarSpawn = (executable, argumentsList, options) =>
  withMatrixPrivateUmask(() => spawn(executable, [...argumentsList], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  })) as unknown as MatrixSidecarChildProcess;

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: MatrixSidecarError) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function safeToken(value: unknown): value is string {
  return typeof value === "string" && SAFE_TOKEN.test(value);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function safeMatrixEventId(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("$")
    && value.length <= 255
    && /^[\x21-\x7e]+$/u.test(value);
}

function safeDeviceId(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= 255
    && /^[\x21-\x7e]+$/u.test(value);
}

function safeRoomId(value: unknown): value is string {
  return typeof value === "string"
    && /^![A-Za-z0-9._=+\-/]+:[A-Za-z0-9.-]+$/u.test(value)
    && Buffer.byteLength(value, "utf8") <= 255;
}

function safeMxid(value: unknown): value is string {
  return typeof value === "string"
    && /^@[A-Za-z0-9._=+\-/]+:[A-Za-z0-9.-]+$/u.test(value)
    && Buffer.byteLength(value, "utf8") <= 255;
}

function exactHttpsOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.pathname !== "/"
      || url.search !== ""
      || url.hash !== ""
    ) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function equalAscii(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "ascii");
  const rightBytes = Buffer.from(right, "ascii");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function parseWireIdentity(value: unknown): MatrixSidecarWireIdentity | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "build",
    "homeserver_origin",
    "room_id_sha256",
    "owner_mxid_sha256",
    "bot_mxid_sha256",
    "bot_device_id_sha256",
    "store_fingerprint",
    "spool_instance"
  ])) return undefined;
  if (
    !safeToken(value.build)
    || exactHttpsOrigin(value.homeserver_origin) !== value.homeserver_origin
    || typeof value.room_id_sha256 !== "string" || !SHA256_HEX.test(value.room_id_sha256)
    || typeof value.owner_mxid_sha256 !== "string" || !SHA256_HEX.test(value.owner_mxid_sha256)
    || typeof value.bot_mxid_sha256 !== "string" || !SHA256_HEX.test(value.bot_mxid_sha256)
    || typeof value.bot_device_id_sha256 !== "string" || !SHA256_HEX.test(value.bot_device_id_sha256)
    || typeof value.store_fingerprint !== "string" || !SHA256_HEX.test(value.store_fingerprint)
    || typeof value.spool_instance !== "string" || !BOOT_ID.test(value.spool_instance)
  ) return undefined;
  return Object.freeze({
    build: value.build,
    homeserver_origin: value.homeserver_origin as string,
    room_id_sha256: value.room_id_sha256,
    owner_mxid_sha256: value.owner_mxid_sha256,
    bot_mxid_sha256: value.bot_mxid_sha256,
    bot_device_id_sha256: value.bot_device_id_sha256,
    store_fingerprint: value.store_fingerprint,
    spool_instance: value.spool_instance
  });
}

function validProtocolMedia(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["handle", "declared_mime", "length", "sha256"])
    && typeof value.handle === "string"
    && MEDIA_HANDLE.test(value.handle)
    && ["image/jpeg", "image/png", "application/pdf", "audio/ogg"].includes(value.declared_mime as string)
    && Number.isSafeInteger(value.length)
    && (value.length as number) > 0
    && (value.length as number) <= MAX_MEDIA_OBJECT_BYTES
    && typeof value.sha256 === "string"
    && SHA256_HEX.test(value.sha256);
}

function validProtocolEvent(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "event_id", "room_id", "sender_mxid", "sender_device_id", "body", "reply_to_event_id", "media"
  ])) return false;
  if (
    !safeMatrixEventId(value.event_id)
    || typeof value.room_id !== "string" || Buffer.byteLength(value.room_id, "utf8") > 255
    || typeof value.sender_mxid !== "string" || Buffer.byteLength(value.sender_mxid, "utf8") > 255
    || !safeDeviceId(value.sender_device_id)
    || (value.body !== null && (
      typeof value.body !== "string"
      || value.body.includes("\0")
      || Buffer.byteLength(value.body, "utf8") > MAX_PLAINTEXT_BYTES
    ))
    || (value.reply_to_event_id !== null && !safeMatrixEventId(value.reply_to_event_id))
    || !Array.isArray(value.media)
    || value.media.length > MAX_MEDIA_OBJECTS
    || !value.media.every(validProtocolMedia)
  ) return false;
  const handles = value.media.map((item) => (item as Record<string, unknown>).handle as string);
  return new Set(handles).size === handles.length
    && value.media.reduce((sum, item) => sum + ((item as Record<string, unknown>).length as number), 0)
      <= MAX_MEDIA_AGGREGATE_BYTES;
}

function validProtocolIngressRejection(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "event_id",
      "room_id",
      "sender_mxid",
      "sender_device_id",
      "body_hash",
      "media_manifest_hash",
      "event_hash",
      "reason"
    ])
    && safeMatrixEventId(value.event_id)
    && safeRoomId(value.room_id)
    && safeMxid(value.sender_mxid)
    && safeDeviceId(value.sender_device_id)
    && typeof value.body_hash === "string" && SHA256_HEX.test(value.body_hash)
    && typeof value.media_manifest_hash === "string" && SHA256_HEX.test(value.media_manifest_hash)
    && typeof value.event_hash === "string" && SHA256_HEX.test(value.event_hash)
    && (value.reason === "media_expired" || value.reason === "invalid_media");
}

function validResponseResult(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.name !== "string") return false;
  switch (value.name) {
    case "health":
    case "initialized":
    case "shutdown_accepted":
      return hasOnlyKeys(value, ["name"]);
    case "accepted":
      return hasOnlyKeys(value, ["name", "event_id"]) && safeMatrixEventId(value.event_id);
    case "media":
      if (
        !hasOnlyKeys(value, ["name", "objects"])
        || !Array.isArray(value.objects)
        || value.objects.length > MAX_MEDIA_OBJECTS
        || !value.objects.every((item) => isRecord(item)
          && hasOnlyKeys(item, ["handle", "kind", "length", "sha256"])
          && typeof item.handle === "string"
          && MEDIA_HANDLE.test(item.handle)
          && ["jpeg", "png", "pdf"].includes(item.kind as string)
          && Number.isSafeInteger(item.length)
          && (item.length as number) > 0
          && (item.length as number) <= MAX_MEDIA_OBJECT_BYTES
          && typeof item.sha256 === "string"
          && SHA256_HEX.test(item.sha256))
      ) return false;
      return new Set(value.objects.map((item) => (item as Record<string, unknown>).handle)).size === value.objects.length
        && value.objects.reduce((sum, item) => sum + ((item as Record<string, unknown>).length as number), 0)
          <= MAX_MEDIA_AGGREGATE_BYTES;
    default:
      return false;
  }
}

function immutableProtocolEvent(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const media = (value.media as readonly Record<string, unknown>[]).map((item) => Object.freeze({
    handle: item.handle,
    declared_mime: item.declared_mime,
    length: item.length,
    sha256: item.sha256
  }));
  return Object.freeze({
    event_id: value.event_id,
    room_id: value.room_id,
    sender_mxid: value.sender_mxid,
    sender_device_id: value.sender_device_id,
    body: value.body,
    reply_to_event_id: value.reply_to_event_id,
    media: Object.freeze(media)
  });
}

function immutableProtocolIngressRejection(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    event_id: value.event_id,
    room_id: value.room_id,
    sender_mxid: value.sender_mxid,
    sender_device_id: value.sender_device_id,
    body_hash: value.body_hash,
    media_manifest_hash: value.media_manifest_hash,
    event_hash: value.event_hash,
    reason: value.reason
  });
}

function pendingIngressEventId(pending: MatrixSidecarPendingIngress): unknown {
  return "payload" in pending ? pending.payload.event_id : pending.rejection.event_id;
}

function immutableResponseResult(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  if (value.name !== "media") return Object.freeze({ ...value });
  const objects = (value.objects as readonly Record<string, unknown>[]).map((item) => Object.freeze({
    handle: item.handle,
    kind: item.kind,
    length: item.length,
    sha256: item.sha256
  }));
  return Object.freeze({ name: "media", objects: Object.freeze(objects) });
}

const PUBLIC_ERRORS = new Set([
  "invalid_frame",
  "invalid_state",
  "not_ready",
  "policy_denied",
  "media_denied",
  "lock_contended",
  "store_quarantined",
  "transport_failed"
]);

const ALLOWED_SIDECAR_ENVIRONMENT = new Set([
  "PATH",
  "SSL_CERT_FILE",
  "MATRIX_STORE_BACKEND",
  "MATRIX_DEPLOYMENT_GENERATION",
  "TMPDIR",
  "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DB_SSL_CA_FILE",
  "MATRIX_HOMESERVER_URL",
  "MATRIX_ALLOWED_HTTPS_ORIGINS",
  "MATRIX_STORE_DIR",
  "MATRIX_STORE_PASSPHRASE",
  "MATRIX_MEDIA_SPOOL_DIR",
  "MATRIX_ACCESS_TOKEN",
  "MATRIX_ROOM_ID",
  "MATRIX_OWNER_MXID",
  "MATRIX_BOT_MXID",
  "MATRIX_BOT_DEVICE_ID"
]);

function parseIncomingFrame(value: unknown, protocolVersion: number): IncomingFrame | undefined {
  if (!isRecord(value) || value.version !== protocolVersion || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "hello":
      return hasOnlyKeys(value, ["type", "version", "id", "build"]) && safeId(value.id) && safeToken(value.build)
        ? { type: "hello", version: protocolVersion, id: value.id, build: value.build }
        : undefined;
    case "ready": {
      if (
        !hasOnlyKeys(value, ["type", "version", "id", "readiness", "identity"])
        || !safeId(value.id)
        || !["starting", "ready", "blocked", "quarantined", "shutting_down"].includes(value.readiness as string)
      ) return undefined;
      const readiness = value.readiness as SidecarReadiness;
      const identity = parseWireIdentity(value.identity);
      if (identity === undefined) return undefined;
      return {
        type: "ready",
        version: protocolVersion,
        id: value.id,
        readiness,
        identity
      };
    }
    case "status": {
      if (
        !hasOnlyKeys(value, ["type", "version", "id", "readiness"])
        || !safeId(value.id)
        || !["starting", "ready", "blocked", "quarantined", "shutting_down"].includes(value.readiness as string)
      ) return undefined;
      return { type: "status", version: protocolVersion, id: value.id, readiness: value.readiness as SidecarReadiness };
    }
    case "response": {
      if (!safeId(value.id) || typeof value.ok !== "boolean") return undefined;
      if (value.ok) {
        return hasOnlyKeys(value, ["type", "version", "id", "ok", "result", "error"])
          && validResponseResult(value.result)
          && value.error === null
          ? { type: "response", version: protocolVersion, id: value.id, ok: true, result: immutableResponseResult(value.result), error: null }
          : undefined;
      }
      return hasOnlyKeys(value, ["type", "version", "id", "ok", "result", "error"])
        && value.result === null
        && typeof value.error === "string"
        && PUBLIC_ERRORS.has(value.error)
        ? { type: "response", version: protocolVersion, id: value.id, ok: false, result: null, error: value.error }
        : undefined;
    }
    case "event":
      return hasOnlyKeys(value, ["type", "version", "id", "event"]) && safeId(value.id) && validProtocolEvent(value.event)
        ? { type: "event", version: protocolVersion, id: value.id, event: immutableProtocolEvent(value.event) }
        : undefined;
    case "event_rejected":
      return hasOnlyKeys(value, ["type", "version", "id", "rejection"])
        && safeId(value.id)
        && validProtocolIngressRejection(value.rejection)
        ? {
            type: "event_rejected",
            version: protocolVersion,
            id: value.id,
            rejection: immutableProtocolIngressRejection(value.rejection)
          }
        : undefined;
    default:
      return undefined;
  }
}

function positiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function defaultOwnerUid(): number | null {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

function sameFile(first: BinaryStat, second: BinaryStat): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size;
}

function safeEnvironment(environment: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (environment === undefined) {
    return Object.freeze({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" });
  }
  const entries = Object.entries(environment);
  if (environment.MATRIX_STORE_BACKEND !== "mysql" && entries.some(([key]) => key.startsWith("DB_"))) {
    throw new MatrixSidecarError("invalid_configuration");
  }
  if (entries.some(([key, value]) => !ALLOWED_SIDECAR_ENVIRONMENT.has(key) || typeof value !== "string" || value.includes("\0"))) {
    throw new MatrixSidecarError("invalid_configuration");
  }
  return Object.freeze(Object.fromEntries(entries));
}

function validateExpectedIdentity(value: MatrixSidecarIdentityExpectation): MatrixSidecarIdentityExpectation {
  if (
    !isRecord(value)
    || !safeToken(value.build)
    || value.homeserverOrigin !== "https://matrix.org"
    || exactHttpsOrigin(value.homeserverOrigin) !== value.homeserverOrigin
    || !SHA256_HEX.test(value.roomIdSha256)
    || !SHA256_HEX.test(value.ownerMxidSha256)
    || !SHA256_HEX.test(value.botMxidSha256)
    || !SHA256_HEX.test(value.botDeviceIdSha256)
    || !SHA256_HEX.test(value.storeFingerprint)
  ) throw new MatrixSidecarError("invalid_configuration");
  return Object.freeze({ ...value });
}

function validateSpawnIdentity(
  environment: Readonly<Record<string, string>>,
  expected: MatrixSidecarIdentityExpectation
): void {
  const homeserver = environment.MATRIX_HOMESERVER_URL;
  const allowedOrigins = environment.MATRIX_ALLOWED_HTTPS_ORIGINS?.split(",").map((value) => value.trim());
  const roomId = environment.MATRIX_ROOM_ID;
  const ownerMxid = environment.MATRIX_OWNER_MXID;
  const botMxid = environment.MATRIX_BOT_MXID;
  const botDeviceId = environment.MATRIX_BOT_DEVICE_ID;
  const storeDirectory = environment.MATRIX_STORE_DIR;
  const spoolDirectory = environment.MATRIX_MEDIA_SPOOL_DIR;
  const mysql = environment.MATRIX_STORE_BACKEND === "mysql";
  const caBundlePath = environment.SSL_CERT_FILE;
  if (
    homeserver !== expected.homeserverOrigin
    || allowedOrigins === undefined
    || allowedOrigins.length !== 1
    || allowedOrigins[0] !== expected.homeserverOrigin
    || roomId === undefined || !equalAscii(sha256Utf8(roomId), expected.roomIdSha256)
    || ownerMxid === undefined || !equalAscii(sha256Utf8(ownerMxid), expected.ownerMxidSha256)
    || botMxid === undefined || !equalAscii(sha256Utf8(botMxid), expected.botMxidSha256)
    || botDeviceId === undefined || !equalAscii(sha256Utf8(botDeviceId), expected.botDeviceIdSha256)
    || environment.MATRIX_ACCESS_TOKEN === undefined || environment.MATRIX_ACCESS_TOKEN.length === 0
    || environment.MATRIX_STORE_PASSPHRASE === undefined
    || !/^[a-f0-9]{64}$/u.test(environment.MATRIX_STORE_PASSPHRASE)
    || (mysql && !/^50434731[a-f0-9]{56}$/u.test(environment.MATRIX_DEPLOYMENT_GENERATION ?? ""))
    || (!mysql && environment.MATRIX_DEPLOYMENT_GENERATION !== undefined)
    || storeDirectory === undefined || !isAbsolute(storeDirectory) || resolve(storeDirectory) !== storeDirectory
    || spoolDirectory === undefined || !isAbsolute(spoolDirectory) || resolve(spoolDirectory) !== spoolDirectory
    || (mysql && caBundlePath !== join(spoolDirectory, "node-default-ca.pem"))
    || (!mysql && caBundlePath !== undefined)
  ) throw new MatrixSidecarError("invalid_configuration");
}

function identityMatches(
  actual: MatrixSidecarWireIdentity,
  expected: MatrixSidecarIdentityExpectation
): boolean {
  return equalAscii(actual.build, expected.build)
    && equalAscii(actual.homeserver_origin, expected.homeserverOrigin)
    && equalAscii(actual.room_id_sha256, expected.roomIdSha256)
    && equalAscii(actual.owner_mxid_sha256, expected.ownerMxidSha256)
    && equalAscii(actual.bot_mxid_sha256, expected.botMxidSha256)
    && equalAscii(actual.bot_device_id_sha256, expected.botDeviceIdSha256)
    && equalAscii(actual.store_fingerprint, expected.storeFingerprint);
}

export class MatrixSidecarSupervisor {
  readonly #options: Readonly<{
    binaryPath: string;
    expectedSha256: string;
    protocolVersion: number;
    expectedIdentity: MatrixSidecarIdentityExpectation;
    argumentsList: readonly string[];
    spawnEnvironment: Readonly<Record<string, string>>;
    cwd?: string;
    expectedOwnerUid: number | null;
    handshakeTimeoutMs: number;
    requestTimeoutMs: number;
    shutdownTimeoutMs: number;
    terminateTimeoutMs: number;
    maxLineBytes: number;
    maxOutstandingRequests: number;
    maxUnackedEvents: number;
    maxCrashes: number;
    crashWindowMs: number;
    restartBackoffMs: readonly number[];
    circuitCooldownMs: number;
    maxLockContentionRetries: number;
    lockContentionBackoffMs: readonly number[];
  }>;
  readonly #fileSystem: MatrixSidecarFileSystem;
  readonly #spawnSidecar: MatrixSidecarSpawn;
  readonly #clock: MatrixSidecarClock;
  readonly #random: () => number;
  readonly #onDiagnostic: ((diagnostic: MatrixSidecarDiagnostic) => void) | undefined;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #expiredIds = new Set<string>();
  readonly #seenInboundIds = new Set<string>();
  readonly #unackedEvents = new Map<string, MatrixSidecarPendingIngress>();
  readonly #subscribers = new Set<(event: MatrixSidecarEvent) => void>();
  readonly #rejectionSubscribers = new Set<(rejection: MatrixSidecarIngressRejection) => void>();
  readonly #drainWaiters = new Set<() => void>();
  #status: MatrixSidecarStatus = Object.freeze({
    liveness: "stopped",
    matrixReadiness: "not_ready",
    reason: "stopped",
    restartCount: 0,
    circuitOpen: false
  });
  #child: MatrixSidecarChildProcess | undefined;
  #childExit: Deferred | undefined;
  #handshake: Deferred | undefined;
  #supervisorHelloId: string | undefined;
  #initializeId: string | undefined;
  #handshakePhase: HandshakePhase = "idle";
  #lineBuffer = Buffer.alloc(0);
  #acceptingRequests = false;
  #stopRequested = false;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #stopping = false;
  #restartTimer: unknown;
  #failureTerminationTimer: unknown;
  #writeChain: Promise<void> = Promise.resolve();
  #idCounter = 0;
  #generationFrameCount = 0;
  #rolloverGeneration: number | undefined;
  #rolloverPromise: Promise<void> | undefined;
  #generation = 0;
  #failedGeneration: number | undefined;
  #identityVerified = false;
  #activeMediaBootId: string | undefined;
  #crashTimes: number[] = [];
  #lockContentionAttempts = 0;
  #restartCause: "crash" | "lock_contended" = "crash";
  #circuitOpenRestartCount: number | undefined;
  #circuitRecoveryDueAt = 0;
  #circuitOpenCount = 0;
  #recoveryPermitted = true;

  constructor(options: MatrixSidecarSupervisorOptions) {
    if (
      !isRecord(options)
      || typeof options.binaryPath !== "string"
      || typeof options.expectedSha256 !== "string"
      || !Array.isArray(options.argumentsList ?? [])
      || !Array.isArray(options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS)
      || !Array.isArray(options.lockContentionBackoffMs ?? DEFAULT_LOCK_CONTENTION_BACKOFF_MS)
    ) throw new MatrixSidecarError("invalid_configuration");
    const expectedSha256 = options.expectedSha256.toLowerCase();
    const protocolVersion = options.protocolVersion;
    const argumentsList = options.argumentsList ?? [];
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const terminateTimeoutMs = options.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS;
    const maxLineBytes = options.maxLineBytes ?? MATRIX_SIDECAR_MAX_LINE_BYTES;
    const maxOutstandingRequests = options.maxOutstandingRequests ?? MATRIX_SIDECAR_MAX_OUTSTANDING_REQUESTS;
    const maxUnackedEvents = options.maxUnackedEvents ?? MATRIX_SIDECAR_MAX_UNACKED_EVENTS;
    const maxCrashes = options.maxCrashes ?? DEFAULT_MAX_CRASHES;
    const crashWindowMs = options.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS;
    const restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    const circuitCooldownMs = options.circuitCooldownMs ?? 60_000;
    const maxLockContentionRetries = options.maxLockContentionRetries ?? DEFAULT_MAX_LOCK_CONTENTION_RETRIES;
    const lockContentionBackoffMs = options.lockContentionBackoffMs ?? DEFAULT_LOCK_CONTENTION_BACKOFF_MS;
    const expectedOwnerUid = options.expectedOwnerUid === undefined ? defaultOwnerUid() : options.expectedOwnerUid;
    const expectedIdentity = validateExpectedIdentity(options.expectedIdentity);
    const spawnEnvironment = safeEnvironment(options.spawnEnvironment);
    validateSpawnIdentity(spawnEnvironment, expectedIdentity);
    if (
      !isAbsolute(options.binaryPath)
      || resolve(options.binaryPath) !== options.binaryPath
      || options.binaryPath.includes("\0")
      || !/^[a-f0-9]{64}$/u.test(expectedSha256)
      || !Number.isSafeInteger(protocolVersion)
      || protocolVersion < 1
      || protocolVersion > 65_535
      || !(
        (argumentsList.length === 2
          && argumentsList[0] === "--application-root"
          && typeof argumentsList[1] === "string"
          && isAbsolute(argumentsList[1])
          && resolve(argumentsList[1]) === argumentsList[1]
          && !argumentsList[1].includes("\0"))
        || (argumentsList.length === 3
          && argumentsList[0] === "--application-root"
          && typeof argumentsList[1] === "string"
          && isAbsolute(argumentsList[1])
          && resolve(argumentsList[1]) === argumentsList[1]
          && !argumentsList[1].includes("\0")
          && argumentsList[2] === "--provision-fresh")
      )
      || (
        typeof options.cwd !== "string"
        || !isAbsolute(options.cwd)
        || resolve(options.cwd) !== options.cwd
        || options.cwd.includes("\0")
        || options.cwd !== argumentsList[1]
      )
      || (expectedOwnerUid !== null && (!Number.isSafeInteger(expectedOwnerUid) || expectedOwnerUid < 0))
      || !positiveInteger(handshakeTimeoutMs, 60_000)
      || !positiveInteger(requestTimeoutMs, 10 * 60_000)
      || !positiveInteger(shutdownTimeoutMs, 60_000)
      || !positiveInteger(terminateTimeoutMs, 60_000)
      || !positiveInteger(maxLineBytes, MATRIX_SIDECAR_MAX_LINE_BYTES)
      || !positiveInteger(maxOutstandingRequests, MATRIX_SIDECAR_MAX_OUTSTANDING_REQUESTS)
      || !positiveInteger(maxUnackedEvents, MATRIX_SIDECAR_MAX_UNACKED_EVENTS)
      || !positiveInteger(maxCrashes, 100)
      || !positiveInteger(crashWindowMs, 24 * 60 * 60_000)
      || !positiveInteger(circuitCooldownMs, 5 * 60_000)
      || restartBackoffMs.length === 0
      || restartBackoffMs.length > 100
      || restartBackoffMs.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 60_000)
      || !positiveInteger(maxLockContentionRetries, 100)
      || lockContentionBackoffMs.length === 0
      || lockContentionBackoffMs.length > 100
      || lockContentionBackoffMs.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 60_000)
    ) {
      throw new MatrixSidecarError("invalid_configuration");
    }
    this.#options = Object.freeze({
      binaryPath: options.binaryPath,
      expectedSha256,
      protocolVersion,
      expectedIdentity,
      argumentsList: Object.freeze([...argumentsList]),
      spawnEnvironment,
      cwd: options.cwd,
      expectedOwnerUid,
      handshakeTimeoutMs,
      requestTimeoutMs,
      shutdownTimeoutMs,
      terminateTimeoutMs,
      maxLineBytes,
      maxOutstandingRequests,
      maxUnackedEvents,
      maxCrashes,
      crashWindowMs,
      circuitCooldownMs,
      restartBackoffMs: Object.freeze([...restartBackoffMs]),
      maxLockContentionRetries,
      lockContentionBackoffMs: Object.freeze([...lockContentionBackoffMs])
    });
    this.#fileSystem = options.fileSystem ?? nativeFileSystem;
    this.#spawnSidecar = options.spawnSidecar ?? nativeSpawn;
    this.#clock = options.clock ?? nativeClock;
    this.#random = options.random ?? Math.random;
    this.#onDiagnostic = options.onDiagnostic;
  }

  getStatus(): MatrixSidecarStatus {
    return this.#status;
  }

  assertRuntimeBinding(binding: MatrixRuntimeBinding): void {
    if (
      !isRecord(binding)
      || typeof binding.homeserverOrigin !== "string"
      || typeof binding.roomId !== "string"
      || typeof binding.ownerMxid !== "string"
      || typeof binding.botMxid !== "string"
      || typeof binding.botDeviceId !== "string"
      || typeof binding.mediaSpoolParent !== "string"
    ) throw new MatrixSidecarError("invalid_configuration");
    const origin = exactHttpsOrigin(binding.homeserverOrigin);
    const expected = this.#options.expectedIdentity;
    if (
      origin === undefined
      || !equalAscii(origin, expected.homeserverOrigin)
      || !equalAscii(sha256Utf8(binding.roomId), expected.roomIdSha256)
      || !equalAscii(sha256Utf8(binding.ownerMxid), expected.ownerMxidSha256)
      || !equalAscii(sha256Utf8(binding.botMxid), expected.botMxidSha256)
      || !equalAscii(sha256Utf8(binding.botDeviceId), expected.botDeviceIdSha256)
      || !isAbsolute(binding.mediaSpoolParent)
      || resolve(binding.mediaSpoolParent) !== binding.mediaSpoolParent
      || !equalAscii(binding.mediaSpoolParent, this.#options.spawnEnvironment.MATRIX_MEDIA_SPOOL_DIR ?? "")
    ) throw new MatrixSidecarError("invalid_configuration");
  }

  getActiveMediaBootId(): string | undefined {
    return this.#identityVerified ? this.#activeMediaBootId : undefined;
  }

  onEvent(subscriber: (event: MatrixSidecarEvent) => void): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  onRejectedEvent(subscriber: (rejection: MatrixSidecarIngressRejection) => void): () => void {
    this.#rejectionSubscribers.add(subscriber);
    return () => this.#rejectionSubscribers.delete(subscriber);
  }

  async start(): Promise<void> {
    if (this.#stopping) throw new MatrixSidecarError("stopped");
    if (this.#rolloverPromise !== undefined) return this.#rolloverPromise;
    if (this.#status.reason === "termination_failed") {
      throw new MatrixSidecarError("termination_failed");
    }
    if (this.#circuitOpenRestartCount !== undefined) {
      if (this.#status.liveness === "stopped") {
        this.#stopPromise = undefined;
        this.#stopRequested = false;
      }
      this.#setStatus("dead", "not_ready", "circuit_open", true, this.#circuitOpenRestartCount);
      this.#scheduleHalfOpen();
      return;
    }
    if (
      this.#status.liveness === "alive"
      && (
        this.#handshakePhase === "ready"
        || this.#handshakePhase === "blocked"
        || this.#handshakePhase === "lock_contended"
      )
    ) return;
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#restartTimer !== undefined) return;
    if (this.#status.liveness === "stopped") this.#stopPromise = undefined;
    this.#stopRequested = false;
    this.#crashTimes = [];
    this.#lockContentionAttempts = 0;
    this.#restartCause = "crash";
    this.#setStatus("starting", "not_ready", "starting", false);
    const launch = this.#launch();
    this.#startPromise = launch;
    try {
      await launch;
    } finally {
      if (this.#startPromise === launch) this.#startPromise = undefined;
    }
  }

  async request<T = unknown>(method: string, params: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<T> {
    const drainingMediaInspection = method === "inspect_media"
      && ((this.#stopRequested && this.#status.reason === "shutting_down")
        || this.#rolloverGeneration === this.#generation)
      && this.#handshakePhase === "ready"
      && this.#identityVerified;
    if (!drainingMediaInspection && (!this.#acceptingRequests || this.#status.matrixReadiness !== "ready")) {
      throw new MatrixSidecarError("not_ready");
    }
    if (!safeToken(method) || !isRecord(params) || Object.hasOwn(params, "name")) {
      throw new MatrixSidecarError("invalid_configuration");
    }
    const effectiveTimeout = timeoutMs ?? this.#options.requestTimeoutMs;
    if (!positiveInteger(effectiveTimeout, 10 * 60_000)) throw new MatrixSidecarError("invalid_configuration");
    const id = this.#nextId("request");
    return this.#sendCorrelated<T>({
      type: "request",
      version: this.#options.protocolVersion,
      id,
      command: Object.freeze({ name: method, ...params })
    }, id, effectiveTimeout);
  }

  async ack(receiptId: string, eventId: string, durableReceiptId: string): Promise<void> {
    const pendingEvent = this.#unackedEvents.get(receiptId);
    const draining = ((this.#stopRequested && this.#status.reason === "shutting_down")
      || this.#rolloverGeneration === this.#generation)
      && this.#handshakePhase === "ready"
      && this.#identityVerified;
    if (
      !draining
      && (!this.#acceptingRequests || this.#status.matrixReadiness !== "ready")
    ) throw new MatrixSidecarError("not_ready");
    if (
      !safeId(receiptId)
      || !safeMatrixEventId(eventId)
      || (pendingEvent !== undefined && pendingIngressEventId(pendingEvent) !== eventId)
      || !safeId(durableReceiptId)
    ) throw new MatrixSidecarError("protocol_error");
    const id = this.#nextId("ack");
    const result = await this.#sendCorrelated<Readonly<Record<string, unknown>>>({
      type: "ack",
      version: this.#options.protocolVersion,
      id,
      ack: Object.freeze({ event_id: eventId, durable_receipt_id: durableReceiptId })
    }, id, this.#options.handshakeTimeoutMs);
    if (result.name !== "health") {
      this.#protocolFailure();
      throw new MatrixSidecarError("protocol_error");
    }
    this.#unackedEvents.delete(receiptId);
    this.#notifyDrained();
  }

  failClosed(): void {
    this.#protocolFailure();
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopping = true;
    this.#stopRequested = true;
    const operation = (async () => {
      await this.#rolloverPromise;
      await this.#stopInternal();
    })().finally(() => {
      this.#stopping = false;
    });
    this.#stopPromise = operation;
    return operation;
  }

  #maybeRollover(): void {
    if (
      this.#stopRequested
      || this.#rolloverPromise !== undefined
      || this.#handshakePhase !== "ready"
      || !this.#identityVerified
      || this.#failedGeneration === this.#generation
      || (this.#generationFrameCount < MATRIX_SIDECAR_GENERATION_FRAME_BUDGET
        && this.#seenInboundIds.size < MATRIX_SIDECAR_GENERATION_FRAME_BUDGET)
    ) return;
    const generation = this.#generation;
    this.#rolloverGeneration = generation;
    this.#acceptingRequests = false;
    this.#setStatus("alive", "not_ready", "generation_rollover", false);
    const rollover = this.#rollGeneration(generation).finally(() => {
      if (this.#rolloverGeneration === generation) this.#rolloverGeneration = undefined;
      if (this.#rolloverPromise === rollover) this.#rolloverPromise = undefined;
    });
    this.#rolloverPromise = rollover;
  }

  async #rollGeneration(generation: number): Promise<void> {
    const child = this.#child;
    const childExit = this.#childExit;
    if (child === undefined || childExit === undefined) return;
    const deadline = this.#clock.now() + this.#options.shutdownTimeoutMs;
    const remaining = (): number => Math.max(0, deadline - this.#clock.now());
    try {
      await this.#waitForDrain(remaining());
      if (this.#stopRequested) return;
      if (this.#child !== child || this.#failedGeneration === generation || remaining() === 0) {
        throw new MatrixSidecarError("not_ready");
      }
      const id = this.#nextId("shutdown");
      const result = await this.#sendCorrelated<Readonly<Record<string, unknown>>>({
        type: "shutdown", version: this.#options.protocolVersion, id
      }, id, remaining(), false);
      if (result.name !== "shutdown_accepted" || !await this.#waitForExit(childExit, remaining())) {
        throw new MatrixSidecarError("protocol_error");
      }
      // A clean shutdown response and confirmed exit are both required. Never
      // overlap processes or clear replay history on a still-live child.
      this.#rolloverGeneration = undefined;
      if (!this.#stopRequested) await this.#launch();
    } catch {
      this.#rolloverGeneration = undefined;
      if (this.#stopRequested) return;
      if (generation !== this.#generation) return; // launch handles its own failures
      if (this.#child === undefined) this.#scheduleRestart("crash");
      else this.#protocolFailure();
    }
  }

  async #stopInternal(): Promise<void> {
    this.#stopRequested = true;
    this.#acceptingRequests = false;
    if (this.#restartTimer !== undefined) {
      this.#clock.clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    const child = this.#child;
    const childExit = this.#childExit;
    if (child === undefined || childExit === undefined) {
      this.#rejectPending("stopped");
      this.#setStatus("stopped", "not_ready", "stopped", false);
      return;
    }
    this.#setStatus("alive", "not_ready", "shutting_down", false);
    const gracefulDeadline = this.#clock.now() + this.#options.shutdownTimeoutMs;
    const gracefulRemaining = (): number => Math.max(0, gracefulDeadline - this.#clock.now());
    const drainRemaining = gracefulRemaining();
    if (drainRemaining > 0) await this.#waitForDrain(drainRemaining).catch(() => undefined);
    const shutdownRemaining = gracefulRemaining();
    if (shutdownRemaining > 0 && this.#child === child) {
      const shutdownId = this.#nextId("shutdown");
      const shutdownResult = await this.#sendCorrelated<Readonly<Record<string, unknown>>>({
        type: "shutdown",
        version: this.#options.protocolVersion,
        id: shutdownId
      }, shutdownId, shutdownRemaining, false).catch(() => undefined);
      if (shutdownResult !== undefined && shutdownResult.name !== "shutdown_accepted") this.#protocolFailure();
    }
    const exitRemaining = gracefulRemaining();
    if (exitRemaining > 0 && await this.#waitForExit(childExit, exitRemaining)) return;
    if (this.#child !== child) return;
    child.kill("SIGTERM");
    if (await this.#waitForExit(childExit, this.#options.terminateTimeoutMs)) return;
    child.kill("SIGKILL");
    if (await this.#waitForExit(childExit, this.#options.terminateTimeoutMs)) return;
    this.#rejectPending("stopped");
    this.#setStatus("alive", "not_ready", "termination_failed", false);
    throw new MatrixSidecarError("termination_failed");
  }

  async #launch(): Promise<void> {
    let verifiedBinary: BinaryStat;
    try {
      verifiedBinary = await this.#verifyBinary();
      if (this.#stopRequested) throw new MatrixSidecarError("stopped");
      await this.#verifyBinaryUnchanged(verifiedBinary);
    } catch (error) {
      if (error instanceof MatrixSidecarError && error.code === "stopped") throw error;
      // Never auto-clear a changed/untrusted executable or identity failure.
      this.#recoveryPermitted = false;
      this.#setStatus("dead", "not_ready", "verification_failed", false);
      throw error instanceof MatrixSidecarError ? error : new MatrixSidecarError("binary_verification_failed");
    }
    if (this.#stopRequested) throw new MatrixSidecarError("stopped");
    const generation = ++this.#generation;
    this.#failedGeneration = undefined;
    this.#restartCause = "crash";
    this.#identityVerified = false;
    this.#activeMediaBootId = undefined;
    if (this.#failureTerminationTimer !== undefined) {
      this.#clock.clearTimeout(this.#failureTerminationTimer);
      this.#failureTerminationTimer = undefined;
    }
    let child: MatrixSidecarChildProcess;
    try {
      // Node's spawn API reopens an executable by pathname, so it cannot bind
      // exec to the already checksummed descriptor. The promoted path is
      // therefore an explicit same-UID immutable deployment boundary. The
      // immediately preceding inode/size/mode/owner check detects ordinary
      // replacement, while release promotion must never mutate this pathname
      // concurrently with a running app.
      child = this.#spawnSidecar(this.#options.binaryPath, this.#options.argumentsList, {
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        env: this.#options.spawnEnvironment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch {
      this.#setStatus("dead", "not_ready", "spawn_failed", false);
      throw new MatrixSidecarError("spawn_failed");
    }
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      child.kill("SIGTERM");
      this.#setStatus("dead", "not_ready", "spawn_failed", false);
      throw new MatrixSidecarError("spawn_failed");
    }
    this.#child = child;
    this.#childExit = deferred();
    this.#writeChain = Promise.resolve();
    this.#lineBuffer = Buffer.alloc(0);
    this.#seenInboundIds.clear();
    this.#generationFrameCount = 0;
    this.#unackedEvents.clear();
    this.#handshake = deferred();
    this.#supervisorHelloId = undefined;
    this.#initializeId = undefined;
    this.#handshakePhase = "waiting_sidecar_hello";
    this.#setStatus("starting", "not_ready", "starting", false);
    let exited = false;
    const handleExit = (): void => {
      if (exited || generation !== this.#generation) return;
      exited = true;
      this.#childExit?.resolve();
      this.#handleExit(generation);
    };
    child.stdout.on("data", (chunk) => this.#consumeStdout(chunk, generation));
    child.stderr.on("data", (chunk) => {
      const byteCount = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
      this.#diagnostic({ code: "stderr_redacted", byteCount });
    });
    // The native sidecar can close its read end between the writable check and
    // stdin.write(). Node then emits EPIPE on this Socket as well as failing
    // the write. Consume that stream event and recover through the supervisor
    // instead of terminating the entire GoDaddy Node process.
    child.stdin.on("error", () => {
      if (generation !== this.#generation || this.#stopRequested) return;
      this.#failGeneration("spawn_failed", "spawn_failed");
    });
    child.once("error", () => {
      this.#abortHandshake("spawn_failed");
      handleExit();
    });
    child.once("close", () => handleExit());
    const handshake = this.#handshake;
    const timeout = this.#clock.setTimeout(() => {
      if (
        this.#handshakePhase === "ready"
        || this.#handshakePhase === "blocked"
        || this.#handshakePhase === "lock_contended"
        || generation !== this.#generation
      ) return;
      this.#failGeneration("handshake_timeout", "handshake_failed");
    }, this.#options.handshakeTimeoutMs);
    try {
      await handshake.promise;
      const completedPhase = this.#handshakePhase as HandshakePhase;
      if (completedPhase === "ready" && this.#identityVerified) {
        this.#lockContentionAttempts = 0;
        this.#restartCause = "crash";
        this.#acceptingRequests = true;
        this.#setStatus("alive", "ready", "ready", false);
      } else if (completedPhase === "blocked") {
        this.#acceptingRequests = false;
        this.#setStatus("alive", "not_ready", "sidecar_not_ready", false);
      } else if (completedPhase === "lock_contended") {
        this.#acceptingRequests = false;
        this.#setStatus("alive", "not_ready", "lock_contended", false);
      } else {
        throw new MatrixSidecarError("handshake_rejected");
      }
    } catch (error) {
      if (this.#failedGeneration !== generation) {
        this.#failGeneration(
          error instanceof MatrixSidecarError && error.code === "handshake_timeout"
            ? "handshake_timeout"
            : "handshake_rejected",
          "handshake_failed"
        );
      }
      if (error instanceof MatrixSidecarError) throw error;
      throw new MatrixSidecarError("protocol_error");
    } finally {
      this.#clock.clearTimeout(timeout);
    }
  }

  async #verifyBinary(): Promise<BinaryStat> {
    let first: BinaryStat;
    let contents: Buffer;
    let second: BinaryStat;
    try {
      first = await this.#fileSystem.lstat(this.#options.binaryPath);
      if (first.isSymbolicLink()) throw new MatrixSidecarError("binary_symlink");
      if (!first.isFile()) throw new MatrixSidecarError("binary_not_regular");
      if ((first.mode & 0o111) === 0) throw new MatrixSidecarError("binary_not_executable");
      if (
        (first.mode & 0o022) !== 0
        || (first.mode & 0o7000) !== 0
        || !Number.isSafeInteger(first.size)
        || first.size <= 0
        || first.size > MAX_BINARY_BYTES
      ) throw new MatrixSidecarError("binary_unsafe_mode");
      if (this.#options.expectedOwnerUid !== null && first.uid !== this.#options.expectedOwnerUid) {
        throw new MatrixSidecarError("binary_wrong_owner");
      }
      contents = await this.#fileSystem.readFile(this.#options.binaryPath);
      if (contents.byteLength !== first.size || contents.byteLength > MAX_BINARY_BYTES) {
        throw new MatrixSidecarError("binary_verification_failed");
      }
      second = await this.#fileSystem.lstat(this.#options.binaryPath);
    } catch (error) {
      if (error instanceof MatrixSidecarError) throw error;
      throw new MatrixSidecarError("binary_verification_failed");
    }
    if (
      second.isSymbolicLink()
      || !second.isFile()
      || !sameFile(first, second)
      || (second.mode & 0o111) === 0
      || (second.mode & 0o022) !== 0
      || (second.mode & 0o7000) !== 0
      || (this.#options.expectedOwnerUid !== null && second.uid !== this.#options.expectedOwnerUid)
    ) {
      throw new MatrixSidecarError("binary_verification_failed");
    }
    const actual = createHash("sha256").update(contents).digest();
    const expected = Buffer.from(this.#options.expectedSha256, "hex");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new MatrixSidecarError("binary_checksum_mismatch");
    }
    return second;
  }

  async #verifyBinaryUnchanged(verified: BinaryStat): Promise<void> {
    let current: BinaryStat;
    try {
      current = await this.#fileSystem.lstat(this.#options.binaryPath);
    } catch {
      throw new MatrixSidecarError("binary_verification_failed");
    }
    if (
      current.isSymbolicLink()
      || !current.isFile()
      || !sameFile(verified, current)
      || (current.mode & 0o111) === 0
      || (current.mode & 0o022) !== 0
      || (current.mode & 0o7000) !== 0
      || current.size <= 0
      || current.size > MAX_BINARY_BYTES
      || (this.#options.expectedOwnerUid !== null && current.uid !== this.#options.expectedOwnerUid)
    ) throw new MatrixSidecarError("binary_verification_failed");
  }

  #consumeStdout(chunk: Buffer | string, generation: number): void {
    if (
      generation !== this.#generation
      || this.#child === undefined
      || this.#failedGeneration === generation
    ) return;
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    let offset = 0;
    while (offset < next.byteLength) {
      const newline = next.indexOf(0x0a, offset);
      const end = newline === -1 ? next.byteLength : newline;
      const segment = next.subarray(offset, end);
      if (this.#lineBuffer.byteLength + segment.byteLength > this.#options.maxLineBytes) {
        this.#protocolFailure();
        return;
      }
      if (newline === -1) {
        if (segment.byteLength > 0) this.#lineBuffer = Buffer.concat([this.#lineBuffer, segment]);
        return;
      }
      let line = this.#lineBuffer.byteLength === 0
        ? segment
        : Buffer.concat([this.#lineBuffer, segment]);
      this.#lineBuffer = Buffer.alloc(0);
      offset = newline + 1;
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.byteLength === 0) {
        this.#protocolFailure();
        return;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        this.#processLine(text, generation);
        this.#maybeRollover();
      } catch {
        this.#protocolFailure();
        return;
      }
      if (this.#child === undefined || this.#failedGeneration === generation) return;
    }
  }

  #processLine(line: string, generation: number): void {
    if (generation !== this.#generation || this.#failedGeneration === generation) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#protocolFailure();
      return;
    }
    const frame = parseIncomingFrame(parsed, this.#options.protocolVersion);
    if (frame === undefined) {
      this.#protocolFailure();
      return;
    }
    if ("id" in frame) {
      if (this.#seenInboundIds.has(frame.id) || this.#seenInboundIds.size >= MAX_TRACKED_IDS) {
        this.#protocolFailure();
        return;
      }
      this.#rememberInboundId(frame.id);
    }
    if (this.#stopRequested) {
      if (frame.type === "response" && this.#pending.has(frame.id)) this.#handleResponse(frame);
      return;
    }
    if (this.#rolloverGeneration === generation) {
      if (frame.type === "response") this.#handleResponse(frame);
      // New ingress remains durable in the Rust journal and is deliberately
      // left unacknowledged for replay after the next verified handshake.
      // Readiness notifications must not reopen intake during this drain.
      else if (frame.type === "hello") this.#protocolFailure();
      return;
    }
    if (this.#handshakePhase === "blocked") {
      if (frame.type === "response" && this.#pending.has(frame.id)) {
        this.#handleResponse(frame);
        return;
      }
      if (frame.type === "status" && frame.readiness !== "ready") {
        this.#setStatus("alive", "not_ready", "sidecar_not_ready", false);
        return;
      }
      if (
        frame.type === "ready"
        && frame.readiness === "ready"
        && identityMatches(frame.identity, this.#options.expectedIdentity)
        && (this.#activeMediaBootId === undefined || frame.identity.spool_instance === this.#activeMediaBootId)
      ) {
        this.#identityVerified = true;
        this.#activeMediaBootId = frame.identity.spool_instance;
        this.#handshakePhase = "ready";
        this.#acceptingRequests = true;
        this.#setStatus("alive", "ready", "ready", false);
        return;
      }
      this.#protocolFailure();
      return;
    }
    if (this.#handshakePhase !== "ready") {
      if (this.#handshakePhase === "waiting_sidecar_hello" && frame.type === "hello") {
        if (!equalAscii(frame.build, this.#options.expectedIdentity.build)) {
          this.#failGeneration("handshake_rejected", "handshake_failed");
          return;
        }
        this.#supervisorHelloId = this.#nextId("hello");
        this.#handshakePhase = "waiting_supervisor_response";
        void this.#writeFrame({
          type: "hello",
          version: this.#options.protocolVersion,
          id: this.#supervisorHelloId,
          supervisor: "godaddy-node"
        }).catch(() => this.#protocolFailure());
        return;
      }
      if (
        this.#handshakePhase === "waiting_supervisor_response"
        && frame.type === "response"
        && frame.id === this.#supervisorHelloId
        && frame.ok
        && frame.result.name === "health"
      ) {
        this.#initializeId = this.#nextId("initialize");
        this.#handshakePhase = "waiting_initialize_response";
        void this.#writeFrame({
          type: "request",
          version: this.#options.protocolVersion,
          id: this.#initializeId,
          command: Object.freeze({ name: "initialize" })
        }).catch(() => this.#protocolFailure());
        return;
      }
      if (
        this.#handshakePhase === "waiting_initialize_response"
        && frame.type === "response"
        && frame.id === this.#initializeId
        && frame.ok
        && frame.result.name === "initialized"
      ) {
        this.#handshakePhase = "waiting_ready";
        return;
      }
      if (
        this.#handshakePhase === "waiting_ready"
        && frame.type === "ready"
      ) {
        if (!identityMatches(frame.identity, this.#options.expectedIdentity)) {
          this.#failGeneration("handshake_rejected", "handshake_failed");
          return;
        }
        if (frame.readiness === "blocked" || frame.readiness === "quarantined") {
          this.#handshakePhase = "blocked";
          this.#acceptingRequests = false;
          this.#identityVerified = false;
          this.#activeMediaBootId = frame.identity.spool_instance;
          this.#setStatus("alive", "not_ready", "sidecar_not_ready", false);
          this.#handshake?.resolve();
          return;
        }
        if (
          frame.readiness !== "ready"
        ) {
          this.#failGeneration("handshake_rejected", "handshake_failed");
          return;
        }
        this.#identityVerified = true;
        this.#activeMediaBootId = frame.identity.spool_instance;
        this.#handshakePhase = "ready";
        this.#acceptingRequests = true;
        this.#setStatus("alive", "ready", "ready", false);
        this.#handshake?.resolve();
        return;
      }
      if (
        frame.type === "response"
        && !frame.ok
        && (frame.id === this.#supervisorHelloId || frame.id === this.#initializeId)
      ) {
        if (frame.id === this.#initializeId && frame.error === "lock_contended") {
          this.#handleLockContention();
          return;
        }
        if (frame.id === this.#initializeId && frame.error === "not_ready") {
          // The pinned protocol reports temporary initial sync failures as
          // not_ready. Retry the same store after confirmed child exit; every
          // launch revalidates identity/trust. This never provisions or grants
          // access when authorization/policy remains invalid.
          this.#failGeneration("spawn_failed", "spawn_failed");
          return;
        }
        if (frame.id === this.#initializeId && frame.error === "store_quarantined") {
          this.#recoveryPermitted = false;
          this.#handshakePhase = "blocked";
          this.#acceptingRequests = false;
          this.#identityVerified = false;
          this.#activeMediaBootId = undefined;
          this.#setStatus("alive", "not_ready", "sidecar_not_ready", false);
          this.#handshake?.resolve();
          return;
        }
        this.#failGeneration("handshake_rejected", "handshake_failed");
        return;
      }
      this.#protocolFailure();
      return;
    }
    switch (frame.type) {
      case "response":
        this.#handleResponse(frame);
        return;
      case "event":
        this.#handleEvent(frame);
        return;
      case "event_rejected":
        this.#handleRejectedEvent(frame);
        return;
      case "ready": {
        if (
          !identityMatches(frame.identity, this.#options.expectedIdentity)
          || frame.identity.spool_instance !== this.#activeMediaBootId
        ) {
          this.#protocolFailure();
          return;
        }
        const ready = frame.readiness === "ready" && this.#identityVerified;
        if (!ready) {
          this.#identityVerified = false;
          this.#handshakePhase = "blocked";
        }
        this.#acceptingRequests = ready;
        this.#setStatus("alive", ready ? "ready" : "not_ready", ready ? "ready" : "sidecar_not_ready", false);
        return;
      }
      case "status": {
        if (frame.readiness === "ready" && !this.#identityVerified) {
          this.#protocolFailure();
          return;
        }
        const ready = frame.readiness === "ready";
        if (!ready) {
          this.#identityVerified = false;
          this.#handshakePhase = "blocked";
        }
        this.#acceptingRequests = ready;
        this.#setStatus("alive", ready ? "ready" : "not_ready", ready ? "ready" : "sidecar_not_ready", false);
        return;
      }
      default:
        this.#protocolFailure();
    }
  }

  #handleResponse(frame: Extract<IncomingFrame, { type: "response" }>): void {
    if (this.#expiredIds.has(frame.id)) {
      this.#protocolFailure();
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) {
      this.#protocolFailure();
      return;
    }
    this.#clock.clearTimeout(pending.timeoutHandle);
    this.#pending.delete(frame.id);
    if (frame.ok) {
      pending.resolve(frame.result);
    } else {
      if (frame.error === "lock_contended") {
        pending.reject(new MatrixSidecarError("lock_contended"));
        this.#handleLockContention();
      } else if (frame.error === "not_ready" || frame.error === "store_quarantined") {
        this.#acceptingRequests = false;
        this.#identityVerified = false;
        this.#handshakePhase = "blocked";
        this.#setStatus("alive", "not_ready", "sidecar_not_ready", false);
        pending.reject(new MatrixSidecarError(frame.error));
      } else if (
        frame.error === "policy_denied"
        || frame.error === "media_denied"
        || frame.error === "transport_failed"
      ) {
        pending.reject(new MatrixSidecarError(frame.error));
      } else {
        pending.reject(new MatrixSidecarError("protocol_error"));
        this.#protocolFailure();
      }
    }
    this.#notifyDrained();
  }

  #handleEvent(frame: Extract<IncomingFrame, { type: "event" }>): void {
    if (
      this.#stopRequested
      || !this.#identityVerified
      || this.#status.matrixReadiness !== "ready"
      || this.#unackedEvents.size >= this.#options.maxUnackedEvents
    ) {
      this.#protocolFailure();
      return;
    }
    const event = Object.freeze({ receiptId: frame.id, payload: frame.event });
    this.#unackedEvents.set(frame.id, event);
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(event);
      } catch {
        this.#diagnostic({ code: "subscriber_failed" });
      }
    }
  }

  #handleRejectedEvent(frame: Extract<IncomingFrame, { type: "event_rejected" }>): void {
    if (
      this.#stopRequested
      || !this.#identityVerified
      || this.#status.matrixReadiness !== "ready"
      || this.#unackedEvents.size >= this.#options.maxUnackedEvents
    ) {
      this.#protocolFailure();
      return;
    }
    const rejection = Object.freeze({ receiptId: frame.id, rejection: frame.rejection });
    this.#unackedEvents.set(frame.id, rejection);
    for (const subscriber of this.#rejectionSubscribers) {
      try {
        subscriber(rejection);
      } catch {
        this.#diagnostic({ code: "subscriber_failed" });
      }
    }
  }

  #protocolFailure(): void {
    this.#failGeneration("protocol_error", "protocol_error");
  }

  #handleLockContention(): void {
    const generation = this.#generation;
    if (this.#failedGeneration === generation) return;
    this.#failedGeneration = generation;
    this.#restartCause = "lock_contended";
    this.#acceptingRequests = false;
    this.#identityVerified = false;
    this.#activeMediaBootId = undefined;
    this.#handshakePhase = "lock_contended";
    this.#rejectPending("not_ready");
    this.#setStatus(this.#child === undefined ? "dead" : "alive", "not_ready", "lock_contended", false);
    this.#diagnostic({ code: "lock_contended" });
    this.#handshake?.resolve();
    this.#terminateFailedGeneration(generation);
  }

  #failGeneration(
    code: "handshake_timeout" | "handshake_rejected" | "protocol_error" | "spawn_failed",
    reason: "handshake_failed" | "protocol_error" | "spawn_failed"
  ): void {
    const generation = this.#generation;
    if (this.#failedGeneration === generation) return;
    this.#failedGeneration = generation;
    if (code === "protocol_error" || code === "handshake_rejected") this.#recoveryPermitted = false;
    this.#restartCause = "crash";
    this.#acceptingRequests = false;
    this.#identityVerified = false;
    this.#activeMediaBootId = undefined;
    this.#handshakePhase = "failed";
    this.#abortHandshake(code);
    this.#rejectPending(code === "protocol_error" ? "protocol_error" : "not_ready");
    this.#setStatus(this.#child === undefined ? "dead" : "alive", "not_ready", reason, false);
    this.#terminateFailedGeneration(generation);
  }

  #terminateFailedGeneration(generation: number): void {
    const child = this.#child;
    if (child === undefined || generation !== this.#generation) return;
    child.kill("SIGTERM");
    if (this.#failureTerminationTimer !== undefined) this.#clock.clearTimeout(this.#failureTerminationTimer);
    this.#failureTerminationTimer = this.#clock.setTimeout(() => {
      this.#failureTerminationTimer = undefined;
      if (generation !== this.#generation || this.#child !== child) return;
      child.kill("SIGKILL");
    }, this.#options.terminateTimeoutMs);
  }

  #abortHandshake(code: "handshake_timeout" | "handshake_rejected" | "protocol_error" | "spawn_failed" | "stopped"): void {
    const handshake = this.#handshake;
    this.#handshake = undefined;
    if (handshake !== undefined) handshake.reject(new MatrixSidecarError(code));
  }

  #handleExit(generation: number): void {
    if (generation !== this.#generation) return;
    const restartCause = this.#restartCause;
    this.#failedGeneration = generation;
    if (this.#failureTerminationTimer !== undefined) {
      this.#clock.clearTimeout(this.#failureTerminationTimer);
      this.#failureTerminationTimer = undefined;
    }
    this.#child = undefined;
    this.#acceptingRequests = false;
    this.#handshakePhase = "idle";
    this.#identityVerified = false;
    this.#activeMediaBootId = undefined;
    this.#abortHandshake(this.#stopRequested ? "stopped" : "spawn_failed");
    this.#rejectPending(this.#stopRequested ? "stopped" : "not_ready");
    this.#unackedEvents.clear();
    this.#notifyDrained();
    if (this.#stopRequested) {
      this.#setStatus("stopped", "not_ready", "stopped", false);
      return;
    }
    if (this.#rolloverGeneration === generation) {
      this.#setStatus("starting", "not_ready", "generation_rollover", false);
      return;
    }
    this.#scheduleRestart(restartCause);
  }

  #scheduleRestart(cause: "crash" | "lock_contended" = "crash"): void {
    if (cause === "lock_contended") {
      this.#lockContentionAttempts += 1;
      const restartCount = this.#lockContentionAttempts;
      if (restartCount >= this.#options.maxLockContentionRetries) {
        this.#openCircuit(restartCount);
        return;
      }
      const delay = this.#options.lockContentionBackoffMs[
        Math.min(restartCount - 1, this.#options.lockContentionBackoffMs.length - 1)
      ] ?? 0;
      this.#setStatus("dead", "not_ready", "lock_contended", false, restartCount);
      this.#diagnostic({ code: "restart_scheduled" });
      this.#scheduleLaunch(delay, restartCount);
      return;
    }
    this.#lockContentionAttempts = 0;
    const now = this.#clock.now();
    this.#crashTimes = this.#crashTimes.filter((time) => now - time <= this.#options.crashWindowMs);
    this.#crashTimes.push(now);
    const restartCount = this.#crashTimes.length;
    if (restartCount >= this.#options.maxCrashes) {
      this.#openCircuit(restartCount);
      return;
    }
    const delay = this.#options.restartBackoffMs[Math.min(restartCount - 1, this.#options.restartBackoffMs.length - 1)] ?? 0;
    this.#setStatus("dead", "not_ready", "crash_backoff", false, restartCount);
    this.#diagnostic({ code: "restart_scheduled" });
    this.#scheduleLaunch(delay, restartCount);
  }

  #openCircuit(restartCount: number): void {
    this.#circuitOpenRestartCount = restartCount;
    this.#circuitOpenCount = Math.min(8, this.#circuitOpenCount + 1);
    const random = this.#random();
    const jitter = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5;
    const delay = Math.min(5 * 60_000, Math.ceil(this.#options.circuitCooldownMs
      * 2 ** (this.#circuitOpenCount - 1) * (0.75 + 0.25 * jitter)));
    this.#circuitRecoveryDueAt = this.#clock.now() + delay;
    this.#setStatus("dead", "not_ready", "circuit_open", true, restartCount);
    this.#diagnostic({ code: "circuit_open" });
    this.#scheduleHalfOpen();
  }

  #scheduleHalfOpen(): void {
    if (!this.#recoveryPermitted || this.#stopRequested || this.#child !== undefined
      || this.#restartTimer !== undefined || this.#circuitOpenRestartCount === undefined) return;
    const generation = this.#generation;
    this.#restartTimer = this.#clock.setTimeout(() => {
      this.#restartTimer = undefined;
      if (this.#stopRequested || this.#child !== undefined || generation !== this.#generation
        || !this.#recoveryPermitted || this.#circuitOpenRestartCount === undefined) return;
      // One half-open worker only, after the preceding child's confirmed exit.
      // The exclusive Rust store lock and full binary/identity handshake stay
      // in force. Clear only volatile retry counts, never persistent state.
      this.#circuitOpenRestartCount = undefined;
      this.#crashTimes = [];
      this.#lockContentionAttempts = 0;
      this.#scheduleLaunch(0, 0);
    }, Math.max(0, this.#circuitRecoveryDueAt - this.#clock.now()));
  }

  #scheduleLaunch(delay: number, restartCount: number): void {
    this.#restartTimer = this.#clock.setTimeout(() => {
      this.#restartTimer = undefined;
      if (this.#stopRequested) return;
      this.#setStatus("starting", "not_ready", "starting", false, restartCount);
      const launch = this.#launch();
      this.#startPromise = launch;
      void (async () => {
        try {
          await launch;
        } catch {
          if (!this.#stopRequested && this.#child === undefined && this.#restartTimer === undefined) {
            this.#scheduleRestart("crash");
          }
        } finally {
          if (this.#startPromise === launch) this.#startPromise = undefined;
        }
      })();
    }, delay);
  }

  #rejectPending(code: MatrixSidecarErrorCode): void {
    for (const pending of this.#pending.values()) {
      this.#clock.clearTimeout(pending.timeoutHandle);
      pending.reject(new MatrixSidecarError(code));
    }
    this.#pending.clear();
    this.#notifyDrained();
  }

  #rememberExpiredId(id: string): void {
    this.#expiredIds.add(id);
    if (this.#expiredIds.size <= MAX_TRACKED_IDS) return;
    const oldest = this.#expiredIds.values().next().value as string | undefined;
    if (oldest !== undefined) this.#expiredIds.delete(oldest);
  }

  #rememberInboundId(id: string): void {
    this.#seenInboundIds.add(id);
  }

  #notifyDrained(): void {
    if (this.#pending.size > 0 || this.#unackedEvents.size > 0) return;
    for (const resolve of this.#drainWaiters) resolve();
    this.#drainWaiters.clear();
  }

  async #waitForDrain(milliseconds: number): Promise<void> {
    if (this.#pending.size === 0 && this.#unackedEvents.size === 0) return;
    let timeoutHandle: unknown;
    await new Promise<void>((resolve, reject) => {
      const drained = (): void => {
        this.#clock.clearTimeout(timeoutHandle);
        this.#drainWaiters.delete(drained);
        resolve();
      };
      this.#drainWaiters.add(drained);
      timeoutHandle = this.#clock.setTimeout(() => {
        this.#drainWaiters.delete(drained);
        reject(new MatrixSidecarError("stopped"));
      }, milliseconds);
    });
  }

  async #waitForExit(exit: Deferred, milliseconds: number): Promise<boolean> {
    let timeoutHandle: unknown;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        this.#clock.clearTimeout(timeoutHandle);
        resolve(value);
      };
      void exit.promise.then(() => settle(true), () => settle(true));
      timeoutHandle = this.#clock.setTimeout(() => settle(false), milliseconds);
    });
  }

  #sendCorrelated<T>(
    frame: Readonly<Record<string, unknown>>,
    id: string,
    timeoutMs: number,
    failOnTimeout = true
  ): Promise<T> {
    if (this.#pending.size >= this.#options.maxOutstandingRequests) {
      return Promise.reject(new MatrixSidecarError("request_limit"));
    }
    const generation = this.#generation;
    return new Promise<T>((resolve, reject) => {
      const timeoutHandle = this.#clock.setTimeout(() => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        this.#rememberExpiredId(id);
        pending.reject(new MatrixSidecarError("request_timeout"));
        this.#notifyDrained();
        if (failOnTimeout) this.#protocolFailure();
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeoutHandle
      });
      void this.#writeFrame(
        frame,
        () => this.#pending.has(id)
          && this.#generation === generation
          && this.#failedGeneration !== generation
      ).catch((error: unknown) => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#clock.clearTimeout(pending.timeoutHandle);
        this.#pending.delete(id);
        pending.reject(error instanceof MatrixSidecarError ? error : new MatrixSidecarError("protocol_error"));
        this.#notifyDrained();
        if (!this.#stopRequested && this.#generation === generation) this.#protocolFailure();
      });
    });
  }

  #writeFrame(frame: Readonly<Record<string, unknown>>, mayWrite: () => boolean = () => true): Promise<void> {
    let encoded: string;
    try {
      const serialized = JSON.stringify(frame);
      if (typeof serialized !== "string") throw new MatrixSidecarError("protocol_error");
      encoded = `${serialized}\n`;
    } catch {
      return Promise.reject(new MatrixSidecarError("protocol_error"));
    }
    if (Buffer.byteLength(encoded, "utf8") > this.#options.maxLineBytes) {
      return Promise.reject(new MatrixSidecarError("protocol_error"));
    }
    const generation = this.#generation;
    const operation = this.#writeChain.then(async () => {
      if (
        generation !== this.#generation
        || this.#failedGeneration === generation
        || !mayWrite()
      ) return;
      const input = this.#child?.stdin;
      const childExit = this.#childExit;
      if (input === undefined || input === null) throw new MatrixSidecarError("stopped");
      if (input.write(encoded, "utf8")) return;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timeoutHandle: unknown;
        const finish = (error?: MatrixSidecarError): void => {
          if (settled) return;
          settled = true;
          this.#clock.clearTimeout(timeoutHandle);
          input.off?.("drain", drained);
          if (error === undefined) resolve();
          else reject(error);
        };
        const drained = (): void => {
          finish();
        };
        input.once("drain", drained);
        timeoutHandle = this.#clock.setTimeout(() => {
          finish(new MatrixSidecarError("backpressure_timeout"));
        }, this.#options.handshakeTimeoutMs);
        void childExit?.promise.then(
          () => finish(new MatrixSidecarError("stopped")),
          () => finish(new MatrixSidecarError("stopped"))
        );
      });
    });
    this.#writeChain = operation.catch(() => undefined);
    return operation;
  }

  #nextId(prefix: string): string {
    this.#idCounter += 1;
    this.#generationFrameCount += 1;
    // Queue after the current correlated request has registered itself; the
    // drain must account for the frame which crossed the retirement budget.
    queueMicrotask(() => this.#maybeRollover());
    return `${prefix}-${this.#idCounter}`;
  }

  #setStatus(
    liveness: MatrixSidecarStatus["liveness"],
    matrixReadiness: MatrixSidecarStatus["matrixReadiness"],
    reason: MatrixSidecarStatus["reason"],
    circuitOpen: boolean,
    restartCount = Math.max(this.#crashTimes.length, this.#lockContentionAttempts)
  ): void {
    this.#status = Object.freeze({ liveness, matrixReadiness, reason, restartCount, circuitOpen });
  }

  #diagnostic(diagnostic: MatrixSidecarDiagnostic): void {
    try {
      this.#onDiagnostic?.(Object.freeze({ ...diagnostic }));
    } catch {
      // Diagnostics cannot affect supervision or expose the originating value.
    }
  }
}
