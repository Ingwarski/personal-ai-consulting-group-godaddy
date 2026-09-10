import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { MATRIX_VERIFIER_HASH, validMatrixBrowserReport, type MatrixBrowserChallenge, type MatrixControlVisibility } from "./matrix-browser-isolation.ts";

const SIDECAR = "personal-consultant-matrix-sidecar";
const SETUP = "personal-consultant-matrix-setup";
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SDK_MEDIA_FILES = ["matrix-sdk-media.sqlite3", "matrix-sdk-media.sqlite3-wal", "matrix-sdk-media.sqlite3-shm"] as const;

/** This pin must come from reviewed, committed release metadata, never a request or environment override. */
export type MatrixReleaseExpectation = Readonly<{
  manifestSha256: string;
  sourceCommit: string;
}>;

export type MatrixReleaseDiagnostic = Readonly<{ stage: string; target: string; mode: string; ownerMatches: boolean;
  file: boolean; directory: boolean; symlink: boolean; links: number }>;
export type MatrixReleaseOptions = Readonly<{ expectedOwnerUid?: number; observeUnsafePath?: (value: MatrixReleaseDiagnostic) => void }>;

export type MatrixReleaseInspection = Readonly<{
  sidecarPath: string;
  setupPath: string;
  sidecarSha256: string;
  setupSha256: string;
  storeDir: string;
  mediaSpoolDir: string;
  storeState: "empty" | "contains_state";
  // Marker metadata is a routing hint only; Rust validates its exact contents and recovery scenario.
  storeProvisioning: "empty" | "bound" | "incomplete";
  mediaSpoolState: "empty" | "contains_state";
  // Local filesystem checks are not proof that GoDaddy refuses public HTTP access.
  credentialReadiness: "requires_http_isolation";
}>;

export type MatrixReleaseResult =
  | Readonly<{ ok: true; value: MatrixReleaseInspection }>
  | Readonly<{ ok: false; code: MatrixReleaseErrorCode }>;

/** Validated executables only. Database/account readiness belongs to the Rust
 * runtime, not an inferred filesystem marker or a successful installation. */
export type MySqlMatrixReleaseInspection = Readonly<{
  storeBackend: "mysql";
  sidecarPath: string;
  setupPath: string;
  sidecarSha256: string;
  setupSha256: string;
}>;
export type MySqlMatrixReleaseResult =
  | Readonly<{ ok: true; value: MySqlMatrixReleaseInspection }>
  | Readonly<{ ok: false; code: MatrixReleaseErrorCode }>;

type MatrixReleaseErrorCode =
  | "matrix_release_invalid"
  | "matrix_release_unavailable"
  | "matrix_release_unsafe_path"
  | "matrix_release_checksum_mismatch"
  | "matrix_release_unrecognized_state"
  | "matrix_release_conflict";

class ReleaseFailure extends Error {
  readonly code: MatrixReleaseErrorCode;
  readonly diagnostic?: Omit<MatrixReleaseDiagnostic, "stage">;
  constructor(code: MatrixReleaseErrorCode, diagnostic?: Omit<MatrixReleaseDiagnostic, "stage">) {
    super(code); this.code = code;
    if (diagnostic !== undefined) this.diagnostic = diagnostic;
  }
}

// Fixed labels only: never expose arbitrary on-disk names, paths or contents.
function unsafePath(path: string, stat: Stats, uid: number): ReleaseFailure {
  const labels = ["runtime", "matrix", "runtime-release", "public", "assets", ".personal-consultant-matrix-v1",
    "crypto-store", "media-spool", "device-binding.json", "provisioning-intent.json", "sidecar.lock", ...SDK_MEDIA_FILES,
    "matrix-sdk-state.sqlite3", "matrix-sdk-state.sqlite3-wal", "matrix-sdk-state.sqlite3-shm",
    "matrix-sdk-crypto.sqlite3", "matrix-sdk-crypto.sqlite3-wal", "matrix-sdk-crypto.sqlite3-shm",
    "matrix-sdk-event-cache.sqlite3", "matrix-sdk-event-cache.sqlite3-wal", "matrix-sdk-event-cache.sqlite3-shm"];
  return new ReleaseFailure("matrix_release_unsafe_path", { target: labels.find(label => path.endsWith("/" + label)) ?? "other",
    mode: (stat.mode & 0o7777).toString(8), ownerMatches: stat.uid === uid, file: stat.isFile(),
    directory: stat.isDirectory(), symlink: stat.isSymbolicLink(), links: stat.nlink });
}

