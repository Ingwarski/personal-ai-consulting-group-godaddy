import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  MatrixSidecarError,
  type MatrixSidecarEvent,
  type MatrixSidecarIngressRejection,
  type MatrixSidecarStatus,
  type MatrixSidecarSupervisor
} from "./matrix-sidecar-supervisor.ts";

const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_FORMATTED_BYTES = 128 * 1024;
const SAFE_PROTOCOL_ID = /^[A-Za-z0-9._:-]{1,64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MEDIA_HANDLE = /^([a-f0-9]{32})-[a-f0-9]{24}\.(jpg|png|pdf|ogg)$/u;
const MAX_MEDIA_OBJECTS = 4;
const MAX_MEDIA_OBJECT_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_AGGREGATE_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_INGRESS = 64;
const MAX_ROOM_POLICY_AGE_MS = 60_000;

export type MatrixRuntimeReadiness = Readonly<{
  liveness: MatrixSidecarStatus["liveness"];
  matrixReadiness: MatrixSidecarStatus["matrixReadiness"];
  reason: MatrixSidecarStatus["reason"];
  circuitOpen: boolean;
}>;

export type MatrixRuntimeConfig = Readonly<{
  homeserverUrl: string;
  roomId: string;
  ownerMxid: string;
  botMxid: string;
  botDeviceId: string;
  mediaSpoolParent: string;
  mediaOwnerUid?: number;
}>;

export type MatrixRuntimeDependencyReadiness = Readonly<{
  mysqlAvailable: boolean;
  outboxAvailable: boolean;
  egressPolicyPass: boolean;
}>;

export type MatrixIngressMedia = Readonly<{
  handle: string;
  declaredMime: "image/jpeg" | "image/png" | "application/pdf" | "audio/ogg";
  length: number;
  sha256: string;
}>;

export type MatrixIngressMediaObject = Readonly<MatrixIngressMedia & {
  bytes: Buffer;
}>;

export type ValidatedMatrixIngress = Readonly<{
  receiptId: string;
  eventId: string;
  roomId: string;
  senderMxid: string;
  senderDeviceId: string;
  body: string | null;
  relationEventId?: string;
  media: readonly MatrixIngressMedia[];
}>;

export type ValidatedMatrixIngressRejection = Readonly<{
  receiptId: string;
  eventId: string;
  roomId: string;
  senderMxid: string;
  senderDeviceId: string;
  bodyHash: string;
  mediaManifestHash: string;
  eventHash: string;
  reason: "media_expired" | "invalid_media";
}>;

export type MatrixSendInput = Readonly<{
  transactionId: string;
  body: string;
  formattedBody?: string;
  relationEventId?: string;
  roomPolicy: MatrixRoomPolicySnapshot;
}>;

export type MatrixRoomPolicySnapshot = Readonly<{
  encrypted: true;
  inviteOnly: true;
  joinedMembers: readonly string[];
  pendingInvites: 0;
  historyVisibilityJoined: true;
  publicAlias: false;
  publicListing: false;
  guestsAllowed: false;
  bridgesPresent: false;
  widgetsPresent: false;
  ownerDevicesTrusted: true;
  botDeviceTrusted: true;
  devicesNonRevoked: true;
  observedAtMs: number;
}>;

export type MatrixAcceptanceReceipt = Readonly<{
  transactionId: string;
  eventId: string;
  status: "accepted";
}>;

export type MatrixRuntime = Readonly<{
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getReadiness: () => MatrixRuntimeReadiness;
  onIngress: (subscriber: (event: ValidatedMatrixIngress) => void | Promise<void>) => () => void;
  onRejectedIngress: (
    subscriber: (rejection: ValidatedMatrixIngressRejection) => void | Promise<void>
  ) => () => void;
  ackIngress: (input: Readonly<{ receiptId: string; durableReceiptId: string }>) => Promise<void>;
  readMedia: (media: readonly MatrixIngressMedia[]) => Promise<readonly MatrixIngressMediaObject[]>;
  send: (input: MatrixSendInput) => Promise<MatrixAcceptanceReceipt>;
}>;

type SidecarPort = Pick<
  MatrixSidecarSupervisor,
  | "start"
  | "stop"
  | "getStatus"
  | "assertRuntimeBinding"
  | "onEvent"
  | "onRejectedEvent"
  | "ack"
  | "request"
  | "failClosed"
>;

type ValidatedMatrixRuntimeConfig = Readonly<{
  homeserverUrl: string;
  roomId: string;
  ownerMxid: string;
  botMxid: string;
  botDeviceId: string;
  mediaSpoolParent: string;
  mediaOwnerUid: number;
}>;

export type MatrixMediaStat = Readonly<{
  mode: number;
  uid: number;
  size: number;
  dev: number;
  ino: number;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}>;

export type MatrixMediaFileHandle = Readonly<{
  stat: () => Promise<MatrixMediaStat>;
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ) => Promise<Readonly<{ bytesRead: number }>>;
  close: () => Promise<void>;
}>;

