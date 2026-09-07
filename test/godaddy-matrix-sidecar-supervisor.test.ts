import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  MatrixSidecarError,
  MatrixSidecarSupervisor,
  MATRIX_SIDECAR_GENERATION_FRAME_BUDGET,
  type BinaryStat,
  type MatrixSidecarChildProcess,
  type MatrixSidecarClock,
  type MatrixSidecarDiagnostic,
  type MatrixSidecarFileSystem,
  type MatrixSidecarIdentityExpectation,
  type MatrixSidecarSpawn
} from "../src/godaddy/matrix-sidecar-supervisor.ts";

const binary = Buffer.from("test-only-rust-sidecar", "utf8");
const checksum = createHash("sha256").update(binary).digest("hex");
const ROOM_ID = "!private:matrix.org";
const OWNER_MXID = "@owner:matrix.org";
const BOT_MXID = "@consultant:matrix.org";
const BOT_DEVICE_ID = "BOTDEVICE1";
const SPOOL_PARENT = "/private/matrix-spool";
const APPLICATION_ROOT = "/srv/personal-consultant/app";
const BOOT_ID = "a".repeat(32);
const STORE_FINGERPRINT = "b".repeat(64);
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const expectedIdentity: MatrixSidecarIdentityExpectation = Object.freeze({
  build: "0.1.0",
  homeserverOrigin: "https://matrix.org",
  roomIdSha256: digest(ROOM_ID),
  ownerMxidSha256: digest(OWNER_MXID),
  botMxidSha256: digest(BOT_MXID),
  botDeviceIdSha256: digest(BOT_DEVICE_ID),
  storeFingerprint: STORE_FINGERPRINT
});

const spawnEnvironment = Object.freeze({
  PATH: "/usr/bin:/bin",
  MATRIX_HOMESERVER_URL: "https://matrix.org",
  MATRIX_ALLOWED_HTTPS_ORIGINS: "https://matrix.org",
  MATRIX_STORE_DIR: "/private/matrix-store",
  MATRIX_STORE_PASSPHRASE: "c".repeat(64),
  MATRIX_MEDIA_SPOOL_DIR: SPOOL_PARENT,
  MATRIX_ACCESS_TOKEN: "test-only-access-token",
  MATRIX_ROOM_ID: ROOM_ID,
  MATRIX_OWNER_MXID: OWNER_MXID,
  MATRIX_BOT_MXID: BOT_MXID,
  MATRIX_BOT_DEVICE_ID: BOT_DEVICE_ID
});

function readyIdentity(overrides: Partial<Readonly<Record<string, unknown>>> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    build: expectedIdentity.build,
    homeserver_origin: expectedIdentity.homeserverOrigin,
    room_id_sha256: expectedIdentity.roomIdSha256,
    owner_mxid_sha256: expectedIdentity.ownerMxidSha256,
    bot_mxid_sha256: expectedIdentity.botMxidSha256,
    bot_device_id_sha256: expectedIdentity.botDeviceIdSha256,
    store_fingerprint: expectedIdentity.storeFingerprint,
    spool_instance: BOOT_ID,
    ...overrides
  });
}

function readyFrame(identity = readyIdentity()): Readonly<Record<string, unknown>> {
  return {
    type: "ready",
    version: 1,
    id: `sidecar-ready-${BOOT_ID}`,
    readiness: "ready",
    identity
  };
}

function validEvent(id = "ingress-1"): Readonly<Record<string, unknown>> {
  return {
    type: "event",
    version: 1,
    id,
    event: {
      event_id: `$${id}:matrix.org`,
      room_id: ROOM_ID,
      sender_mxid: OWNER_MXID,
      sender_device_id: "OWNERDEVICE1",
      body: "hello",
      reply_to_event_id: null,
      media: []
    }
  };
}

function validRejection(
  id = "rejected-1",
  overrides: Partial<Readonly<Record<string, unknown>>> = {}
): Readonly<Record<string, unknown>> {
  return {
    type: "event_rejected",
    version: 1,
    id,
    rejection: {
      event_id: `$${id}:matrix.org`,
      room_id: ROOM_ID,
      sender_mxid: OWNER_MXID,
      sender_device_id: "OWNERDEVICE1",
      body_hash: "c".repeat(64),
      media_manifest_hash: "d".repeat(64),
      event_hash: "e".repeat(64),
      reason: "media_expired",
      ...overrides
    }
  };
}