type BinaryEntry = Readonly<{ sha256: string; size: number }>;
type VerifiedRelease = Readonly<{ sidecar: BinaryEntry; setup: BinaryEntry }>;
type Layout = Readonly<{
  applicationRoot: string;
  bundleDir: string;
  runtimeRoot: string;
  runtimeDir: string;
  persistentRoot: string;
  storeDir: string;
  mediaSpoolDir: string;
}>;

function layout(applicationRoot: string): Layout {
  if (!isAbsolute(applicationRoot) || resolve(applicationRoot) !== applicationRoot || applicationRoot === "/") {
    throw new ReleaseFailure("matrix_release_invalid");
  }
  const persistentRoot = join(applicationRoot, "public", "assets", ".personal-consultant-matrix-v1");
  return {
    applicationRoot,
    bundleDir: join(applicationRoot, "runtime-release", "matrix"),
    runtimeRoot: join(applicationRoot, "runtime"),
    runtimeDir: join(applicationRoot, "runtime", "matrix"),
    persistentRoot,
    storeDir: join(persistentRoot, "crypto-store"),
    mediaSpoolDir: join(persistentRoot, "media-spool")
  };
}

function currentUid(options: MatrixReleaseOptions): number {
  const uid = options.expectedOwnerUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  if (!Number.isSafeInteger(uid) || uid < 0) throw new ReleaseFailure("matrix_release_invalid");
  return uid;
}

function identity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
}

function sameFile(left: Stats, right: Stats): boolean {
  return identity(left, right) && left.size === right.size && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function directory(path: string, uid: number, privateMode: boolean): Promise<Stats> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7000) !== 0
    || (stat.mode & 0o022) !== 0 || (privateMode && (stat.mode & 0o777) !== 0o700)
    || await realpath(path) !== path) throw unsafePath(path, stat, uid);
  return stat;
}

async function missing(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function dedicatedDirectory(path: string, uid: number, create: boolean): Promise<void> {
  const parent = await directory(dirname(path), uid, false);
  if (await missing(path)) {
    if (!create) throw new ReleaseFailure("matrix_release_unavailable");
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  // Existing permissions are never "repaired" by broad chmod/chown.
  await directory(path, uid, true);
  if (!identity(parent, await directory(dirname(path), uid, false))) {
    throw new ReleaseFailure("matrix_release_unsafe_path");
  }
}

async function boundedFile(path: string, uid: number, limit: number, installed: boolean): Promise<Buffer> {
  const before = await lstat(path);
  const acceptableMode = installed
    ? [0o500, 0o700].includes(before.mode & 0o777)
    : (before.mode & 0o022) === 0;
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || before.nlink !== 1
    || !acceptableMode || (before.mode & 0o7000) !== 0 || before.size < 1 || before.size > limit
    || await realpath(path) !== path) throw new ReleaseFailure("matrix_release_unsafe_path");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw new ReleaseFailure("matrix_release_unsafe_path");
    const bytes = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size || !sameFile(opened, await handle.stat()) || !sameFile(opened, await lstat(path))) {
      throw new ReleaseFailure("matrix_release_unsafe_path");
    }
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ReleaseFailure("matrix_release_invalid");
  return value as Record<string, unknown>;
}

function binaryEntry(value: unknown): BinaryEntry {
  const entry = record(value);
  if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)
    || typeof entry.sizeBytes !== "number" || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1 || entry.sizeBytes > MAX_BINARY_BYTES) {
    throw new ReleaseFailure("matrix_release_invalid");
  }
  return { sha256: entry.sha256, size: entry.sizeBytes };
}