export type MatrixMediaFileSystem = Readonly<{
  lstat: (path: string) => Promise<MatrixMediaStat>;
  openNoFollow: (path: string) => Promise<MatrixMediaFileHandle>;
}>;

const nativeMediaFileSystem: MatrixMediaFileSystem = Object.freeze({
  lstat: async (path) => lstat(path) as unknown as MatrixMediaStat,
  openNoFollow: async (path) => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) as unknown as MatrixMediaFileHandle
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function nonEmptyText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function validMatrixEventId(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("$")
    && value.length <= 255
    && /^[\x21-\x7e]+$/u.test(value);
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

function validMxid(value: unknown): value is string {
  return typeof value === "string"
    && /^@[A-Za-z0-9._=+\-/]+:[A-Za-z0-9.-]+$/u.test(value)
    && Buffer.byteLength(value, "utf8") <= 255;
}

function validRoomId(value: unknown): value is string {
  return typeof value === "string"
    && /^![A-Za-z0-9._=+\-/]+:[A-Za-z0-9.-]+$/u.test(value)
    && Buffer.byteLength(value, "utf8") <= 255;
}

function validateConfig(config: MatrixRuntimeConfig): ValidatedMatrixRuntimeConfig {
  if (
    !isRecord(config)
    || !hasOnlyKeys(config, [
      "homeserverUrl",
      "roomId",
      "ownerMxid",
      "botMxid",
      "botDeviceId",
      "mediaSpoolParent",
      "mediaOwnerUid"
    ])
    || typeof config.homeserverUrl !== "string"
    || typeof config.mediaSpoolParent !== "string"
  ) throw new MatrixSidecarError("invalid_configuration");
  const homeserverUrl = exactHttpsOrigin(config.homeserverUrl);
  const spoolParent = isAbsolute(config.mediaSpoolParent) ? resolve(config.mediaSpoolParent) : undefined;
  const mediaOwnerUid = config.mediaOwnerUid ?? (typeof process.geteuid === "function" ? process.geteuid() : -1);
  if (
    homeserverUrl !== "https://matrix.org"
    || !validRoomId(config.roomId)
    || !validMxid(config.ownerMxid)
    || !validMxid(config.botMxid)
    || !validDeviceId(config.botDeviceId)
    || config.ownerMxid === config.botMxid
    || spoolParent === undefined
    || spoolParent !== config.mediaSpoolParent
    || spoolParent.includes("\0")
    || !Number.isSafeInteger(mediaOwnerUid)
    || mediaOwnerUid < 0
  ) throw new MatrixSidecarError("invalid_configuration");
  const homeserverHost = new URL(homeserverUrl).hostname;
  if (![config.roomId, config.ownerMxid, config.botMxid].every((value) => value.endsWith(`:${homeserverHost}`))) {
    throw new MatrixSidecarError("invalid_configuration");
  }
  return Object.freeze({
    homeserverUrl,
    roomId: config.roomId,
    ownerMxid: config.ownerMxid,
    botMxid: config.botMxid,
    botDeviceId: config.botDeviceId,
    mediaSpoolParent: spoolParent,
    mediaOwnerUid
  });
}

function parseMedia(value: unknown): MatrixIngressMedia | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["handle", "declared_mime", "length", "sha256"])) return undefined;
  if (
    typeof value.handle !== "string"
    || !MEDIA_HANDLE.test(value.handle)
    || !["image/jpeg", "image/png", "application/pdf", "audio/ogg"].includes(value.declared_mime as string)
    || !Number.isSafeInteger(value.length)
    || (value.length as number) <= 0
    || (value.length as number) > 20 * 1024 * 1024
    || typeof value.sha256 !== "string"
    || !SHA256.test(value.sha256)
  ) return undefined;
  return Object.freeze({
    handle: value.handle,
    declaredMime: value.declared_mime as MatrixIngressMedia["declaredMime"],
    length: value.length as number,
    sha256: value.sha256
  });
}