class FakeReadable extends EventEmitter {
  pushFrame(frame: Readonly<Record<string, unknown>>): void {
    this.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`, "utf8"));
  }

  pushFrames(frames: readonly Readonly<Record<string, unknown>>[]): void {
    this.emit("data", Buffer.from(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n", "utf8"));
  }

  pushBytes(bytes: Buffer): void {
    this.emit("data", bytes);
  }
}

class FakeWritable extends EventEmitter {
  readonly writes: Record<string, unknown>[] = [];
  backpressured = false;
  writeError: Error | undefined;
  onWrite: ((frame: Record<string, unknown>) => void) | undefined;

  write(value: string, encoding: "utf8"): boolean {
    if (this.writeError !== undefined) throw this.writeError;
    assert.equal(encoding, "utf8");
    const frame = JSON.parse(value) as Record<string, unknown>;
    this.writes.push(frame);
    this.onWrite?.(frame);
    return !this.backpressured;
  }

  releaseBackpressure(): void {
    this.backpressured = false;
    this.emit("drain");
  }
}

class FakeChild extends EventEmitter implements MatrixSidecarChildProcess {
  readonly stdin = new FakeWritable();
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly kills: NodeJS.Signals[] = [];
  closeOnKill = true;

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.close(null, signal));
    return true;
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }
}

class ManualClock implements MatrixSidecarClock {
  nowValue = 0;
  nextId = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.nowValue;
  }

  setTimeout(callback: () => void, milliseconds: number): number {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.nowValue + milliseconds, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  advance(milliseconds: number): void {
    this.nowValue += milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.nowValue)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

function safeStat(overrides: Partial<BinaryStat> = {}): BinaryStat {
  return {
    mode: 0o100700,
    uid: 501,
    dev: 1,
    ino: 2,
    size: binary.byteLength,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...overrides
  };
}

function fileSystem(
  stats: BinaryStat | readonly BinaryStat[] = safeStat(),
  contents = binary
): MatrixSidecarFileSystem {
  const sequence = Array.isArray(stats) ? stats : [stats];
  let reads = 0;
  return {
    lstat: async () => sequence[Math.min(reads++, sequence.length - 1)] as BinaryStat,
    readFile: async () => contents
  };
}

type ProtocolOptions = Readonly<{
  build?: string;
  initializeError?: "not_ready" | "lock_contended" | "store_quarantined";
  emitReady?: boolean;
  identity?: Readonly<Record<string, unknown>>;
  eventAfterReady?: Readonly<Record<string, unknown>>;
  rejectionAfterReady?: Readonly<Record<string, unknown>>;
  respondAck?: boolean;
  respondShutdown?: boolean;
  closeAfterShutdown?: boolean;
}>;

function attachRustProtocol(child: FakeChild, options: ProtocolOptions = {}): void {
  child.stdin.onWrite = (frame) => {
    const id = frame.id;
    if (typeof id !== "string") return;
    if (frame.type === "hello") {
      queueMicrotask(() => child.stdout.pushFrame({
        type: "response", version: 1, id, ok: true, result: { name: "health" }, error: null
      }));
      return;
    }
    if (frame.type === "request") {
      const command = frame.command as Record<string, unknown>;
      if (command.name === "initialize") {
        queueMicrotask(() => {
          if (options.initializeError !== undefined) {
            child.stdout.pushFrame({
              type: "response", version: 1, id, ok: false, result: null, error: options.initializeError
            });
            return;
          }
          child.stdout.pushFrame({
            type: "response", version: 1, id, ok: true, result: { name: "initialized" }, error: null
          });
          if (options.emitReady !== false) {
            const ready = readyFrame(options.identity ?? readyIdentity());
            const firstIngress = options.eventAfterReady ?? options.rejectionAfterReady;
            if (firstIngress === undefined) child.stdout.pushFrame(ready);
            else child.stdout.pushFrames([ready, firstIngress]);
          }
        });
      } else if (command.name === "inspect_media") {
        queueMicrotask(() => child.stdout.pushFrame({
          type: "response", version: 1, id, ok: true,
          result: { name: "media", objects: [] }, error: null
        }));
      }
      return;
    }
    if (frame.type === "ack" && options.respondAck !== false) {
      queueMicrotask(() => child.stdout.pushFrame({
        type: "response", version: 1, id, ok: true, result: { name: "health" }, error: null
      }));
      return;
    }
    if (frame.type === "shutdown" && options.respondShutdown !== false) {
      queueMicrotask(() => {
        child.stdout.pushFrame({
          type: "response", version: 1, id, ok: true, result: { name: "shutdown_accepted" }, error: null
        });
        if (options.closeAfterShutdown !== false) child.close(0, null);
      });
    }
  };
  queueMicrotask(() => child.stdout.pushFrame({
    type: "hello", version: 1, id: "sidecar-hello", build: options.build ?? "0.1.0"
  }));
}

function fixture(overrides: Readonly<{
  fileSystem?: MatrixSidecarFileSystem;
  clock?: MatrixSidecarClock;
  childFactory?: () => FakeChild;
  protocol?: ProtocolOptions | ((childIndex: number) => ProtocolOptions) | false;
  diagnostics?: MatrixSidecarDiagnostic[];
  expectedIdentity?: MatrixSidecarIdentityExpectation;
  spawnEnvironment?: Readonly<Record<string, string>>;
  maxCrashes?: number;
  maxLockContentionRetries?: number;
  lockContentionBackoffMs?: readonly number[];
  maxOutstandingRequests?: number;
  maxUnackedEvents?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  terminateTimeoutMs?: number;
  argumentsList?: readonly string[];
  cwd?: string;
}> = {}): Readonly<{
  supervisor: MatrixSidecarSupervisor;
  children: FakeChild[];
  spawnCalls: Parameters<MatrixSidecarSpawn>[];
}> {
  const children: FakeChild[] = [];
  const spawnCalls: Parameters<MatrixSidecarSpawn>[] = [];
  const spawnSidecar: MatrixSidecarSpawn = (...args) => {
    spawnCalls.push(args);
    const child = overrides.childFactory?.() ?? new FakeChild();
    children.push(child);
    if (overrides.protocol !== false) {
      const protocol = typeof overrides.protocol === "function"
        ? overrides.protocol(children.length - 1)
        : overrides.protocol;
      attachRustProtocol(child, protocol);
    }
    return child;
  };
  return {
    supervisor: new MatrixSidecarSupervisor({
      binaryPath: "/private/runtime/matrix-sidecar",
      expectedSha256: checksum,
      protocolVersion: 1,
      expectedIdentity: overrides.expectedIdentity ?? expectedIdentity,
      expectedOwnerUid: 501,
      fileSystem: overrides.fileSystem ?? fileSystem(),
      spawnSidecar,
      spawnEnvironment: overrides.spawnEnvironment ?? spawnEnvironment,
      argumentsList: overrides.argumentsList ?? ["--application-root", APPLICATION_ROOT],
      cwd: overrides.cwd ?? APPLICATION_ROOT,
      ...(overrides.clock === undefined ? {} : { clock: overrides.clock }),
      ...(overrides.diagnostics === undefined ? {} : { onDiagnostic: (value) => overrides.diagnostics?.push(value) }),
      ...(overrides.maxCrashes === undefined ? {} : { maxCrashes: overrides.maxCrashes }),
      restartBackoffMs: [1],
      random: () => 1,
      ...(overrides.maxLockContentionRetries === undefined
        ? {}
        : { maxLockContentionRetries: overrides.maxLockContentionRetries }),
      ...(overrides.lockContentionBackoffMs === undefined
        ? { lockContentionBackoffMs: [1] }
        : { lockContentionBackoffMs: overrides.lockContentionBackoffMs }),
      ...(overrides.maxOutstandingRequests === undefined ? {} : { maxOutstandingRequests: overrides.maxOutstandingRequests }),
      ...(overrides.maxUnackedEvents === undefined ? {} : { maxUnackedEvents: overrides.maxUnackedEvents }),
      ...(overrides.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: overrides.handshakeTimeoutMs }),
      ...(overrides.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: overrides.requestTimeoutMs }),
      ...(overrides.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: overrides.shutdownTimeoutMs }),
      ...(overrides.terminateTimeoutMs === undefined ? {} : { terminateTimeoutMs: overrides.terminateTimeoutMs })
    }),
    children,
    spawnCalls
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("verifies binary and exact ready identity before exposing readiness", async () => {
  const { supervisor, children, spawnCalls } = fixture();
  await supervisor.start();
  assert.deepEqual(supervisor.getStatus(), {
    liveness: "alive", matrixReadiness: "ready", reason: "ready", restartCount: 0, circuitOpen: false
  });
  assert.equal(supervisor.getActiveMediaBootId(), BOOT_ID);
  supervisor.assertRuntimeBinding({
    homeserverOrigin: "https://matrix.org",
    roomId: ROOM_ID,
    ownerMxid: OWNER_MXID,
    botMxid: BOT_MXID,
    botDeviceId: BOT_DEVICE_ID,
    mediaSpoolParent: SPOOL_PARENT
  });
  assert.throws(() => supervisor.assertRuntimeBinding({
    homeserverOrigin: "https://matrix.org",
    roomId: ROOM_ID,
    ownerMxid: OWNER_MXID,
    botMxid: BOT_MXID,
    botDeviceId: "OTHER",
    mediaSpoolParent: SPOOL_PARENT
  }), (error: unknown) => error instanceof MatrixSidecarError && error.code === "invalid_configuration");
  assert.equal(spawnCalls[0]?.[0], "/private/runtime/matrix-sidecar");
  assert.deepEqual(spawnCalls[0]?.[1], ["--application-root", APPLICATION_ROOT]);
  assert.deepEqual(spawnCalls[0]?.[2], {
    cwd: APPLICATION_ROOT,
    env: spawnEnvironment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.deepEqual(children[0]?.stdin.writes.slice(0, 2), [
    { type: "hello", version: 1, id: "hello-1", supervisor: "godaddy-node" },
    { type: "request", version: 1, id: "initialize-2", command: { name: "initialize" } }
  ]);
  await supervisor.stop();
});

test("rejects unsafe, oversized, changed, and wrong-checksum binaries before spawn", async (context) => {
  const sameLengthWrong = Buffer.alloc(binary.byteLength, 0x78);
  const changed = safeStat({ ino: 99 });
  const cases: readonly [string, MatrixSidecarFileSystem, string][] = [
    ["symlink", fileSystem(safeStat({ isSymbolicLink: () => true })), "binary_symlink"],
    ["non-regular", fileSystem(safeStat({ isFile: () => false })), "binary_not_regular"],
    ["non-executable", fileSystem(safeStat({ mode: 0o100600 })), "binary_not_executable"],
    ["group-writable", fileSystem(safeStat({ mode: 0o100720 })), "binary_unsafe_mode"],
    ["setuid", fileSystem(safeStat({ mode: 0o104700 })), "binary_unsafe_mode"],
    ["oversized", fileSystem(safeStat({ size: 256 * 1024 * 1024 + 1 })), "binary_unsafe_mode"],
    ["wrong-owner", fileSystem(safeStat({ uid: 777 })), "binary_wrong_owner"],
    ["path-swap", fileSystem([safeStat(), safeStat(), changed]), "binary_verification_failed"],
    ["checksum", fileSystem(safeStat(), sameLengthWrong), "binary_checksum_mismatch"]
  ];
  for (const [name, fs, code] of cases) {
    await context.test(name, async () => {
      const { supervisor, spawnCalls } = fixture({ fileSystem: fs });
      await assert.rejects(supervisor.start(), (error: unknown) => error instanceof MatrixSidecarError && error.code === code);
      assert.equal(spawnCalls.length, 0);
      assert.equal(supervisor.getStatus().reason, "verification_failed");
    });
  }
});

test("performs the final path check immediately before the immutable deployment-path spawn", async () => {
  const operations: string[] = [];
  const { supervisor } = fixture({
    fileSystem: {
      lstat: async () => {
        operations.push("lstat");
        return safeStat();
      },
      readFile: async () => {
        operations.push("read");
        return binary;
      }
    },
    childFactory: () => {
      operations.push("spawn");
      return new FakeChild();
    }
  });
  await supervisor.start();
  assert.deepEqual(operations, ["lstat", "read", "lstat", "lstat", "spawn"]);
  await supervisor.stop();
});

test("rejects ambient process injection and split-brain identity/path configuration", () => {
  assert.throws(() => fixture({
    spawnEnvironment: { ...spawnEnvironment, LD_PRELOAD: "/tmp/evil.so" }
  }), (error: unknown) => error instanceof MatrixSidecarError && error.code === "invalid_configuration");
  assert.throws(() => fixture({
    spawnEnvironment: { ...spawnEnvironment, MATRIX_ROOM_ID: "!other:matrix.org" }
  }), (error: unknown) => error instanceof MatrixSidecarError && error.code === "invalid_configuration");
  assert.throws(() => fixture({
    spawnEnvironment: { ...spawnEnvironment, MATRIX_MEDIA_SPOOL_DIR: "/private/x/../matrix-spool" }
  }), (error: unknown) => error instanceof MatrixSidecarError && error.code === "invalid_configuration");
  for (const argumentsList of [
    [],
    ["--caller-controlled"],
    ["--application-root", "relative"],
    ["--application-root", APPLICATION_ROOT, "--caller-controlled"]
  ]) {
    assert.throws(() => fixture({ argumentsList }), (error: unknown) =>
      error instanceof MatrixSidecarError && error.code === "invalid_configuration");
  }
});

test("waits for an identity-bearing ready frame and rejects timeout or identity drift", async (context) => {
  await context.test("missing ready", async () => {
    const clock = new ManualClock();
    const { supervisor, children } = fixture({
      clock,
      protocol: { emitReady: false },
      handshakeTimeoutMs: 5,
      terminateTimeoutMs: 2
    });
    const starting = supervisor.start();
    await turn();
    assert.equal(supervisor.getStatus().matrixReadiness, "not_ready");
    clock.advance(5);
    await assert.rejects(starting, (error: unknown) => error instanceof MatrixSidecarError && error.code === "handshake_timeout");
    assert.deepEqual(children[0]?.kills, ["SIGTERM"]);
  });
  await context.test("identity drift", async () => {
    const { supervisor, children } = fixture({ protocol: { identity: readyIdentity({ room_id_sha256: "f".repeat(64) }) } });
    await assert.rejects(supervisor.start(), (error: unknown) => error instanceof MatrixSidecarError && error.code === "handshake_rejected");
    assert.deepEqual(children[0]?.kills, ["SIGTERM"]);
  });
});

test("store quarantine remains alive and blocked without a crash/restart loop", async () => {
  const clock = new ManualClock();
  const { supervisor, children } = fixture({
    clock,
    protocol: { initializeError: "store_quarantined" },
    handshakeTimeoutMs: 5
  });
  await supervisor.start();
  assert.deepEqual(supervisor.getStatus(), {
    liveness: "alive", matrixReadiness: "not_ready", reason: "sidecar_not_ready", restartCount: 0, circuitOpen: false
  });
  clock.advance(60_000);
  assert.equal(children.length, 1);
  assert.deepEqual(children[0]?.kills, []);
  await supervisor.stop();
});

test("lock contention stays HTTP-live and retries with bounded backoff until the old process releases the lock", async () => {
  const clock = new ManualClock();
  const diagnostics: MatrixSidecarDiagnostic[] = [];
  const { supervisor, children } = fixture({
    clock,
    diagnostics,
    protocol: (childIndex) => childIndex === 0 ? { initializeError: "lock_contended" } : {},
    maxCrashes: 3
  });
  await supervisor.start();
  await turn();
  assert.equal(children.length, 1);
  assert.deepEqual(children[0]?.kills, ["SIGTERM"]);
  assert.ok(diagnostics.some((item) => item.code === "lock_contended"));
  assert.deepEqual(supervisor.getStatus(), {
    liveness: "dead", matrixReadiness: "not_ready", reason: "lock_contended", restartCount: 1, circuitOpen: false
  });
  assert.deepEqual(children[0]?.stdin.writes.filter((frame) => frame.type === "request"), [
    { type: "request", version: 1, id: "initialize-2", command: { name: "initialize" } }
  ]);

  clock.advance(1);
  await turn();
  assert.equal(children.length, 2);
  assert.equal(supervisor.getStatus().matrixReadiness, "ready");
  assert.equal(supervisor.getStatus().circuitOpen, false);
  await supervisor.stop();
});

test("lock contention has a bounded cooldown and one automatic half-open attempt", async () => {
  const clock = new ManualClock();
  const { supervisor, children } = fixture({
    clock,
    protocol: { initializeError: "lock_contended" },
    maxCrashes: 1,
    maxLockContentionRetries: 3,
    lockContentionBackoffMs: [2]
  });
  await supervisor.start();
  await turn();
  assert.equal(children.length, 1);
  assert.equal(supervisor.getStatus().reason, "lock_contended");
  assert.equal(supervisor.getStatus().circuitOpen, false);

  clock.advance(2);
  await turn();
  assert.equal(children.length, 2);
  clock.advance(2);
  await turn();
  assert.equal(children.length, 3);
  assert.equal(supervisor.getStatus().reason, "circuit_open");
  assert.equal(supervisor.getStatus().restartCount, 3);
  assert.equal(supervisor.getStatus().circuitOpen, true);
  await supervisor.start();
  await supervisor.start();
  clock.advance(59_999);
  assert.equal(children.length, 3);
  assert.equal(supervisor.getStatus().restartCount, 3);
  clock.advance(1);
  await turn();
  assert.equal(children.length, 4);
  assert.equal(supervisor.getStatus().reason, "lock_contended");
  assert.equal(supervisor.getStatus().restartCount, 1);
  await supervisor.stop();
});

test("accepts a ready frame and first ingress in one stdout chunk", async () => {
  const event = validEvent();
  const { supervisor } = fixture({ protocol: { eventAfterReady: event } });
  const observed: unknown[] = [];
  supervisor.onEvent((value) => observed.push(value));
  await supervisor.start();
  assert.equal(observed.length, 1);
  assert.equal(supervisor.getStatus().matrixReadiness, "ready");
  await supervisor.ack("ingress-1", "$ingress-1:matrix.org", "mysql-1");
  await supervisor.stop();
});

test("verifies exact ingress event identity and ACK event ID", async () => {
  const { supervisor, children } = fixture();
  const observed: unknown[] = [];
  supervisor.onEvent((event) => observed.push(event));
  await supervisor.start();
  const child = children[0];
  assert.ok(child);
  child.stdout.pushFrame(validEvent());
  assert.equal(observed.length, 1);
  await assert.rejects(
    supervisor.ack("ingress-1", "$different:matrix.org", "mysql-42"),
    (error: unknown) => error instanceof MatrixSidecarError && error.code === "protocol_error"
  );
  assert.equal(child.stdin.writes.some((frame) => frame.type === "ack"), false);
  await supervisor.ack("ingress-1", "$ingress-1:matrix.org", "mysql-42");
  assert.deepEqual(child.stdin.writes.at(-1), {
    type: "ack", version: 1, id: "ack-3", ack: { event_id: "$ingress-1:matrix.org", durable_receipt_id: "mysql-42" }
  });
  await supervisor.stop();
});

test("accepts only a content-free media-expired rejection, freezes it, and ACKs its event", async () => {
  const frame = validRejection();
  const { supervisor, children } = fixture({ protocol: { rejectionAfterReady: frame } });
  const observed: unknown[] = [];
  supervisor.onRejectedEvent((rejection) => observed.push(rejection));
  await supervisor.start();
  assert.equal(observed.length, 1);
  const rejection = observed[0] as Readonly<{ receiptId: string; rejection: Readonly<Record<string, unknown>> }>;
  assert.equal(rejection.receiptId, "rejected-1");
  assert.equal(rejection.rejection.reason, "media_expired");
  assert.equal(Object.isFrozen(rejection), true);
  assert.equal(Object.isFrozen(rejection.rejection), true);
  assert.equal(Object.hasOwn(rejection.rejection, "body"), false);
  assert.equal(Object.hasOwn(rejection.rejection, "media"), false);
  assert.equal(Object.hasOwn(rejection.rejection, "reply_to_event_id"), false);
  await supervisor.ack("rejected-1", "$rejected-1:matrix.org", "mysql-rejected-1");
  assert.deepEqual(children[0]?.stdin.writes.at(-1), {
    type: "ack",
    version: 1,
    id: "ack-3",
    ack: { event_id: "$rejected-1:matrix.org", durable_receipt_id: "mysql-rejected-1" }
  });
  await supervisor.stop();
});

test("rejects malformed, content-bearing, duplicate, and aggregate-overflow rejection frames", async (context) => {
  const malformed: readonly [string, Readonly<Record<string, unknown>>][] = [
    ["top-level metadata", { ...validRejection("top-extra"), metadata: {} }],
    ["wrong reason", validRejection("wrong-reason", { reason: "secret_like_content" })],
    ["uppercase hash", validRejection("upper-hash", { event_hash: "E".repeat(64) })],
    ["missing device", (() => {
      const frame = validRejection("missing-device") as { rejection: Record<string, unknown> };
      const { sender_device_id: _removed, ...rejection } = frame.rejection;
      return { ...frame, rejection };
    })()],
    ["body", validRejection("with-body", { body: "secret plaintext" })],
    ["media", validRejection("with-media", { media: [] })],
    ["handles", validRejection("with-handles", { handles: [] })],
    ["reply", validRejection("with-reply", { reply_to_event_id: null })],
    ["path", validRejection("with-path", { path: "/private/matrix-spool/plaintext" })],
    ["metadata", validRejection("with-metadata", { metadata: {} })]
  ];
  for (const [name, frame] of malformed) {
    await context.test(name, async () => {
      const { supervisor, children } = fixture();
      await supervisor.start();
      children[0]?.stdout.pushFrame(frame);
      assert.deepEqual(children[0]?.kills, ["SIGTERM"]);
      await turn();
      await supervisor.stop();
    });
  }

  await context.test("duplicate", async () => {
    const { supervisor, children } = fixture();
    await supervisor.start();
    const frame = validRejection("duplicate-rejection");
    children[0]?.stdout.pushFrame(frame);
    children[0]?.stdout.pushFrame(frame);
    assert.deepEqual(children[0]?.kills, ["SIGTERM"]);
    await turn();
    await supervisor.stop();
  });

  await context.test("aggregate unacked overflow", async () => {
    const { supervisor, children } = fixture({ maxUnackedEvents: 1 });
    await supervisor.start();
    children[0]?.stdout.pushFrame(validEvent("pending-event"));
    children[0]?.stdout.pushFrame(validRejection("pending-rejection"));
    assert.deepEqual(children[0]?.kills, ["SIGTERM"]);
    await turn();
    await supervisor.stop();
  });
});

test("deep-freezes nested ingress media before notifying subscribers", async () => {
  const diagnostics: MatrixSidecarDiagnostic[] = [];
  const { supervisor, children } = fixture({ diagnostics });
  let observedMediaLength = -1;
  supervisor.onEvent((event) => {
    (event.payload.media as unknown[]).push({});
  });
  supervisor.onEvent((event) => {
    observedMediaLength = (event.payload.media as readonly unknown[]).length;
  });
  await supervisor.start();
  children[0]?.stdout.pushFrame(validEvent());
  assert.equal(observedMediaLength, 0);
  assert.ok(diagnostics.some((item) => item.code === "subscriber_failed"));
  await supervisor.ack("ingress-1", "$ingress-1:matrix.org", "mysql-42");
  await supervisor.stop();
});

test("reconciles an ACK whose response was lost across a sidecar restart", async () => {
  const clock = new ManualClock();
  const { supervisor, children } = fixture({
    clock,
    protocol: (childIndex) => childIndex === 0
      ? { eventAfterReady: validEvent(), respondAck: false }
      : {},
    maxCrashes: 3
  });
  const observed: unknown[] = [];
  supervisor.onEvent((event) => observed.push(event));
  await supervisor.start();
  assert.equal(observed.length, 1);

  const lostAck = supervisor.ack("ingress-1", "$ingress-1:matrix.org", "mysql-42");
  await turn();
  assert.equal(children[0]?.stdin.writes.at(-1)?.type, "ack");
  children[0]?.close(1, null);
  await assert.rejects(
    lostAck,
    (error: unknown) => error instanceof MatrixSidecarError && error.code === "not_ready"
  );

  clock.advance(1);
  await turn();
  assert.equal(children.length, 2);
  assert.equal(supervisor.getStatus().matrixReadiness, "ready");
  await supervisor.ack("ingress-1", "$ingress-1:matrix.org", "mysql-42");
  assert.deepEqual(children[1]?.stdin.writes.at(-1), {
    type: "ack", version: 1, id: "ack-6", ack: { event_id: "$ingress-1:matrix.org", durable_receipt_id: "mysql-42" }
  });
  await supervisor.stop();
});

test("preserves safe sidecar failure classes and treats invalid-state as protocol failure", async () => {
  const { supervisor, children } = fixture();
  await supervisor.start();
  const child = children[0];
  assert.ok(child);
  for (const code of ["policy_denied", "media_denied", "transport_failed"] as const) {
    const pending = supervisor.request("health", {});
    await turn();
    const id = child.stdin.writes.at(-1)?.id as string;
    child.stdout.pushFrame({ type: "response", version: 1, id, ok: false, result: null, error: code });
    await assert.rejects(pending, (error: unknown) => error instanceof MatrixSidecarError && error.code === code);
    assert.equal(supervisor.getStatus().matrixReadiness, "ready");
  }
  const blocked = supervisor.request("health", {});
  await turn();
  const blockedId = child.stdin.writes.at(-1)?.id as string;
  child.stdout.pushFrame({ type: "response", version: 1, id: blockedId, ok: false, result: null, error: "store_quarantined" });
  await assert.rejects(blocked, (error: unknown) => error instanceof MatrixSidecarError && error.code === "store_quarantined");
  assert.equal(supervisor.getStatus().matrixReadiness, "not_ready");
  assert.equal(supervisor.getActiveMediaBootId(), undefined);
  child.stdout.pushFrame({ type: "status", version: 1, id: "still-blocked", readiness: "blocked" });
  child.stdout.pushFrame({ ...readyFrame(), id: "ready-again" });
  assert.equal(supervisor.getStatus().matrixReadiness, "ready");

  child.closeOnKill = false;
  const invalid = supervisor.request("health", {});
  await turn();
  const invalidId = child.stdin.writes.at(-1)?.id as string;
  child.stdout.pushFrame({ type: "response", version: 1, id: invalidId, ok: false, result: null, error: "invalid_state" });
  await assert.rejects(invalid, (error: unknown) => error instanceof MatrixSidecarError && error.code === "protocol_error");
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.close(null, "SIGTERM");
  await supervisor.stop();
});

test("malformed nested frames fail terminally and cannot be re-promoted by later status", async () => {
  const clock = new ManualClock();
  const child = new FakeChild();
  child.closeOnKill = false;
  const { supervisor } = fixture({
    clock,
    childFactory: () => child,
    terminateTimeoutMs: 5
  });
  await supervisor.start();
  child.stdout.pushFrame({
    type: "response", version: 1, id: "unsolicited", ok: true, result: { name: "health", extra: true }, error: null
  });
  assert.equal(supervisor.getStatus().reason, "protocol_error");
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.stdout.pushFrame({ type: "status", version: 1, id: "fake-ready", readiness: "ready" });
  assert.equal(supervisor.getStatus().matrixReadiness, "not_ready");
  clock.advance(5);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  child.close(null, "SIGKILL");
  await supervisor.stop();
});

test("rejects malformed UTF-8, oversized lines, duplicate IDs, missing device IDs and unacked overflow", async (context) => {
  const cases: readonly [string, number | undefined, (child: FakeChild) => void][] = [
    ["UTF-8", undefined, (child) => child.stdout.pushBytes(Buffer.from([0xff, 0x0a]))],
    ["line", undefined, (child) => child.stdout.pushBytes(Buffer.alloc(256 * 1024 + 1, 0x78))],
    ["duplicate", undefined, (child) => { child.stdout.pushFrame(validEvent("dup")); child.stdout.pushFrame(validEvent("dup")); }],
    ["device", undefined, (child) => {
      const frame = validEvent("missing-device") as { event: Record<string, unknown> };
      const { sender_device_id: _removed, ...event } = frame.event;
      child.stdout.pushFrame({ ...frame, event });
    }],
    ["unacked", 1, (child) => { child.stdout.pushFrame(validEvent("one")); child.stdout.pushFrame(validEvent("two")); }]
  ];
  for (const [name, maxUnackedEvents, inject] of cases) {
    await context.test(name, async () => {
      const { supervisor, children } = fixture({ ...(maxUnackedEvents === undefined ? {} : { maxUnackedEvents }) });
      await supervisor.start();
      const child = children[0];
      assert.ok(child);
      inject(child);
      assert.deepEqual(child.kills, ["SIGTERM"]);
      await turn();
      await supervisor.stop();
    });
  }
});

test("fails closed before inbound ID history saturation can evict and admit a late replay", async () => {
  const { supervisor, children } = fixture();
  await supervisor.start();
  const child = children[0];
  assert.ok(child);
  for (let index = 0; index < 4_200; index += 1) {
    child.stdout.pushFrame({ type: "status", version: 1, id: `status-${index}`, readiness: "ready" });
    if (child.kills.length > 0) break;
  }
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(supervisor.getStatus().reason, "protocol_error");
  child.stdout.pushFrame({ type: "hello", version: 1, id: "sidecar-hello", build: "0.1.0" });
  assert.deepEqual(child.kills, ["SIGTERM"]);
  await turn();
  await supervisor.stop();
});

test("processes more than 4096 healthy requests by verified generation rollover without opening the crash circuit", async () => {
  const { supervisor, children } = fixture({ maxCrashes: 1 });
  await supervisor.start();
  for (let index = 0; index < 7_000; index += 1) {
    if (supervisor.getStatus().reason === "generation_rollover") await supervisor.start();
    const result = await supervisor.request("inspect_media", { media: [] });
    assert.deepEqual(result, { name: "media", objects: [] });
  }
  await supervisor.start();
  assert.ok(children.length >= 3);
  assert.equal(supervisor.getStatus().matrixReadiness, "ready");
  assert.equal(supervisor.getStatus().restartCount, 0);
  assert.equal(supervisor.getStatus().circuitOpen, false);
  for (const child of children.slice(0, -1)) {
    assert.equal(child.kills.length, 0);
    assert.equal(child.stdin.writes.filter((frame) => frame.type === "shutdown").length, 1);
    assert.ok(child.stdin.writes.length < 4_096);
    assert.equal(new Set(child.stdin.writes.map((frame) => frame.id)).size, child.stdin.writes.length);
  }
  // An old child cannot inject a stale response into the new generation.
  children[0]?.stdout.pushFrame({ type: "response", version: 1, id: "initialize-2", ok: true, result: { name: "initialized" }, error: null });
  assert.equal(supervisor.getStatus().matrixReadiness, "ready");
  await supervisor.stop();
});

test("generation rollover drains already forwarded work and replays newly journaled ingress after re-handshake", async () => {
  const observed: string[] = [];
  const { supervisor, children } = fixture({
    protocol: (index) => index === 0 ? {} : { eventAfterReady: validEvent("during-rollover") }
  });
  supervisor.onEvent((event) => observed.push(event.receiptId));
  await supervisor.start();
  const oldChild = children[0]!;
  oldChild.stdout.pushFrame(validEvent("before-rollover"));
  for (let index = 0; supervisor.getStatus().reason !== "generation_rollover"; index += 1) {
    assert.ok(index < MATRIX_SIDECAR_GENERATION_FRAME_BUDGET);
    oldChild.stdout.pushFrame({ type: "status", version: 1, id: `roll-status-${index}`, readiness: "ready" });
  }
  await assert.rejects(supervisor.request("health", {}), (error: unknown) => error instanceof MatrixSidecarError && error.code === "not_ready");
  oldChild.stdout.pushFrame(validEvent("during-rollover"));
  assert.deepEqual(observed, ["before-rollover"]);
  assert.equal(children.length, 1);
  assert.equal(oldChild.stdin.writes.some((frame) => frame.type === "shutdown"), false);
  await supervisor.request("inspect_media", { media: [] });
  await supervisor.ack("before-rollover", "$before-rollover:matrix.org", "durable-before");
  await supervisor.start();
  assert.equal(children.length, 2);
  assert.deepEqual(observed, ["before-rollover", "during-rollover"]);
  assert.equal(oldChild.stdin.writes.filter((frame) => frame.type === "ack").length, 1);
  await supervisor.ack("during-rollover", "$during-rollover:matrix.org", "durable-after");
  await supervisor.stop();
});

test("an undrained rollover fails closed instead of resetting replay history on a live generation", async () => {
  const clock = new ManualClock();
  const { supervisor, children } = fixture({ clock, shutdownTimeoutMs: 5, maxCrashes: 1 });
  await supervisor.start();
  const child = children[0]!;
  child.stdout.pushFrame(validEvent("unacknowledged"));
  for (let index = 0; supervisor.getStatus().reason !== "generation_rollover"; index += 1) {
    child.stdout.pushFrame({ type: "status", version: 1, id: `undrained-${index}`, readiness: "ready" });
  }
  clock.advance(5);
  await turn();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(children.length, 1);
  assert.equal(supervisor.getStatus().circuitOpen, true);
  assert.equal(child.stdin.writes.some((frame) => frame.type === "ack"), false);
  await supervisor.stop();
});

test("an explicit stop during generation rollover drains the current child without launching a replacement", async () => {
  const { supervisor, children } = fixture();
  await supervisor.start();
  const child = children[0]!;
  child.stdout.pushFrame(validEvent("stop-during-rollover"));
  for (let index = 0; supervisor.getStatus().reason !== "generation_rollover"; index += 1) {
    assert.ok(index < MATRIX_SIDECAR_GENERATION_FRAME_BUDGET);
    child.stdout.pushFrame({ type: "status", version: 1, id: `stopping-${index}`, readiness: "ready" });
  }
  const stopping = supervisor.stop();
  await supervisor.ack("stop-during-rollover", "$stop-during-rollover:matrix.org", "durable-stop");
  await stopping;
  assert.equal(children.length, 1);
  assert.equal(child.stdin.writes.filter((frame) => frame.type === "shutdown").length, 1);
  assert.equal(supervisor.getStatus().liveness, "stopped");
});

test("accepts a bounded content-free invalid-media rejection and acknowledges its durable receipt", async () => {
  const { supervisor, children } = fixture();
  const reasons: unknown[] = [];
  supervisor.onRejectedEvent((value) => reasons.push(value.rejection.reason));
  await supervisor.start();
  children[0]?.stdout.pushFrame(validRejection("invalid-media", { reason: "invalid_media" }));
  assert.deepEqual(reasons, ["invalid_media"]);
  await supervisor.ack("invalid-media", "$invalid-media:matrix.org", "durable-invalid-media");
  assert.equal(supervisor.getStatus().matrixReadiness, "ready");
  await supervisor.stop();
});

test("serialization and stdin write failures reject the request and fail the generation closed", async (context) => {
  await context.test("serialization", async () => {
    const { supervisor, children } = fixture();
    await supervisor.start();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await assert.rejects(
      supervisor.request("health", circular),
      (error: unknown) => error instanceof MatrixSidecarError && error.code === "protocol_error"
    );
    await turn();
    assert.deepEqual(children[0]?.kills, ["SIGTERM"]);
    await supervisor.stop();
  });

  await context.test("write", async () => {
    const { supervisor, children } = fixture();
    await supervisor.start();
    const child = children[0];
    assert.ok(child);
    child.stdin.writeError = new Error("test-only broken pipe");
    await assert.rejects(
      supervisor.request("health", {}),
      (error: unknown) => error instanceof MatrixSidecarError && error.code === "protocol_error"
    );
    await turn();
    assert.deepEqual(child.kills, ["SIGTERM"]);
    await supervisor.stop();
  });
});

test("a queued request that expires is never written after backpressure releases", async () => {
  const clock = new ManualClock();
  const child = new FakeChild();
  child.closeOnKill = false;
  const { supervisor } = fixture({
    clock,
    childFactory: () => child,
    handshakeTimeoutMs: 20,
    requestTimeoutMs: 100,
    terminateTimeoutMs: 5,
    maxOutstandingRequests: 2
  });
  await supervisor.start();
  child.stdin.backpressured = true;
  const first = supervisor.request("health", {}, 100);
  await turn();
  const second = supervisor.request("health", {}, 5);
  await turn();
  assert.equal(child.stdin.writes.filter((frame) => frame.type === "request" && (frame.command as Record<string, unknown>).name === "health").length, 1);
  clock.advance(5);
  await assert.rejects(second, (error: unknown) => error instanceof MatrixSidecarError && error.code === "request_timeout");
  await assert.rejects(first, (error: unknown) => error instanceof MatrixSidecarError && error.code === "protocol_error");
  child.stdin.releaseBackpressure();
  await turn();
  assert.equal(child.stdin.writes.filter((frame) => frame.type === "request" && (frame.command as Record<string, unknown>).name === "health").length, 1);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.close(null, "SIGTERM");
  await supervisor.stop();
});

test("stale backpressure from an exited child cannot delay or poison the next handshake", async () => {
  const clock = new ManualClock();
  const { supervisor, children } = fixture({
    clock,
    handshakeTimeoutMs: 100,
    requestTimeoutMs: 100,
    maxCrashes: 3
  });
  await supervisor.start();
  const firstChild = children[0];
  assert.ok(firstChild);
  firstChild.stdin.backpressured = true;
  const pending = supervisor.request("health", {});
  await turn();
  firstChild.close(1, null);
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof MatrixSidecarError && error.code === "not_ready"
  );

  clock.advance(1);
  await turn();
  assert.equal(children.length, 2);
  assert.equal(supervisor.getStatus().matrixReadiness, "ready");
  assert.equal(clock.now(), 1);
  await supervisor.stop();
});

test("redacts stderr and automatically half-opens the crash circuit without resetting persistent state", async () => {
  const clock = new ManualClock();
  const diagnostics: MatrixSidecarDiagnostic[] = [];
  const { supervisor, children } = fixture({ clock, diagnostics, maxCrashes: 3 });
  await supervisor.start();
  children[0]?.stderr.pushBytes(Buffer.from("token=secret message body", "utf8"));
  assert.deepEqual(diagnostics[0], { code: "stderr_redacted", byteCount: 25 });
  assert.equal(JSON.stringify(diagnostics).includes("secret"), false);

  for (let index = 0; index < 3; index += 1) {
    children[index]?.close(1, null);
    if (index < 2) {
      clock.advance(1);
      await turn();
    }
  }
  assert.equal(supervisor.getStatus().circuitOpen, true);
  assert.equal(supervisor.getStatus().reason, "circuit_open");
  assert.equal(children.length, 3);
  const opened = supervisor.getStatus();
  await supervisor.start();
  await supervisor.start();
  clock.advance(59_999);
  assert.equal(children.length, 3);
  assert.deepEqual(supervisor.getStatus(), opened);
  clock.advance(1);
  await turn();
  assert.equal(children.length, 4);
  assert.equal(supervisor.getStatus().matrixReadiness, "ready");
  await Promise.all([supervisor.start(), supervisor.start()]);
  assert.equal(children.length, 4);
  await supervisor.stop();
  clock.advance(600_000);
  await turn();
  assert.equal(children.length, 4);
});

test("initial sync not_ready retries the same store and recovers without a Settings action", async () => {
  const clock = new ManualClock();
  const { supervisor, children, spawnCalls } = fixture({ clock, maxCrashes: 1,
    protocol: (index) => index === 0 ? { initializeError: "not_ready" } : {} });
  await assert.rejects(supervisor.start(), (error: unknown) => error instanceof MatrixSidecarError && error.code === "spawn_failed");
  await turn();
  assert.equal(supervisor.getStatus().circuitOpen, true);
  clock.advance(60_000);
  await turn();
  assert.equal(children.length, 2);
  assert.equal(supervisor.getStatus().matrixReadiness, "ready");
  assert.deepEqual(spawnCalls[1], spawnCalls[0]);
  await supervisor.stop();
});

test("identity rejection and store quarantine cannot be cleared by automatic half-open", async () => {
  for (const protocol of [{ identity: readyIdentity({ store_fingerprint: "f".repeat(64) }) },
    { initializeError: "store_quarantined" as const }]) {
    const clock = new ManualClock();
    const { supervisor, children } = fixture({ clock, maxCrashes: 1, protocol });
    await supervisor.start().catch(() => undefined);
    await turn();
    clock.advance(600_000);
    await supervisor.start();
    await turn();
    assert.equal(children.length, 1);
    assert.equal(supervisor.getStatus().matrixReadiness, "not_ready");
    await supervisor.stop();
  }
});

test("uses one absolute graceful deadline before bounded TERM and KILL escalation", async () => {
  const clock = new ManualClock();
  const child = new FakeChild();
  child.closeOnKill = false;
  const { supervisor } = fixture({
    clock,
    childFactory: () => child,
    protocol: { closeAfterShutdown: false },
    shutdownTimeoutMs: 5,
    terminateTimeoutMs: 1
  });
  await supervisor.start();
  const stopping = supervisor.stop();
  const concurrentStop = supervisor.stop();
  await turn();
  assert.equal(child.stdin.writes.filter((frame) => frame.type === "shutdown").length, 1);
  clock.advance(4);
  await turn();
  assert.deepEqual(child.kills, []);
  clock.advance(1);
  await turn();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  clock.advance(1);
  await turn();
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  child.close(null, "SIGKILL");
  await Promise.all([stopping, concurrentStop]);
  await supervisor.stop();
  assert.equal(child.stdin.writes.filter((frame) => frame.type === "shutdown").length, 1);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(clock.now(), 6);
  assert.equal(supervisor.getStatus().liveness, "stopped");
});

test("stops intake but permits media inspection and durable ACK during the graceful drain", async () => {
  const clock = new ManualClock();
  const { supervisor, children } = fixture({
    clock,
    protocol: { eventAfterReady: validEvent() },
    shutdownTimeoutMs: 5,
    terminateTimeoutMs: 1
  });
  await supervisor.start();
  const stopping = supervisor.stop();
  await turn();
  assert.deepEqual(await supervisor.request("inspect_media", { media: [] }), {
    name: "media",
    objects: []
  });
  await assert.rejects(
    supervisor.request("send", {}),
    (error: unknown) => error instanceof MatrixSidecarError && error.code === "not_ready"
  );
  await supervisor.ack("ingress-1", "$ingress-1:matrix.org", "mysql-42");
  await stopping;
  assert.equal(clock.now(), 0);
  assert.deepEqual(children[0]?.kills, []);
  assert.equal(children[0]?.stdin.writes.some((frame) => frame.type === "shutdown"), true);
});

test("does not report stopped when a child survives SIGKILL escalation", async () => {
  const clock = new ManualClock();
  const child = new FakeChild();
  child.closeOnKill = false;
  const { supervisor } = fixture({
    clock,
    childFactory: () => child,
    protocol: { closeAfterShutdown: false },
    shutdownTimeoutMs: 5,
    terminateTimeoutMs: 1
  });
  await supervisor.start();
  const stopping = supervisor.stop();
  await turn();
  clock.advance(5);
  await turn();
  clock.advance(1);
  await turn();
  clock.advance(1);
  await assert.rejects(
    stopping,
    (error: unknown) => error instanceof MatrixSidecarError && error.code === "termination_failed"
  );
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(supervisor.getStatus().liveness, "alive");
  assert.equal(supervisor.getStatus().reason, "termination_failed");
  child.close(null, "SIGKILL");
  assert.equal(supervisor.getStatus().liveness, "stopped");
});