async function release(layout: Layout, expected: MatrixReleaseExpectation, uid: number): Promise<VerifiedRelease> {
  if (!SHA256.test(expected.manifestSha256) || !COMMIT.test(expected.sourceCommit)) {
    throw new ReleaseFailure("matrix_release_invalid");
  }
  await directory(layout.applicationRoot, uid, false);
  await directory(dirname(layout.bundleDir), uid, false);
  await directory(layout.bundleDir, uid, false);
  const bytes = await boundedFile(join(layout.bundleDir, "release-manifest.json"), uid, MAX_MANIFEST_BYTES, false);
  if (digest(bytes) !== expected.manifestSha256) throw new ReleaseFailure("matrix_release_checksum_mismatch");
  let manifest: Record<string, unknown>;
  try { manifest = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch { throw new ReleaseFailure("matrix_release_invalid"); }
  const builder = record(manifest.builder);
  if (manifest.schemaVersion !== 1 || manifest.kind !== "matrix-production-release"
    || manifest.protocolVersion !== 1 || manifest.sidecarVersion !== "0.1.0" || manifest.sourceCommit !== expected.sourceCommit
    || typeof builder.image !== "string" || !/@sha256:[a-f0-9]{64}$/u.test(builder.image)
    || typeof builder.imageConfigDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(builder.imageConfigDigest)
    || builder.platform !== "linux/amd64" || builder.target !== "x86_64-unknown-linux-musl"
    || builder.rustToolchain !== "1.93.0-x86_64-unknown-linux-musl"
    || !Array.isArray(manifest.artifacts) || manifest.artifacts.length < 3 || manifest.artifacts.length > 64) {
    throw new ReleaseFailure("matrix_release_invalid");
  }
  const names = new Set<string>();
  let sidecar: BinaryEntry | undefined;
  let setup: BinaryEntry | undefined;
  let evidenceCount = 0;
  for (const value of manifest.artifacts) {
    const artifact = record(value);
    if (typeof artifact.path !== "string" || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(artifact.path)
      || artifact.path.split("/").some((part) => part === "." || part === "..") || names.has(artifact.path)) {
      throw new ReleaseFailure("matrix_release_invalid");
    }
    names.add(artifact.path);
    const entry = binaryEntry(artifact);
    if (artifact.role === "sidecar" && artifact.path === SIDECAR && sidecar === undefined) sidecar = entry;
    else if (artifact.role === "setup" && artifact.path === SETUP && setup === undefined) setup = entry;
    else if (artifact.role === "evidence" && artifact.path !== SIDECAR && artifact.path !== SETUP) {
      evidenceCount += 1;
      // Retain complete source-bound release evidence, not just a relabelled executable.
      await verifiedBinary(join(layout.bundleDir, artifact.path), entry, uid, false);
    } else throw new ReleaseFailure("matrix_release_invalid");
  }
  if (sidecar === undefined || setup === undefined || evidenceCount === 0) throw new ReleaseFailure("matrix_release_invalid");
  return { sidecar, setup };
}

async function verifiedBinary(path: string, entry: BinaryEntry, uid: number, installed: boolean): Promise<Buffer> {
  const bytes = await boundedFile(path, uid, MAX_BINARY_BYTES, installed);
  if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) {
    throw new ReleaseFailure("matrix_release_checksum_mismatch");
  }
  return bytes;
}