function validDeviceId(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= 255
    && /^[\x21-\x7e]+$/u.test(value);
}

function parseIngress(sidecarEvent: MatrixSidecarEvent, config: ValidatedMatrixRuntimeConfig): ValidatedMatrixIngress | undefined {
  const value = sidecarEvent.payload;
  if (!SAFE_PROTOCOL_ID.test(sidecarEvent.receiptId) || !isRecord(value) || !hasOnlyKeys(value, [
    "event_id",
    "room_id",
    "sender_mxid",
    "sender_device_id",
    "body",
    "reply_to_event_id",
    "media"
  ])) return undefined;
  if (
    value.room_id !== config.roomId
    || value.sender_mxid !== config.ownerMxid
    || !validDeviceId(value.sender_device_id)
    || !validMatrixEventId(value.event_id)
    || (value.body !== null && !nonEmptyText(value.body, MAX_PLAINTEXT_BYTES))
    || !Array.isArray(value.media)
    || value.media.length > 4
  ) return undefined;
  if (value.reply_to_event_id !== null && !validMatrixEventId(value.reply_to_event_id)) {
    return undefined;
  }
  const media = value.media.map(parseMedia);
  if (media.some((item) => item === undefined)) return undefined;
  const validatedMedia = media as MatrixIngressMedia[];
  if (
    new Set(validatedMedia.map((item) => item.handle)).size !== validatedMedia.length
    || validatedMedia.reduce((total, item) => total + item.length, 0) > MAX_MEDIA_AGGREGATE_BYTES
  ) return undefined;
  if (value.body === null && validatedMedia.length === 0) return undefined;
  return Object.freeze({
    receiptId: sidecarEvent.receiptId,
    eventId: value.event_id,
    roomId: config.roomId,
    senderMxid: config.ownerMxid,
    senderDeviceId: value.sender_device_id,
    body: value.body,
    ...(value.reply_to_event_id === null ? {} : { relationEventId: value.reply_to_event_id }),
    media: Object.freeze(validatedMedia)
  });
}

function parseIngressRejection(
  sidecarRejection: MatrixSidecarIngressRejection,
  config: ValidatedMatrixRuntimeConfig
): ValidatedMatrixIngressRejection | undefined {
  if (!isRecord(sidecarRejection) || !hasOnlyKeys(sidecarRejection, ["receiptId", "rejection"])) return undefined;
  const value = sidecarRejection.rejection;
  if (!SAFE_PROTOCOL_ID.test(sidecarRejection.receiptId) || !isRecord(value) || !hasOnlyKeys(value, [
    "event_id",
    "room_id",
    "sender_mxid",
    "sender_device_id",
    "body_hash",
    "media_manifest_hash",
    "event_hash",
    "reason"
  ])) return undefined;
  if (
    value.room_id !== config.roomId
    || value.sender_mxid !== config.ownerMxid
    || !validDeviceId(value.sender_device_id)
    || !validMatrixEventId(value.event_id)
    || typeof value.body_hash !== "string" || !SHA256.test(value.body_hash)
    || typeof value.media_manifest_hash !== "string" || !SHA256.test(value.media_manifest_hash)
    || typeof value.event_hash !== "string" || !SHA256.test(value.event_hash)
    || (value.reason !== "media_expired" && value.reason !== "invalid_media")
  ) return undefined;
  return Object.freeze({
    receiptId: sidecarRejection.receiptId,
    eventId: value.event_id,
    roomId: config.roomId,
    senderMxid: config.ownerMxid,
    senderDeviceId: value.sender_device_id,
    bodyHash: value.body_hash,
    mediaManifestHash: value.media_manifest_hash,
    eventHash: value.event_hash,
    reason: value.reason
  });
}

function sha256Json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new MatrixSidecarError("protocol_error");
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function ingressHashes(event: ValidatedMatrixIngress): Readonly<{
  bodyHash: string;
  mediaManifestHash: string;
  eventHash: string;
}> {
  const media = event.media.map((item) => ({
    declaredMime: item.declaredMime,
    length: item.length,
    sha256: item.sha256
  }));
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
  return Object.freeze({ bodyHash, mediaManifestHash, eventHash });
}

