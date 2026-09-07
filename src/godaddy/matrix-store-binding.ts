import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BINDING_FILE = "device-binding.json";
const MAX_BINDING_BYTES = 4 * 1024;
const STORE_FINGERPRINT = /^[a-f0-9]{64}$/u;
const DEVICE_ID = /^[\x21-\x7e]{1,255}$/u;

export type MatrixStoreBinding = Readonly<{
  deviceId: string;
  storeFingerprint: string;
}>;

export type MatrixStoreBindingResult =
  | Readonly<{ ok: true; value: MatrixStoreBinding }>
  | Readonly<{ ok: false; code: "store_binding_unavailable" | "store_binding_invalid"
    | "store_binding_missing" | "store_binding_access_denied" | "store_binding_transient" }>;

/** Only known temporary OS failures may retry. Never treat missing identity as provisioning. */
export function classifyMatrixStoreReadError(error: unknown): Extract<MatrixStoreBindingResult, { ok: false }>["code"] {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return "store_binding_missing";
  if (code === "EACCES" || code === "EPERM") return "store_binding_access_denied";
  if (["EIO", "EAGAIN", "EBUSY", "EINTR", "EMFILE", "ENFILE", "ESTALE", "ETIMEDOUT"].includes(String(code))) {
    return "store_binding_transient";
  }
  return "store_binding_unavailable";
}

export type MatrixBindingStat = Readonly<{
  mode: number;
  uid: number;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}>;

export type MatrixBindingFileHandle = Readonly<{
  stat: () => Promise<MatrixBindingStat>;
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ) => Promise<Readonly<{ bytesRead: number }>>;
  close: () => Promise<void>;
}>;

export type MatrixBindingFileSystem = Readonly<{
  lstat: (path: string) => Promise<MatrixBindingStat>;
  realpath: (path: string) => Promise<string>;
  openNoFollow: (path: string) => Promise<MatrixBindingFileHandle>;
}>;

const nativeFileSystem: MatrixBindingFileSystem = Object.freeze({
  lstat: async (path) => lstat(path) as unknown as MatrixBindingStat,
  realpath,
  openNoFollow: async (path) => open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  ) as unknown as MatrixBindingFileHandle
});

function sameObject(left: MatrixBindingStat, right: MatrixBindingStat): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function privateDirectory(stat: MatrixBindingStat, expectedUid: number): boolean {
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && stat.uid === expectedUid
    && (stat.mode & 0o777) === 0o700
    && (stat.mode & 0o7000) === 0;
}

function privateBindingFile(stat: MatrixBindingStat, expectedUid: number): boolean {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.uid === expectedUid
    && stat.size > 0
    && stat.size <= MAX_BINDING_BYTES
    && (stat.mode & 0o777) === 0o600
    && (stat.mode & 0o7000) === 0;
}

function equalAscii(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "ascii");
  const rightBytes = Buffer.from(right, "ascii");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function parseBinding(bytes: Buffer, expectedDeviceId: string): MatrixStoreBinding | undefined {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2
    || !Object.hasOwn(record, "device_id")
    || !Object.hasOwn(record, "store_fingerprint")
    || typeof record.device_id !== "string"
    || !DEVICE_ID.test(record.device_id)
    || !DEVICE_ID.test(expectedDeviceId)
    || !equalAscii(record.device_id, expectedDeviceId)
    || typeof record.store_fingerprint !== "string"
    || !STORE_FINGERPRINT.test(record.store_fingerprint)
    // Rust creates this as compact canonical JSON. Requiring the same bytes
    // also rejects duplicate keys and ambiguous hand-edited representations.
    || JSON.stringify(record) !== text
  ) return undefined;
  return Object.freeze({
    deviceId: record.device_id,
    storeFingerprint: record.store_fingerprint
  });
}

/**
 * Loads the non-secret identity anchor for an existing Matrix crypto store.
 * Fresh provisioning is intentionally not performed by normal application
 * startup. The Rust process reopens and validates this same file after taking
 * its exclusive lifetime lock, and the ready handshake must match this value.
 */
export async function readExistingMatrixStoreBinding(input: Readonly<{
  storeDir: string;
  expectedDeviceId: string;
  expectedOwnerUid?: number;
  fileSystem?: MatrixBindingFileSystem;
}>): Promise<MatrixStoreBindingResult> {
  const expectedOwnerUid = input.expectedOwnerUid
    ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const storeDir = resolve(input.storeDir);
  const bindingPath = resolve(storeDir, BINDING_FILE);
  if (
    storeDir !== input.storeDir
    || dirname(bindingPath) !== storeDir
    || !Number.isSafeInteger(expectedOwnerUid)
    || expectedOwnerUid < 0
  ) return { ok: false, code: "store_binding_invalid" };

  const fileSystem = input.fileSystem ?? nativeFileSystem;
  let handle: MatrixBindingFileHandle | undefined;
  try {
    const directoryBefore = await fileSystem.lstat(storeDir);
    const fileBefore = await fileSystem.lstat(bindingPath);
    if (
      await fileSystem.realpath(storeDir) !== storeDir
      || !privateDirectory(directoryBefore, expectedOwnerUid)
      || !privateBindingFile(fileBefore, expectedOwnerUid)
    ) return { ok: false, code: "store_binding_invalid" };

    handle = await fileSystem.openNoFollow(bindingPath);
    const openedBefore = await handle.stat();
    if (
      !sameObject(fileBefore, openedBefore)
      || !privateBindingFile(openedBefore, expectedOwnerUid)
    ) return { ok: false, code: "store_binding_invalid" };

    const buffer = Buffer.alloc(MAX_BINDING_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const read = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead < 0 || read.bytesRead > buffer.byteLength - offset) {
        return { ok: false, code: "store_binding_invalid" };
      }
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const bytes = Buffer.from(buffer.subarray(0, offset));
    const openedAfter = await handle.stat();
    const fileAfter = await fileSystem.lstat(bindingPath);
    const directoryAfter = await fileSystem.lstat(storeDir);
    if (
      bytes.byteLength !== openedBefore.size
      || !sameObject(openedBefore, openedAfter)
      || !sameObject(openedBefore, fileAfter)
      || !sameObject(directoryBefore, directoryAfter)
      || !privateBindingFile(openedAfter, expectedOwnerUid)
      || !privateBindingFile(fileAfter, expectedOwnerUid)
      || !privateDirectory(directoryAfter, expectedOwnerUid)
    ) return { ok: false, code: "store_binding_invalid" };

    const binding = parseBinding(bytes, input.expectedDeviceId);
    return binding === undefined
      ? { ok: false, code: "store_binding_invalid" }
      : { ok: true, value: binding };
  } catch (error) {
    return { ok: false, code: classifyMatrixStoreReadError(error) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