async function installBinary(path: string, bytes: Buffer, entry: BinaryEntry, uid: number, previousHash?: string): Promise<void> {
  let previous: Stats | undefined;
  if (!await missing(path)) {
    try { await verifiedBinary(path, entry, uid, true); }
    catch (error) {
      if (error instanceof ReleaseFailure && error.code === "matrix_release_checksum_mismatch") {
        if (previousHash === undefined || digest(await boundedFile(path, uid, MAX_BINARY_BYTES, true)) !== previousHash) {
          throw new ReleaseFailure("matrix_release_conflict");
        }
        previous = await lstat(path);
      } else {
        throw error;
      }
    }
    if (previous === undefined) return;
  }
  const parentPath = dirname(path);
  const parent = await directory(parentPath, uid, true);
  const temporary = join(parentPath, `.install-${Buffer.from(randomBytes(16)).toString("hex")}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o500);
    await handle.sync();
    const created = await handle.stat();
    if (!identity(parent, await directory(parentPath, uid, true)) || !sameFile(created, await lstat(temporary))) {
      throw new ReleaseFailure("matrix_release_unsafe_path");
    }
    // link is atomic and fails if a live/previous installation appeared. rename would overwrite it.
    try {
      if (previous !== undefined) {
        if (!sameFile(previous, await lstat(path))
          || digest(await boundedFile(path, uid, MAX_BINARY_BYTES, true)) !== previousHash) {
          throw new ReleaseFailure("matrix_release_conflict");
        }
        // Only an exact previously verified executable can be replaced. State is
        // elsewhere; rename is atomic and existing processes retain their inode.
        await rename(temporary, path);
      } else await link(temporary, path);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new ReleaseFailure("matrix_release_conflict");
    }
  } finally {
    const owned = await handle.stat().catch(() => undefined);
    await handle.close();
    // Remove only this operation's temporary inode; never remove an installed binary or state.
    const now = await lstat(temporary).catch(() => undefined);
    if (owned !== undefined && now !== undefined && identity(owned, now)) await unlink(temporary);
  }
  await verifiedBinary(path, entry, uid, true);
}

async function privateState(path: string, uid: number, repairableMedia = false): Promise<"empty" | "contains_state"> {
  const root = await directory(path, uid, true);
  const names = await readdir(path);
  const queue = names.map((name) => ({ path: join(path, name), depth: 0 }));
  let seen = 0;
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) break;
    if (++seen > 4096 || next.depth > 32) throw new ReleaseFailure("matrix_release_unsafe_path");
    const stat = await lstat(next.path);
    if (stat.uid !== uid || stat.isSymbolicLink() || (stat.mode & 0o7000) !== 0 || await realpath(next.path) !== next.path) {
      throw unsafePath(next.path, stat, uid);
    }
    if (stat.isDirectory()) {
      await directory(next.path, uid, true);
      queue.push(...(await readdir(next.path)).map((name) => ({ path: join(next.path, name), depth: next.depth + 1 })));
    } else if (!stat.isFile() || stat.nlink !== 1 || ((stat.mode & 0o777) !== 0o600
      && !(repairableMedia && SDK_MEDIA_FILES.some(name => next.path === join(path, name)) && (stat.mode & 0o777) === 0o644))) {
      throw unsafePath(next.path, stat, uid);
    }
  }
  if (!identity(root, await directory(path, uid, true))) throw new ReleaseFailure("matrix_release_unsafe_path");
  return names.length === 0 ? "empty" : "contains_state";
}

async function privateMarker(path: string, uid: number): Promise<Stats | undefined> {
  if (await missing(path)) return undefined;
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || stat.nlink !== 1
    || (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > 4096 || await realpath(path) !== path) {
    throw new ReleaseFailure("matrix_release_unsafe_path");
  }
  return stat;
}

async function provisioningState(path: string, uid: number, state: "empty" | "contains_state"): Promise<MatrixReleaseInspection["storeProvisioning"]> {
  if (state === "empty") return "empty";
  if (await privateMarker(join(path, "device-binding.json"), uid) !== undefined) return "bound";
  if (await privateMarker(join(path, "provisioning-intent.json"), uid) !== undefined) return "incomplete";
  throw new ReleaseFailure("matrix_release_unrecognized_state");
}

async function run(applicationRoot: string, expected: MatrixReleaseExpectation, options: MatrixReleaseOptions, prepare: boolean): Promise<MatrixReleaseResult> {
  let stage = "release";
  try {
    const paths = layout(applicationRoot);
    const uid = currentUid(options);
    const metadata = await release(paths, expected, uid);
    // Validate public ancestors without modifying them or their permissions.
    stage = "public_ancestors";
    await directory(join(applicationRoot, "public"), uid, false);
    await directory(join(applicationRoot, "public", "assets"), uid, false);
    const sourceSidecar = prepare ? await verifiedBinary(join(paths.bundleDir, SIDECAR), metadata.sidecar, uid, false) : undefined;
    const sourceSetup = prepare ? await verifiedBinary(join(paths.bundleDir, SETUP), metadata.setup, uid, false) : undefined;
    stage = "private_directories";
    for (const path of [paths.runtimeRoot, paths.runtimeDir, paths.persistentRoot, paths.storeDir, paths.mediaSpoolDir]) {
      await dedicatedDirectory(path, uid, prepare);
    }
    stage = "store";
    const storeState = await privateState(paths.storeDir, uid);
    const storeProvisioning = await provisioningState(paths.storeDir, uid, storeState);
    stage = "spool";
    const mediaSpoolState = await privateState(paths.mediaSpoolDir, uid);
    stage = "installed_binaries";
    const sidecarPath = join(paths.runtimeDir, SIDECAR);
    const setupPath = join(paths.runtimeDir, SETUP);
    if (prepare && sourceSidecar !== undefined && sourceSetup !== undefined) {
      await installBinary(sidecarPath, sourceSidecar, metadata.sidecar, uid);
      await installBinary(setupPath, sourceSetup, metadata.setup, uid);
    } else {
      await verifiedBinary(sidecarPath, metadata.sidecar, uid, true);
      await verifiedBinary(setupPath, metadata.setup, uid, true);
    }
    return { ok: true, value: {
      sidecarPath, setupPath, sidecarSha256: metadata.sidecar.sha256, setupSha256: metadata.setup.sha256,
      storeDir: paths.storeDir, mediaSpoolDir: paths.mediaSpoolDir, storeState, storeProvisioning, mediaSpoolState,
      credentialReadiness: "requires_http_isolation"
    } };
  } catch (error) {
    if (error instanceof ReleaseFailure && error.diagnostic !== undefined) options.observeUnsafePath?.({ stage, ...error.diagnostic });
    return { ok: false, code: error instanceof ReleaseFailure ? error.code : "matrix_release_unavailable" };
  }
}

/** Explicit, credential-free owner action only. Does not execute, download, provision, replace binaries or modify existing state. */
export async function prepareMatrixRelease(applicationRoot: string, expected: MatrixReleaseExpectation, options: MatrixReleaseOptions = {}): Promise<MatrixReleaseResult> {
  return run(applicationRoot, expected, options, true);
}

/** Read-only validation immediately before a separately authorized provisioning/spawn operation. */
export async function inspectMatrixRelease(applicationRoot: string, expected: MatrixReleaseExpectation, options: MatrixReleaseOptions = {}): Promise<MatrixReleaseResult> {
  return run(applicationRoot, expected, options, false);
}

async function runMySqlRelease(applicationRoot: string, expected: MatrixReleaseExpectation, options: MatrixReleaseOptions,
  prepare: boolean): Promise<MySqlMatrixReleaseResult> {
  let stage = "release";
  try {
    const paths = layout(applicationRoot);
    const uid = currentUid(options);
    const metadata = await release(paths, expected, uid);
    const sourceSidecar = prepare ? await verifiedBinary(join(paths.bundleDir, SIDECAR), metadata.sidecar, uid, false) : undefined;
    const sourceSetup = prepare ? await verifiedBinary(join(paths.bundleDir, SETUP), metadata.setup, uid, false) : undefined;
    stage = "private_directories";
    // Deliberately no inspection, creation, permission repair or probing of
    // public/assets or legacy persistent data. This does not certify their removal.
    for (const path of [paths.runtimeRoot, paths.runtimeDir]) await dedicatedDirectory(path, uid, prepare);
    stage = "installed_binaries";
    const sidecarPath = join(paths.runtimeDir, SIDECAR);
    const setupPath = join(paths.runtimeDir, SETUP);
    if (prepare && sourceSidecar !== undefined && sourceSetup !== undefined) {
      await installBinary(sidecarPath, sourceSidecar, metadata.sidecar, uid,
        "ce148392a57f4bd391437b8eedc963bf1fd0f252b4f599cdd6dd2e45369d6984");
      await installBinary(setupPath, sourceSetup, metadata.setup, uid,
        "59be65ea5668d365834be5174997c68e9bd14f35a1f6850b454be35ddb3e511f");
    } else {
      await verifiedBinary(sidecarPath, metadata.sidecar, uid, true);
      await verifiedBinary(setupPath, metadata.setup, uid, true);
    }
    return { ok: true, value: { storeBackend: "mysql", sidecarPath, setupPath,
      sidecarSha256: metadata.sidecar.sha256, setupSha256: metadata.setup.sha256 } };
  } catch (error) {
    if (error instanceof ReleaseFailure && error.diagnostic !== undefined) options.observeUnsafePath?.({ stage, ...error.diagnostic });
    return { ok: false, code: error instanceof ReleaseFailure ? error.code : "matrix_release_unavailable" };
  }
}

/** Install the immutable native release without touching legacy persistent directories. */
export async function prepareMySqlMatrixRelease(applicationRoot: string, expected: MatrixReleaseExpectation,
  options: MatrixReleaseOptions = {}): Promise<MySqlMatrixReleaseResult> {
  return runMySqlRelease(applicationRoot, expected, options, true);
}

/** Read-only executable validation; the child separately validates active MySQL state and its account. */
export async function inspectMySqlMatrixRelease(applicationRoot: string, expected: MatrixReleaseExpectation,
  options: MatrixReleaseOptions = {}): Promise<MySqlMatrixReleaseResult> {
  return runMySqlRelease(applicationRoot, expected, options, false);
}

/** Explicit owner repair only. Tighten the pinned SDK's three media-cache files
 * from 0644 to 0600; do not read bytes, follow links, create files, or touch other modes. */
export async function restrictMatrixMediaPermissions(applicationRoot: string, expected: MatrixReleaseExpectation): Promise<MatrixReleaseResult> {
  try {
    const paths = layout(applicationRoot); const uid = currentUid({});
    const metadata = await release(paths, expected, uid);
    await directory(join(applicationRoot, "public"), uid, false);
    await directory(join(applicationRoot, "public", "assets"), uid, false);
    for (const path of [paths.runtimeRoot, paths.runtimeDir, paths.persistentRoot, paths.storeDir, paths.mediaSpoolDir]) {
      await directory(path, uid, true);
    }
    await verifiedBinary(join(paths.runtimeDir, SIDECAR), metadata.sidecar, uid, true);
    await verifiedBinary(join(paths.runtimeDir, SETUP), metadata.setup, uid, true);
    if (await privateMarker(join(paths.storeDir, "device-binding.json"), uid) === undefined) {
      throw new ReleaseFailure("matrix_release_unrecognized_state");
    }
    await privateState(paths.storeDir, uid, true);
    await privateState(paths.mediaSpoolDir, uid);
    for (const name of SDK_MEDIA_FILES) {
      const path = join(paths.storeDir, name);
      if (await missing(path)) continue;
      const parent = await directory(paths.storeDir, uid, true);
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || before.nlink !== 1
        || ![0o600, 0o644].includes(before.mode & 0o7777) || await realpath(path) !== path) throw unsafePath(path, before, uid);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!sameFile(before, await handle.stat()) || !sameFile(before, await lstat(path))
          || !identity(parent, await directory(paths.storeDir, uid, true))) throw new ReleaseFailure("matrix_release_unsafe_path");
        if ((before.mode & 0o777) === 0o644) await handle.chmod(0o600);
        const after = await handle.stat();
        if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== uid || after.nlink !== 1
          || (after.mode & 0o7777) !== 0o600 || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || !sameFile(after, await lstat(path)) || !identity(parent, await directory(paths.storeDir, uid, true))) {
          throw new ReleaseFailure("matrix_release_unsafe_path");
        }
      } finally { await handle.close(); }
    }
    return inspectMatrixRelease(applicationRoot, expected);
  } catch (error) {
    return { ok: false, code: error instanceof ReleaseFailure ? error.code : "matrix_release_unavailable" };
  }
}

export type MatrixHttpIsolationResult =
  | Readonly<{ ok: true; checkedPaths: 12; credentialReadiness: "http_isolation_verified";
    evidenceKind?: "browser_assisted_http_isolation"; controlVisibility?: MatrixControlVisibility }>
  | Readonly<{ ok: false; code: MatrixReleaseErrorCode | "isolation_probe_requires_empty_state" | "isolation_probe_requires_binding" | "matrix_http_isolation_failed" | "matrix_http_isolation_cleanup_failed" }>;

type Canary = Readonly<{ path: string; name: string; bytes: Buffer; stat: Stats; handle: FileHandle }>;

/** Content-free owner diagnostics. Never include URLs, filenames, bodies or exception messages. */
export type MatrixIsolationDiagnostics = Readonly<{
  stage: "private_canaries" | "anonymous_http" | "public_control" | "browser_proof" | "published_recheck" | "file_identity";
  probes: readonly Readonly<{ environment: "published" | "preview";
    target: "store_assets" | "spool_assets" | "store_public_assets" | "spool_public_assets" | "sidecar" | "setup";
    status: number | null; denied: boolean }>[];
}>;
const PROBE_TARGETS = ["store_assets", "spool_assets", "store_public_assets", "spool_public_assets", "sidecar", "setup"] as const;

const HTTP_ORIGINS = Object.freeze([
  "https://wy2v0putg6.c35.airoapp.ai",
  "https://wy2v0putg6.preview.c35.airoapp.ai"
]);

async function publishedControlResponse(challenge: MatrixBrowserChallenge, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(HTTP_ORIGINS[0] + challenge.positivePath, {
      method: "GET", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(5_000), headers: { Accept: "text/plain", "Cache-Control": "no-cache" }
    });
    const reader = response.body?.getReader();
    if (reader === undefined) return false;
    try {
      if (response.status !== 200 || response.redirected || response.headers.get("x-matrix-control-result") !== "ok") return false;
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength; if (length > 128) return false;
        chunks.push(next.value);
      }
      return Buffer.concat(chunks).equals(Buffer.from(challenge.positiveBody, "ascii"));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch { return false; }
}

async function deniedHttpResponse(url: string, canaries: readonly Canary[], fetchImpl: typeof fetch, statuses?: Map<string, number>): Promise<boolean> {
  let response: Response | undefined;
  try {
    response = await fetchImpl(url, {
      method: "GET", credentials: "omit", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(5_000), headers: { Accept: "application/octet-stream", "Cache-Control": "no-cache" }
    });
    statuses?.set(url, response.status);
    // A redirect, timeout, login page or generic 200 is not private-path evidence.
    if (response.status !== 403 && response.status !== 404) {
      await response.body?.cancel();
      return false;
    }
    const reader = response.body?.getReader();
    if (reader === undefined) return true;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 64 * 1024) return false;
        chunks.push(next.value);
      }
      const bytes = Buffer.concat(chunks);
      return !bytes.includes(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
        && !bytes.includes(Buffer.from('"device_id"', "ascii"))
        && !bytes.includes(Buffer.from('"store_fingerprint"', "ascii"))
        && !bytes.includes(Buffer.from('"bot_mxid"', "ascii"))
        && canaries.every((canary) => !bytes.includes(canary.bytes));
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  } catch { return false; }
}

/**
 * Explicit credential-free proof for initial setup or an existing-store resume.
 * Existing crypto is probed through its private device binding or incomplete
 * provisioning-intent filename (the latter is only a native recovery hint):
 * its contents are never read locally or modified, and no unknown file is added.
 * The media spool must be empty for a temporary harmless canary. No redirects.
 * This is not a retained readiness certificate: call immediately before fresh
 * provisioning and repeat after a changed deployment/path-serving configuration.
 */
export async function verifyMatrixHttpIsolation(
  applicationRoot: string,
  expected: MatrixReleaseExpectation,
  fetchImpl: typeof fetch = fetch,
  options: MatrixReleaseOptions = {},
  browserCheck?: (challenge: MatrixBrowserChallenge) => Promise<unknown>,
  observe?: (diagnostics: MatrixIsolationDiagnostics) => void
): Promise<MatrixHttpIsolationResult> {
  const inspection = await inspectMatrixRelease(applicationRoot, expected, options);
  if (!inspection.ok) return inspection;
  if (inspection.value.mediaSpoolState !== "empty") {
    return { ok: false, code: "isolation_probe_requires_empty_state" };
  }
  const canaries: Canary[] = [];
  const probeNames: string[] = [];
  const snapshots = new Map<string, Stats>();
  let existingMarker: Readonly<{ path: string; name: string; stat: Stats; parent: Stats }> | undefined;
  if (inspection.value.storeState === "contains_state") {
    try {
      const uid = currentUid(options);
      const name = inspection.value.storeProvisioning === "bound" ? "device-binding.json" : "provisioning-intent.json";
      const path = join(inspection.value.storeDir, name);
      const stat = await privateMarker(path, uid);
      if (stat === undefined) {
        return { ok: false, code: "isolation_probe_requires_binding" };
      }
      existingMarker = { path, name, stat, parent: await directory(inspection.value.storeDir, uid, true) };
    } catch { return { ok: false, code: "isolation_probe_requires_binding" }; }
  }
  let result: MatrixHttpIsolationResult = { ok: false, code: "matrix_http_isolation_failed" };
  let probes: MatrixIsolationDiagnostics["probes"] = [];
  const stage = (value: MatrixIsolationDiagnostics["stage"]): void => { observe?.({ stage: value, probes }); };
  try {
    stage("private_canaries");
    const uid = currentUid(options);
    for (const path of [inspection.value.storeDir, inspection.value.mediaSpoolDir]) {
      if (path === inspection.value.storeDir && existingMarker !== undefined) {
        probeNames.push(existingMarker.name);
        continue;
      }
      const parent = await directory(path, uid, true);
      if ((await readdir(path)).length !== 0) throw new ReleaseFailure("matrix_release_conflict");
      // A normal filename tests the private directory, not just a blanket
      // dotfile rule that might still expose ordinary SQLite/media filenames.
      const name = `private-path-check-${Buffer.from(randomBytes(16)).toString("hex")}`;
      const bytes = Buffer.from(`matrix-private-path-canary:${Buffer.from(randomBytes(16)).toString("hex")}`, "ascii");
      const target = join(path, name);
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      // Register ownership before any write can fail, so even partial canaries are removed.
      const canary: Canary = { path: target, name, bytes, stat: await handle.stat(), handle };
      canaries.push(canary);
      probeNames.push(name);
      await handle.writeFile(bytes);
      await handle.sync();
      snapshots.set(target, await handle.stat());
      if (!identity(parent, await directory(path, uid, true))) throw new ReleaseFailure("matrix_release_unsafe_path");
    }
    const urls = HTTP_ORIGINS.flatMap((origin) => [
      ...["/assets", "/public/assets"].flatMap((prefix) => probeNames.map((name, index) =>
        `${origin}${prefix}/.personal-consultant-matrix-v1/${index === 0 ? "crypto-store" : "media-spool"}/${name}`)),
      `${origin}/runtime/matrix/${SIDECAR}`,
      `${origin}/runtime/matrix/${SETUP}`
    ]);
    const statuses = new Map<string, number>();
    stage("anonymous_http");
    const checks = await Promise.all(urls.map((url) => deniedHttpResponse(url, canaries, fetchImpl, statuses)));
    probes = checks.map((denied, index) => ({ environment: index < 6 ? "published" : "preview",
      target: PROBE_TARGETS[index % 6]!, status: statuses.get(urls[index]!) ?? null, denied }));
    stage("anonymous_http");
    let browserPassed = false;
    let controlVisibility: MatrixControlVisibility | undefined;
    // Never use browser evidence to override a leak, a Published failure, a
    // redirect or an upstream error. Only the Preview 401 login boundary qualifies.
    if (browserCheck !== undefined && checks.slice(0, 6).every(Boolean) && !checks.slice(6).every(Boolean)
      && checks.slice(6).every((denied, index) => denied || statuses.get(urls[index + 6]!) === 401)) {
      stage("public_control");
      const privateCanaries = canaries.map(canary => new TextDecoder().decode(canary.bytes));
      const name = `matrix-isolation-positive-${Buffer.from(randomBytes(16)).toString("hex")}.txt`;
      const parentPath = join(applicationRoot, "public", "assets");
      const parent = await directory(parentPath, uid, false);
      const path = join(parentPath, name);
      const bytes = Buffer.from(`matrix-isolation-positive:${Buffer.from(randomBytes(16)).toString("hex")}`, "ascii");
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      canaries.push({ path, name, bytes, stat: await handle.stat(), handle });
      await handle.writeFile(bytes); await handle.sync();
      snapshots.set(path, await handle.stat());
      if (!identity(parent, await directory(parentPath, uid, false))) throw new ReleaseFailure("matrix_release_unsafe_path");
      const challenge: MatrixBrowserChallenge = Object.freeze({ nonce: Buffer.from(randomBytes(16)).toString("hex"),
        expiresAt: Date.now() + 180_000, verifierHash: MATRIX_VERIFIER_HASH,
        paths: urls.slice(6).map(url => new URL(url).pathname), canaries: privateCanaries,
        positivePath: `/assets/${name}`, positiveBody: bytes.toString("ascii") });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!await publishedControlResponse(challenge, fetchImpl)) throw new Error("public_control_failed");
        stage("browser_proof");
        const report = await Promise.race([browserCheck(challenge), new Promise(resolve => {
          timer = setTimeout(() => resolve(undefined), 180_000); timer.unref();
        })]);
        if (Date.now() < challenge.expiresAt && validMatrixBrowserReport(report, challenge)) {
          browserPassed = true; controlVisibility = report.controlVisibility as MatrixControlVisibility;
        }
        for (const canary of canaries) {
          if (!sameFile(snapshots.get(canary.path)!, await lstat(canary.path))
            || !sameFile(snapshots.get(canary.path)!, await canary.handle.stat())) browserPassed = false;
        }
        // Recheck the machine-observed half while the exact files still exist.
        if (browserPassed) {
          stage("published_recheck");
          const repeatStatuses = new Map<string, number>();
          const repeat = await Promise.all(urls.slice(0, 6)
            .map(url => deniedHttpResponse(url, canaries, fetchImpl, repeatStatuses)));
          probes = [...repeat.map((denied, index) => ({ environment: "published" as const,
            target: PROBE_TARGETS[index]!, status: repeatStatuses.get(urls[index]!) ?? null, denied })), ...probes.slice(6)];
          stage("published_recheck");
          browserPassed = repeat.every(Boolean) && await publishedControlResponse(challenge, fetchImpl)
            && Date.now() < challenge.expiresAt;
          for (const canary of canaries) {
            if (!sameFile(snapshots.get(canary.path)!, await lstat(canary.path))
              || !sameFile(snapshots.get(canary.path)!, await canary.handle.stat())) browserPassed = false;
          }
        }
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    if (existingMarker !== undefined) stage("file_identity");
    if (existingMarker !== undefined && (!sameFile(existingMarker.stat, await lstat(existingMarker.path))
      || !identity(existingMarker.parent, await directory(inspection.value.storeDir, uid, true)))) {
      throw new ReleaseFailure("matrix_release_unsafe_path");
    }
    if (checks.length === 12 && (checks.every(Boolean) || browserPassed)) {
      result = { ok: true, checkedPaths: 12, credentialReadiness: "http_isolation_verified",
        ...(browserPassed && controlVisibility !== undefined
          ? { evidenceKind: "browser_assisted_http_isolation" as const, controlVisibility } : {}) };
    }
  } catch { /* Report only the safe failure code; never response bodies or local paths. */ }
  finally {
    for (const canary of canaries) {
      try {
        const actual = await lstat(canary.path);
        if (!identity(canary.stat, actual)) throw new ReleaseFailure("matrix_release_unsafe_path");
        await unlink(canary.path);
      } catch { result = { ok: false, code: "matrix_http_isolation_cleanup_failed" }; }
      finally { await canary.handle.close().catch(() => { result = { ok: false, code: "matrix_http_isolation_cleanup_failed" }; }); }
    }
  }
  if (result.ok) {
    const current = await inspectMatrixRelease(applicationRoot, expected, options);
    if (!current.ok) return current;
  }
  return result;
}