function parseAcceptance(value: unknown, expectedTransactionId: string): MatrixAcceptanceReceipt | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["name", "event_id"])) return undefined;
  if (
    value.name !== "accepted"
    || !validMatrixEventId(value.event_id)
  ) return undefined;
  return Object.freeze({ transactionId: expectedTransactionId, eventId: value.event_id, status: "accepted" });
}

function validRoomPolicy(
  policy: MatrixRoomPolicySnapshot,
  config: ValidatedMatrixRuntimeConfig,
  nowMs: number
): boolean {
  if (!isRecord(policy) || !Array.isArray(policy.joinedMembers)) return false;
  const joined = [...policy.joinedMembers].sort();
  const expected = [config.botMxid, config.ownerMxid].sort();
  return policy.encrypted === true
    && policy.inviteOnly === true
    && joined.length === expected.length
    && joined.every((mxid, index) => mxid === expected[index])
    && policy.pendingInvites === 0
    && policy.historyVisibilityJoined === true
    && policy.publicAlias === false
    && policy.publicListing === false
    && policy.guestsAllowed === false
    && policy.bridgesPresent === false
    && policy.widgetsPresent === false
    && policy.ownerDevicesTrusted === true
    && policy.botDeviceTrusted === true
    && policy.devicesNonRevoked === true
    && Number.isSafeInteger(policy.observedAtMs)
    && policy.observedAtMs >= 0
    && Number.isSafeInteger(nowMs)
    && nowMs >= policy.observedAtMs
    && nowMs - policy.observedAtMs <= MAX_ROOM_POLICY_AGE_MS;
}

function sameMedia(left: MatrixIngressMedia, right: MatrixIngressMedia): boolean {
  return left.handle === right.handle
    && left.declaredMime === right.declaredMime
    && left.length === right.length
    && left.sha256 === right.sha256;
}

function sameIngress(left: ValidatedMatrixIngress, right: ValidatedMatrixIngress): boolean {
  return left.receiptId === right.receiptId
    && left.eventId === right.eventId
    && left.roomId === right.roomId
    && left.senderMxid === right.senderMxid
    && left.senderDeviceId === right.senderDeviceId
    && left.body === right.body
    && left.relationEventId === right.relationEventId
    && left.media.length === right.media.length
    && left.media.every((item, index) => {
      const other = right.media[index];
      return other !== undefined && sameMedia(item, other);
    });
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
    rejection.receiptId !== event.receiptId
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

function validatedMediaBatch(value: unknown): readonly MatrixIngressMedia[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_MEDIA_OBJECTS) return undefined;
  const parsed = value.map((item): MatrixIngressMedia | undefined => {
    if (!isRecord(item) || !hasOnlyKeys(item, ["handle", "declaredMime", "length", "sha256"])) return undefined;
    if (
      typeof item.handle !== "string"
      || !MEDIA_HANDLE.test(item.handle)
      || !["image/jpeg", "image/png", "application/pdf", "audio/ogg"].includes(item.declaredMime as string)
      || !Number.isSafeInteger(item.length)
      || (item.length as number) <= 0
      || (item.length as number) > MAX_MEDIA_OBJECT_BYTES
      || typeof item.sha256 !== "string"
      || !SHA256.test(item.sha256)
    ) return undefined;
    return Object.freeze({
      handle: item.handle,
      declaredMime: item.declaredMime as MatrixIngressMedia["declaredMime"],
      length: item.length as number,
      sha256: item.sha256
    });
  });
  if (parsed.some((item) => item === undefined)) return undefined;
  const media = parsed as MatrixIngressMedia[];
  if (
    new Set(media.map((item) => item.handle)).size !== media.length
    || media.reduce((total, item) => total + item.length, 0) > MAX_MEDIA_AGGREGATE_BYTES
  ) return undefined;
  return Object.freeze(media);
}

function pendingIngressForMediaBatch(
  media: readonly MatrixIngressMedia[],
  pendingIngress: ReadonlyMap<string, ValidatedMatrixIngress>
): ValidatedMatrixIngress | undefined {
  if (media.length === 0) return undefined;
  return [...pendingIngress.values()].find((event) => media.every((candidate) =>
    event.media.some((authorized) => sameMedia(candidate, authorized))
  ));
}

function authorizedBootIds(event: ValidatedMatrixIngress): ReadonlySet<string> {
  const bootIds = event.media.map((item) => MEDIA_HANDLE.exec(item.handle)?.[1]);
  if (bootIds.some((value) => value === undefined)) throw new MatrixSidecarError("protocol_error");
  return new Set(bootIds as string[]);
}

function inspectedMediaMatches(value: unknown, media: readonly MatrixIngressMedia[]): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["name", "objects"]) || value.name !== "media" || !Array.isArray(value.objects)) {
    return false;
  }
  if (value.objects.length !== media.length) return false;
  return value.objects.every((object, index) => {
    const expected = media[index];
    if (expected === undefined || !isRecord(object) || !hasOnlyKeys(object, ["handle", "kind", "length", "sha256"])) {
      return false;
    }
    const kind = expected.declaredMime === "image/jpeg"
      ? "jpeg"
      : expected.declaredMime === "image/png"
        ? "png"
        : expected.declaredMime === "application/pdf" ? "pdf" : "ogg";
    return object.handle === expected.handle
      && object.kind === kind
      && object.length === expected.length
      && object.sha256 === expected.sha256;
  });
}

function sameFileObject(left: MatrixMediaStat, right: MatrixMediaStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validPrivateDirectory(stat: MatrixMediaStat, expectedUid: number): boolean {
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && stat.uid === expectedUid
    && (stat.mode & 0o777) === 0o700
    && (stat.mode & 0o7000) === 0;
}

function validPrivateFile(stat: MatrixMediaStat, expectedUid: number, expectedSize: number): boolean {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.uid === expectedUid
    && stat.size === expectedSize
    && (stat.mode & 0o777) === 0o600
    && (stat.mode & 0o7000) === 0;
}

function detectedMime(bytes: Buffer): MatrixIngressMedia["declaredMime"] | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 5
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d
  ) return "application/pdf";
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
  return undefined;
}

function equalSha256(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}

async function readVerifiedMediaObject(input: Readonly<{
  fileSystem: MatrixMediaFileSystem;
  config: ValidatedMatrixRuntimeConfig;
  authorizedBootIds: ReadonlySet<string>;
  media: MatrixIngressMedia;
}>): Promise<MatrixIngressMediaObject> {
  const match = MEDIA_HANDLE.exec(input.media.handle);
  if (match === null) throw new MatrixSidecarError("protocol_error");
  const bootId = match[1];
  const extension = match[2];
  if (
    bootId === undefined
    || extension === undefined
    || !input.authorizedBootIds.has(bootId)
  ) throw new MatrixSidecarError("protocol_error");

  const spoolParent = input.config.mediaSpoolParent;
  const bootRoot = resolve(spoolParent, `boot-${bootId}`);
  const mediaPath = resolve(bootRoot, input.media.handle);
  if (dirname(bootRoot) !== spoolParent || dirname(mediaPath) !== bootRoot) {
    throw new MatrixSidecarError("protocol_error");
  }

  const parentBefore = await input.fileSystem.lstat(spoolParent);
  const bootBefore = await input.fileSystem.lstat(bootRoot);
  const fileBefore = await input.fileSystem.lstat(mediaPath);
  if (
    !validPrivateDirectory(parentBefore, input.config.mediaOwnerUid)
    || !validPrivateDirectory(bootBefore, input.config.mediaOwnerUid)
    || !validPrivateFile(fileBefore, input.config.mediaOwnerUid, input.media.length)
  ) throw new MatrixSidecarError("protocol_error");

  const handle = await input.fileSystem.openNoFollow(mediaPath);
  let bytes: Buffer | undefined;
  let result: MatrixIngressMediaObject | undefined;
  let operationError: unknown;
  try {
    const openedBefore = await handle.stat();
    if (
      !sameFileObject(fileBefore, openedBefore)
      || !validPrivateFile(openedBefore, input.config.mediaOwnerUid, input.media.length)
    ) throw new MatrixSidecarError("protocol_error");

    const ownedBytes = Buffer.alloc(input.media.length);
    bytes = ownedBytes;
    let offset = 0;
    while (offset < ownedBytes.byteLength) {
      const read = await handle.read(ownedBytes, offset, ownedBytes.byteLength - offset, offset);
      if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead < 0 || read.bytesRead > ownedBytes.byteLength - offset) {
        throw new MatrixSidecarError("protocol_error");
      }
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset !== input.media.length) throw new MatrixSidecarError("protocol_error");

    const openedAfter = await handle.stat();
    const fileAfter = await input.fileSystem.lstat(mediaPath);
    const bootAfter = await input.fileSystem.lstat(bootRoot);
    const parentAfter = await input.fileSystem.lstat(spoolParent);
    if (
      !sameFileObject(openedBefore, openedAfter)
      || !sameFileObject(openedBefore, fileAfter)
      || !sameFileObject(bootBefore, bootAfter)
      || !sameFileObject(parentBefore, parentAfter)
      || !validPrivateFile(openedAfter, input.config.mediaOwnerUid, input.media.length)
      || !validPrivateFile(fileAfter, input.config.mediaOwnerUid, input.media.length)
      || !validPrivateDirectory(bootAfter, input.config.mediaOwnerUid)
      || !validPrivateDirectory(parentAfter, input.config.mediaOwnerUid)
    ) throw new MatrixSidecarError("protocol_error");

    const mime = detectedMime(ownedBytes);
    const expectedExtension = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "application/pdf" ? "pdf" : mime === "audio/ogg" ? "ogg" : undefined;
    const digest = createHash("sha256").update(ownedBytes).digest("hex");
    if (
      mime !== input.media.declaredMime
      || extension !== expectedExtension
      || !equalSha256(digest, input.media.sha256)
    ) throw new MatrixSidecarError("protocol_error");
    result = Object.freeze({ ...input.media, bytes: ownedBytes });
  } catch (error) {
    operationError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    operationError ??= error;
  }
  if (operationError !== undefined || result === undefined) {
    bytes?.fill(0);
    throw operationError ?? new MatrixSidecarError("protocol_error");
  }
  return result;
}

/**
 * Exposes the narrow Node-owned Matrix port. The immutable policy tuple is
 * attached to every outbound request and checked again for every ingress.
 * Credentials remain inside the injected sidecar supervisor environment and
 * never appear in this facade or its public readiness result.
 */
export function createMatrixRuntime(input: Readonly<{
  supervisor: SidecarPort;
  config: MatrixRuntimeConfig;
  readiness: () => MatrixRuntimeDependencyReadiness;
  mediaFileSystem?: MatrixMediaFileSystem;
  now?: () => number;
}>): MatrixRuntime {
  const config = validateConfig(input.config);
  const mediaFileSystem = input.mediaFileSystem ?? nativeMediaFileSystem;
  const now = input.now ?? Date.now;
  const currentTime = (): number => {
    try {
      return typeof now === "function" ? now() : Number.NaN;
    } catch {
      return Number.NaN;
    }
  };
  input.supervisor.assertRuntimeBinding({
    homeserverOrigin: config.homeserverUrl,
    roomId: config.roomId,
    ownerMxid: config.ownerMxid,
    botMxid: config.botMxid,
    botDeviceId: config.botDeviceId,
    mediaSpoolParent: config.mediaSpoolParent
  });
  const pendingIngress = new Map<string, ValidatedMatrixIngress>();
  const pendingRejections = new Map<string, ValidatedMatrixIngressRejection>();
  let subscriber: ((event: ValidatedMatrixIngress) => void | Promise<void>) | undefined;
  let rejectionSubscriber:
    | ((rejection: ValidatedMatrixIngressRejection) => void | Promise<void>)
    | undefined;
  let unsubscribeSidecar: (() => void) | undefined;
  let unsubscribeSidecarRejections: (() => void) | undefined;
  let running = false;
  let lifecycleGeneration = 0;

  const dependenciesReady = (): boolean => {
    try {
      const readiness = input.readiness();
      return isRecord(readiness)
        && readiness.mysqlAvailable === true
        && readiness.outboxAvailable === true
        && readiness.egressPolicyPass === true;
    } catch {
      return false;
    }
  };

  const publicReadiness = (): MatrixRuntimeReadiness => {
    const status = input.supervisor.getStatus();
    const ready = running && status.matrixReadiness === "ready" && dependenciesReady();
    return Object.freeze({
      liveness: status.liveness,
      matrixReadiness: ready ? "ready" : "not_ready",
      reason: ready ? "ready" : status.matrixReadiness === "ready" ? "sidecar_not_ready" : status.reason,
      circuitOpen: status.circuitOpen
    });
  };

  const handleSidecarEvent = (sidecarEvent: MatrixSidecarEvent): void => {
    const event = parseIngress(sidecarEvent, config);
    const existing = pendingIngress.get(sidecarEvent.receiptId);
    if (
      !running
      || event === undefined
      || pendingRejections.has(sidecarEvent.receiptId)
      || (existing !== undefined && !sameIngress(existing, event))
      || (
        existing === undefined
        && pendingIngress.size + pendingRejections.size >= MAX_PENDING_INGRESS
      )
    ) {
      input.supervisor.failClosed();
      return;
    }
    if (existing === undefined) pendingIngress.set(event.receiptId, event);
    const target = subscriber;
    if (target === undefined) {
      input.supervisor.failClosed();
      return;
    }
    const generation = lifecycleGeneration;
    try {
      void Promise.resolve(target(event)).catch(() => {
        if (running && generation === lifecycleGeneration) input.supervisor.failClosed();
      });
    } catch {
      input.supervisor.failClosed();
    }
  };

  const handleSidecarRejection = (sidecarRejection: MatrixSidecarIngressRejection): void => {
    const rejection = parseIngressRejection(sidecarRejection, config);
    const existingRejection = rejection === undefined ? undefined : pendingRejections.get(rejection.receiptId);
    const existingIngress = rejection === undefined ? undefined : pendingIngress.get(rejection.receiptId);
    if (
      !running
      || rejection === undefined
      || (existingRejection !== undefined && !sameIngressRejection(existingRejection, rejection))
      || (existingIngress !== undefined && !rejectionMatchesIngress(rejection, existingIngress))
      || (
        existingRejection === undefined
        && existingIngress === undefined
        && pendingIngress.size + pendingRejections.size >= MAX_PENDING_INGRESS
      )
    ) {
      input.supervisor.failClosed();
      return;
    }
    if (existingRejection === undefined) {
      pendingIngress.delete(rejection.receiptId);
      pendingRejections.set(rejection.receiptId, rejection);
    }
    const target = rejectionSubscriber;
    if (target === undefined) {
      input.supervisor.failClosed();
      return;
    }
    const generation = lifecycleGeneration;
    try {
      void Promise.resolve(target(rejection)).catch(() => {
        if (running && generation === lifecycleGeneration) input.supervisor.failClosed();
      });
    } catch {
      input.supervisor.failClosed();
    }
  };

  return Object.freeze({
    async start(): Promise<void> {
      if (subscriber === undefined || rejectionSubscriber === undefined) {
        throw new MatrixSidecarError("invalid_configuration");
      }
      if (unsubscribeSidecar === undefined) unsubscribeSidecar = input.supervisor.onEvent(handleSidecarEvent);
      if (unsubscribeSidecarRejections === undefined) {
        unsubscribeSidecarRejections = input.supervisor.onRejectedEvent(handleSidecarRejection);
      }
      if (!running) {
        lifecycleGeneration += 1;
        running = true;
      }
      if (input.supervisor.getStatus().circuitOpen) return;
      await input.supervisor.start();
    },
    async stop(): Promise<void> {
      running = false;
      lifecycleGeneration += 1;
      try {
        await input.supervisor.stop();
      } finally {
        unsubscribeSidecar?.();
        unsubscribeSidecar = undefined;
        unsubscribeSidecarRejections?.();
        unsubscribeSidecarRejections = undefined;
        pendingIngress.clear();
        pendingRejections.clear();
      }
    },
    getReadiness: publicReadiness,
    onIngress(nextSubscriber: (event: ValidatedMatrixIngress) => void | Promise<void>): () => void {
      if (typeof nextSubscriber !== "function" || subscriber !== undefined) {
        throw new MatrixSidecarError("invalid_configuration");
      }
      subscriber = nextSubscriber;
      return () => {
        if (subscriber === nextSubscriber) subscriber = undefined;
      };
    },
    onRejectedIngress(
      nextSubscriber: (rejection: ValidatedMatrixIngressRejection) => void | Promise<void>
    ): () => void {
      if (typeof nextSubscriber !== "function" || rejectionSubscriber !== undefined) {
        throw new MatrixSidecarError("invalid_configuration");
      }
      rejectionSubscriber = nextSubscriber;
      return () => {
        if (rejectionSubscriber === nextSubscriber) rejectionSubscriber = undefined;
      };
    },
    async ackIngress(ackInput: Readonly<{ receiptId: string; durableReceiptId: string }>): Promise<void> {
      if (!isRecord(ackInput)) throw new MatrixSidecarError("protocol_error");
      const event = pendingIngress.get(ackInput.receiptId) ?? pendingRejections.get(ackInput.receiptId);
      if (
        event === undefined
        || !SAFE_PROTOCOL_ID.test(ackInput.receiptId)
        || !SAFE_PROTOCOL_ID.test(ackInput.durableReceiptId)
      ) throw new MatrixSidecarError("protocol_error");
      await input.supervisor.ack(ackInput.receiptId, event.eventId, ackInput.durableReceiptId);
      pendingIngress.delete(ackInput.receiptId);
      pendingRejections.delete(ackInput.receiptId);
    },
    async readMedia(mediaInput: readonly MatrixIngressMedia[]): Promise<readonly MatrixIngressMediaObject[]> {
      const media = validatedMediaBatch(mediaInput);
      const pendingEvent = media === undefined ? undefined : pendingIngressForMediaBatch(media, pendingIngress);
      if (media === undefined || (media.length > 0 && pendingEvent === undefined)) {
        throw new MatrixSidecarError("invalid_configuration");
      }
      if (media.length === 0) return Object.freeze([]);
      if (pendingEvent === undefined) throw new MatrixSidecarError("invalid_configuration");
      let inspected: unknown;
      try {
        inspected = await input.supervisor.request("inspect_media", Object.freeze({
          media: Object.freeze(media.map((item) => Object.freeze({
            handle: item.handle,
            declared_mime: item.declaredMime,
            length: item.length,
            sha256: item.sha256
          })))
        }));
      } catch (error) {
        if (
          error instanceof MatrixSidecarError
          && (error.code === "media_denied" || error.code === "protocol_error")
        ) input.supervisor.failClosed();
        throw error;
      }
      if (!inspectedMediaMatches(inspected, media)) {
        input.supervisor.failClosed();
        throw new MatrixSidecarError("protocol_error");
      }
      const permittedBootIds = authorizedBootIds(pendingEvent);
      try {
        const objects: MatrixIngressMediaObject[] = [];
        try {
          for (const item of media) {
            objects.push(await readVerifiedMediaObject({
              fileSystem: mediaFileSystem,
              config,
              authorizedBootIds: permittedBootIds,
              media: item
            }));
          }
          return Object.freeze(objects);
        } catch (error) {
          for (const object of objects) object.bytes.fill(0);
          throw error;
        }
      } catch {
        input.supervisor.failClosed();
        throw new MatrixSidecarError("protocol_error");
      }
    },
    async send(sendInput: MatrixSendInput): Promise<MatrixAcceptanceReceipt> {
      if (
        publicReadiness().matrixReadiness !== "ready"
      ) throw new MatrixSidecarError("not_ready");
      if (
        !isRecord(sendInput)
        || !SAFE_PROTOCOL_ID.test(sendInput.transactionId)
        || !nonEmptyText(sendInput.body, MAX_PLAINTEXT_BYTES)
        || (sendInput.formattedBody !== undefined && !nonEmptyText(sendInput.formattedBody, MAX_FORMATTED_BYTES))
        || (sendInput.relationEventId !== undefined && !validMatrixEventId(sendInput.relationEventId))
        || !validRoomPolicy(sendInput.roomPolicy, config, currentTime())
      ) throw new MatrixSidecarError("invalid_configuration");
      const result = await input.supervisor.request("send", Object.freeze({
        room_policy: Object.freeze({
          room_id: config.roomId,
          owner_mxid: config.ownerMxid,
          bot_mxid: config.botMxid,
          encrypted: true,
          invite_only: true,
          joined_members: Object.freeze([...sendInput.roomPolicy.joinedMembers]),
          pending_invites: 0,
          history_visibility_joined: true,
          public_alias: false,
          public_listing: false,
          guests_allowed: false,
          bridges_present: false,
          widgets_present: false,
          owner_devices_trusted: true,
          bot_device_trusted: true,
          devices_non_revoked: true,
          observed_at_ms: sendInput.roomPolicy.observedAtMs
        }),
        transaction_id: sendInput.transactionId,
        body: sendInput.body,
        formatted_body: sendInput.formattedBody ?? null,
        reply_to_event_id: sendInput.relationEventId ?? null,
        media: Object.freeze([])
      }));
      const receipt = parseAcceptance(result, sendInput.transactionId);
      if (receipt === undefined) {
        input.supervisor.failClosed();
        throw new MatrixSidecarError("protocol_error");
      }
      return receipt;
    }
  });
}
