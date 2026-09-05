import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createMatrixRuntime,
  type MatrixIngressMedia,
  type MatrixMediaFileHandle,
  type MatrixMediaFileSystem,
  type MatrixMediaStat,
  type MatrixRuntimeDependencyReadiness
} from "../src/godaddy/matrix-runtime.ts";
import {
  MatrixSidecarError,
  type MatrixRuntimeBinding,
  type MatrixSidecarEvent,
  type MatrixSidecarIngressRejection,
  type MatrixSidecarStatus
} from "../src/godaddy/matrix-sidecar-supervisor.ts";

const CURRENT_BOOT = "a".repeat(32);
const REPLAY_BOOT = "b".repeat(32);
const TOKEN = "c".repeat(24);
const SPOOL_PARENT = "/private/matrix-spool";
const config = Object.freeze({
  homeserverUrl: "https://matrix.org",
  roomId: "!private:matrix.org",
  ownerMxid: "@owner:matrix.org",
  botMxid: "@consultant:matrix.org",
  botDeviceId: "BOTDEVICE1",
  mediaSpoolParent: SPOOL_PARENT,
  mediaOwnerUid: 501
});

const roomPolicy = Object.freeze({
  encrypted: true as const,
  inviteOnly: true as const,
  joinedMembers: Object.freeze([config.ownerMxid, config.botMxid]),
  pendingInvites: 0 as const,
  historyVisibilityJoined: true as const,
  publicAlias: false as const,
  publicListing: false as const,
  guestsAllowed: false as const,
  bridgesPresent: false as const,
  widgetsPresent: false as const,
  ownerDevicesTrusted: true as const,
  botDeviceTrusted: true as const,
  devicesNonRevoked: true as const,
  observedAtMs: 1_788_454_400_000
});

const readyDependencies = (): MatrixRuntimeDependencyReadiness => ({
  mysqlAvailable: true,
  outboxAvailable: true,
  egressPolicyPass: true
});

class FakeSupervisor {
  status: MatrixSidecarStatus = Object.freeze({
    liveness: "alive",
    matrixReadiness: "ready",
    reason: "ready",
    restartCount: 0,
    circuitOpen: false
  });
  activeBootId: string | undefined = CURRENT_BOOT;
  listener: ((event: MatrixSidecarEvent) => void) | undefined;
  rejectionListener: ((rejection: MatrixSidecarIngressRejection) => void) | undefined;
  readonly bindings: MatrixRuntimeBinding[] = [];
  readonly requests: Array<Readonly<{ method: string; params: Readonly<Record<string, unknown>> }>> = [];
  readonly acknowledgements: Array<Readonly<{ receiptId: string; eventId: string; durableReceiptId: string }>> = [];
  starts = 0;
  stops = 0;
  failures = 0;
  ackFailure: Error | undefined;
  sendResult: unknown = { name: "accepted", event_id: "$accepted:matrix.org" };
  inspectResult: unknown | undefined;

  assertRuntimeBinding(binding: MatrixRuntimeBinding): void {
    this.bindings.push(binding);
  }

  getActiveMediaBootId(): string | undefined {
    return this.activeBootId;
  }

  async start(): Promise<void> {
    this.starts += 1;
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  getStatus(): MatrixSidecarStatus {
    return this.status;
  }

  onEvent(listener: (event: MatrixSidecarEvent) => void): () => void {
    assert.equal(this.listener, undefined);
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  onRejectedEvent(listener: (rejection: MatrixSidecarIngressRejection) => void): () => void {
    assert.equal(this.rejectionListener, undefined);
    this.rejectionListener = listener;
    return () => {
      if (this.rejectionListener === listener) this.rejectionListener = undefined;
    };
  }

  async ack(receiptId: string, eventId: string, durableReceiptId: string): Promise<void> {
    this.acknowledgements.push({ receiptId, eventId, durableReceiptId });
    if (this.ackFailure !== undefined) throw this.ackFailure;
  }

  async request(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "inspect_media") {
      if (this.inspectResult !== undefined) return this.inspectResult;
      const media = params.media as Array<Record<string, unknown>>;
      return {
        name: "media",
        objects: media.map((item) => ({
          handle: item.handle,
          kind: item.declared_mime === "image/jpeg" ? "jpeg" : item.declared_mime === "image/png" ? "png" : "pdf",
          length: item.length,
          sha256: item.sha256
        }))
      };
    }
    return this.sendResult;
  }

  failClosed(): void {
    this.failures += 1;
  }

  emit(event: MatrixSidecarEvent): void {
    this.listener?.(event);
  }

  emitRejected(rejection: MatrixSidecarIngressRejection): void {
    this.rejectionListener?.(rejection);
  }
}

function ingress(overrides: Partial<Readonly<Record<string, unknown>>> = {}, receiptId = "ingress-receipt-1"): MatrixSidecarEvent {
  return {
    receiptId,
    payload: {
      event_id: "$incoming:matrix.org",
      room_id: config.roomId,
      sender_mxid: config.ownerMxid,
      sender_device_id: "OWNERDEVICE1",
      body: "Проведи аналіз.",
      reply_to_event_id: null,
      media: [],
      ...overrides
    }
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function rejectionForIngress(
  event: MatrixSidecarEvent,
  overrides: Partial<Readonly<Record<string, unknown>>> = {}
): MatrixSidecarIngressRejection {
  const payload = event.payload;
  const media = (payload.media as readonly Record<string, unknown>[]).map((item) => ({
    declaredMime: item.declared_mime,
    length: item.length,
    sha256: item.sha256
  }));
  const bodyHash = hashJson(payload.body);
  const mediaManifestHash = hashJson(media);
  const eventHash = hashJson({
    eventId: payload.event_id,
    roomId: payload.room_id,
    senderMxid: payload.sender_mxid,
    senderDeviceId: payload.sender_device_id,
    encrypted: true,
    bodyHash,
    relationEventId: payload.reply_to_event_id,
    mediaManifestHash
  });
  return {
    receiptId: event.receiptId,
    rejection: {
      event_id: payload.event_id,
      room_id: payload.room_id,
      sender_mxid: payload.sender_mxid,
      sender_device_id: payload.sender_device_id,
      body_hash: bodyHash,
      media_manifest_hash: mediaManifestHash,
      event_hash: eventHash,
      reason: "media_expired",
      ...overrides
    }
  };
}

function createStartedRuntime(
  supervisor: FakeSupervisor,
  readiness: () => MatrixRuntimeDependencyReadiness = readyDependencies,
  mediaFileSystem?: MatrixMediaFileSystem,
  runtimeConfig = config
) {
  const runtime = createMatrixRuntime({
    supervisor,
    config: runtimeConfig,
    readiness,
    now: () => roomPolicy.observedAtMs,
    ...(mediaFileSystem === undefined ? {} : { mediaFileSystem })
  });
  const observed: Array<Parameters<Parameters<typeof runtime.onIngress>[0]>[0]> = [];
  const rejected: Array<Parameters<Parameters<typeof runtime.onRejectedIngress>[0]>[0]> = [];
  runtime.onIngress((event) => {
    observed.push(event);
  });
  runtime.onRejectedIngress((rejection) => {
    rejected.push(rejection);
  });
  return { runtime, observed, rejected, start: () => runtime.start() };
}

function mediaReference(boot = CURRENT_BOOT, bytes = Buffer.from("%PDF-1.7\ncontent", "ascii")): MatrixIngressMedia {
  return Object.freeze({
    handle: `${boot}-${TOKEN}.pdf`,
    declaredMime: "application/pdf" as const,
    length: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  });
}

function stat(input: Readonly<{
  kind: "directory" | "file";
  dev: number;
  ino: number;
  size?: number;
  mode?: number;
  uid?: number;
  symlink?: boolean;
}>): MatrixMediaStat {
  return {
    mode: input.mode ?? (input.kind === "directory" ? 0o40700 : 0o100600),
    uid: input.uid ?? 501,
    size: input.size ?? 0,
    dev: input.dev,
    ino: input.ino,
    isFile: () => input.kind === "file",
    isDirectory: () => input.kind === "directory",
    isSymbolicLink: () => input.symlink === true
  };
}

function mediaFileSystem(
  bytes: Buffer,
  overrides: Readonly<{
    fileBefore?: MatrixMediaStat;
    fileAfter?: MatrixMediaStat;
    openedBefore?: MatrixMediaStat;
    openedAfter?: MatrixMediaStat;
    bootBefore?: MatrixMediaStat;
    bootAfter?: MatrixMediaStat;
    parentBefore?: MatrixMediaStat;
    parentAfter?: MatrixMediaStat;
    closeError?: Error;
  }> = {}
): Readonly<{ fileSystem: MatrixMediaFileSystem; paths: string[]; readTargets: Buffer[] }> {
  const parentBefore = overrides.parentBefore ?? stat({ kind: "directory", dev: 1, ino: 10 });
  const parentAfter = overrides.parentAfter ?? parentBefore;
  const bootBefore = overrides.bootBefore ?? stat({ kind: "directory", dev: 1, ino: 11 });
  const bootAfter = overrides.bootAfter ?? bootBefore;
  const fileBefore = overrides.fileBefore ?? stat({ kind: "file", dev: 1, ino: 12, size: bytes.byteLength });
  const fileAfter = overrides.fileAfter ?? fileBefore;
  const openedBefore = overrides.openedBefore ?? fileBefore;
  const openedAfter = overrides.openedAfter ?? openedBefore;
  let parentReads = 0;
  let bootReads = 0;
  let fileReads = 0;
  let handleStats = 0;
  const paths: string[] = [];
  const readTargets: Buffer[] = [];
  const handle: MatrixMediaFileHandle = {
    stat: async () => (handleStats++ === 0 ? openedBefore : openedAfter),
    read: async (target, offset, length, position) => {
      if (!readTargets.includes(target)) readTargets.push(target);
      const available = Math.max(0, bytes.byteLength - position);
      const count = Math.min(length, available);
      if (count > 0) bytes.copy(target, offset, position, position + count);
      return { bytesRead: count };
    },
    close: async () => {
      if (overrides.closeError !== undefined) throw overrides.closeError;
    }
  };
  return {
    paths,
    readTargets,
    fileSystem: {
      lstat: async (path) => {
        paths.push(path);
        if (path === SPOOL_PARENT) return parentReads++ === 0 ? parentBefore : parentAfter;
        if (path.startsWith(`${SPOOL_PARENT}/boot-`) && path.split("/").length === 4) {
          return bootReads++ === 0 ? bootBefore : bootAfter;
        }
        return fileReads++ === 0 ? fileBefore : fileAfter;
      },
      openNoFollow: async (path) => {
        paths.push(path);
        return handle;
      }
    }
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("binds the exact Matrix tuple and sends only while aggregate readiness is ready", async () => {
  const supervisor = new FakeSupervisor();
  let dependencies = readyDependencies();
  const { runtime, start } = createStartedRuntime(supervisor, () => dependencies);
  assert.deepEqual(supervisor.bindings, [{
    homeserverOrigin: config.homeserverUrl,
    roomId: config.roomId,
    ownerMxid: config.ownerMxid,
    botMxid: config.botMxid,
    botDeviceId: config.botDeviceId,
    mediaSpoolParent: SPOOL_PARENT
  }]);
  await start();
  const receipt = await runtime.send({
    transactionId: "session-4:message-9",
    body: "Повна відповідь.",
    formattedBody: "<p>Повна відповідь.</p>",
    relationEventId: "$question:matrix.org",
    roomPolicy
  });
  assert.deepEqual(receipt, { transactionId: "session-4:message-9", eventId: "$accepted:matrix.org", status: "accepted" });
  assert.equal(supervisor.requests.at(-1)?.method, "send");

  dependencies = { ...dependencies, mysqlAvailable: false };
  assert.equal(runtime.getReadiness().matrixReadiness, "not_ready");
  await assert.rejects(
    runtime.send({ transactionId: "tx-blocked", body: "body", roomPolicy }),
    (error: unknown) => error instanceof MatrixSidecarError && error.code === "not_ready"
  );
  assert.equal(supervisor.requests.length, 1);
  await runtime.stop();
});

test("does not call an alternate sidecar start implementation after the circuit is open", async () => {
  const supervisor = new FakeSupervisor();
  supervisor.status = Object.freeze({
    liveness: "dead",
    matrixReadiness: "not_ready",
    reason: "circuit_open",
    restartCount: 3,
    circuitOpen: true
  });
  const { runtime, start } = createStartedRuntime(supervisor);
  await start();
  await start();
  assert.equal(supervisor.starts, 0);
  assert.equal(runtime.getReadiness().circuitOpen, true);
  await runtime.stop();
});

test("rejects stale and future-dated room-policy snapshots before sidecar dispatch", async () => {
  const supervisor = new FakeSupervisor();
  const now = roomPolicy.observedAtMs;
  const runtime = createMatrixRuntime({ supervisor, config, readiness: readyDependencies, now: () => now });
  runtime.onIngress(() => undefined);
  runtime.onRejectedIngress(() => undefined);
  await runtime.start();
  for (const observedAtMs of [now - 60_001, now + 1]) {
    await assert.rejects(
      runtime.send({ transactionId: `tx-${observedAtMs}`, body: "body", roomPolicy: { ...roomPolicy, observedAtMs } }),
      (error: unknown) => error instanceof MatrixSidecarError && error.code === "invalid_configuration"
    );
  }
  assert.equal(supervisor.requests.length, 0);
  await runtime.stop();
});

test("requires one durable subscriber per ingress channel and reattaches both across stop/start", async () => {
  const supervisor = new FakeSupervisor();
  const runtime = createMatrixRuntime({ supervisor, config, readiness: readyDependencies });
  await assert.rejects(runtime.start(), (error: unknown) => error instanceof MatrixSidecarError && error.code === "invalid_configuration");
  const observed: unknown[] = [];
  const rejected: unknown[] = [];
  runtime.onIngress((event) => observed.push(event));
  assert.throws(() => runtime.onIngress(() => undefined), (error: unknown) => error instanceof MatrixSidecarError);
  await assert.rejects(runtime.start(), (error: unknown) => error instanceof MatrixSidecarError && error.code === "invalid_configuration");
  runtime.onRejectedIngress((rejection) => rejected.push(rejection));
  assert.throws(() => runtime.onRejectedIngress(() => undefined), (error: unknown) => error instanceof MatrixSidecarError);
  await runtime.start();
  supervisor.emit(ingress());
  supervisor.emitRejected(rejectionForIngress(ingress({}, "rejected-receipt-1")));
  await runtime.stop();
  await runtime.start();
  supervisor.emit(ingress({}, "ingress-receipt-2"));
  supervisor.emitRejected(rejectionForIngress(ingress({}, "rejected-receipt-2")));
  assert.equal(observed.length, 2);
  assert.equal(rejected.length, 2);
  assert.equal(supervisor.starts, 2);
  assert.equal(supervisor.stops, 1);
  await runtime.stop();
});

test("passes sender device identity, accepts identical crash replay, and fails closed on conflicting replay", async () => {
  const supervisor = new FakeSupervisor();
  const { runtime, observed, start } = createStartedRuntime(supervisor);
  await start();
  const original = ingress();
  supervisor.emit(original);
  supervisor.emit(original);
  assert.equal(observed.length, 2);
  assert.equal(observed[0]?.senderDeviceId, "OWNERDEVICE1");
  assert.equal(supervisor.failures, 0);
  supervisor.emit(ingress({ body: "changed" }));
  assert.equal(supervisor.failures, 1);
  await runtime.stop();
});

test("delivers frozen content-free media-expired rejections and retains their ACK binding across failure", async () => {
  const supervisor = new FakeSupervisor();
  const { runtime, rejected, start } = createStartedRuntime(supervisor);
  await start();
  const rejectedEvent = rejectionForIngress(ingress());
  assert.deepEqual({
    bodyHash: rejectedEvent.rejection.body_hash,
    mediaManifestHash: rejectedEvent.rejection.media_manifest_hash,
    eventHash: rejectedEvent.rejection.event_hash
  }, {
    bodyHash: "fed5c6182832a197b2433147d80fe6f0c519b624db11eb623cb9389c2d756e1c",
    mediaManifestHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    eventHash: "e03e974ff80ffc982e538b91c45babc8512d7dfe5c03b7377caf9599b23e55e0"
  });
  supervisor.emitRejected(rejectedEvent);
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0], {
    receiptId: "ingress-receipt-1",
    eventId: "$incoming:matrix.org",
    roomId: config.roomId,
    senderMxid: config.ownerMxid,
    senderDeviceId: "OWNERDEVICE1",
    bodyHash: rejectedEvent.rejection.body_hash,
    mediaManifestHash: rejectedEvent.rejection.media_manifest_hash,
    eventHash: rejectedEvent.rejection.event_hash,
    reason: "media_expired"
  });
  assert.equal(Object.isFrozen(rejected[0]), true);
  assert.equal(Object.hasOwn(rejected[0] as object, "body"), false);
  assert.equal(Object.hasOwn(rejected[0] as object, "media"), false);
  supervisor.ackFailure = new MatrixSidecarError("transport_failed");
  await assert.rejects(runtime.ackIngress({ receiptId: "ingress-receipt-1", durableReceiptId: "mysql-rejected" }));
  supervisor.ackFailure = undefined;
  await runtime.ackIngress({ receiptId: "ingress-receipt-1", durableReceiptId: "mysql-rejected" });
  assert.deepEqual(supervisor.acknowledgements.map((item) => item.eventId), [
    "$incoming:matrix.org",
    "$incoming:matrix.org"
  ]);
  await runtime.stop();
});

test("invalid-media rejection keeps its identity and reason through replay and ACK", async () => {
  const supervisor = new FakeSupervisor();
  const { runtime, observed, rejected, start } = createStartedRuntime(supervisor);
  await start();
  const rejection = rejectionForIngress(ingress(), { reason: "invalid_media" });
  supervisor.emitRejected(rejection);
  supervisor.emitRejected(rejection);
  assert.equal(observed.length, 0);
  assert.equal(rejected.length, 2);
  assert.equal(rejected[0]?.reason, "invalid_media");
  assert.equal(Object.hasOwn(rejected[0] as object, "body"), false);
  assert.equal(Object.hasOwn(rejected[0] as object, "media"), false);
  assert.equal(supervisor.failures, 0);
  await runtime.ackIngress({ receiptId: rejection.receiptId, durableReceiptId: String(rejection.rejection.event_hash) });
  assert.equal(supervisor.acknowledgements.at(-1)?.eventId, rejection.rejection.event_id);
  await runtime.stop();
});

test("Rust invalid-media fixture preserves canonical hashes, rejection ACK and following text in Node", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/matrix-invalid-media.json", import.meta.url), "utf8")) as {
    invalid_event: Readonly<Record<string, unknown>>;
    invalid_descriptor: Readonly<Record<string, unknown>>;
    invalid_rejection: Readonly<{ type: string; version: number; id: string; rejection: Readonly<Record<string, unknown>> }>;
    following_event: Readonly<Record<string, unknown>>;
  };
  const event = fixture.invalid_event;
  const descriptor = fixture.invalid_descriptor;
  const bodyHash = hashJson(event.body);
  // Invalid media has no validated normal manifest. Rust hashes its original
  // descriptor using serde_json's sorted object keys and sends only that hash.
  const mediaManifestHash = hashJson(Object.fromEntries(
    Object.entries(descriptor).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  ));
  const eventHash = hashJson({
    eventId: event.event_id,
    roomId: event.room_id,
    senderMxid: event.sender_mxid,
    senderDeviceId: event.sender_device_id,
    encrypted: true,
    bodyHash,
    relationEventId: event.reply_to_event_id,
    mediaManifestHash
  });
  const frame = fixture.invalid_rejection;
  assert.equal(frame.type, "event_rejected");
  assert.equal(frame.version, 1);
  assert.equal(frame.rejection.body_hash, bodyHash);
  assert.equal(frame.rejection.media_manifest_hash, mediaManifestHash);
  assert.equal(frame.rejection.event_hash, eventHash);
  assert.equal(frame.rejection.reason, "invalid_media");
  const supervisor = new FakeSupervisor();
  const { runtime, observed, rejected, start } = createStartedRuntime(supervisor, readyDependencies, undefined, {
    ...config, roomId: String(event.room_id), ownerMxid: String(event.sender_mxid)
  });
  await start();
  supervisor.emitRejected({ receiptId: frame.id, rejection: frame.rejection });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.eventHash, eventHash);
  assert.equal(observed.length, 0);
  await runtime.ackIngress({ receiptId: frame.id, durableReceiptId: eventHash });
  assert.deepEqual(supervisor.acknowledgements, [{
    receiptId: frame.id, eventId: event.event_id, durableReceiptId: eventHash
  }]);
  supervisor.emit({ receiptId: "fixture-next-valid", payload: fixture.following_event });
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.body, fixture.following_event.body);
  assert.equal(supervisor.failures, 0);
  await runtime.stop();
});

test("reconciles a matching normal-ingress to media-expired transition and rejects conflicting replay", async () => {
  const supervisor = new FakeSupervisor();
  const { runtime, observed, rejected, start } = createStartedRuntime(supervisor);
  await start();
  const original = ingress();
  const expiration = rejectionForIngress(original);
  supervisor.emit(original);
  supervisor.emitRejected(expiration);
  supervisor.emitRejected(expiration);
  assert.equal(observed.length, 1);
  assert.equal(rejected.length, 2);
  assert.equal(supervisor.failures, 0);
  supervisor.emitRejected(rejectionForIngress(original, { event_hash: "f".repeat(64) }));
  assert.equal(supervisor.failures, 1);
  supervisor.emit(original);
  assert.equal(supervisor.failures, 2);
  await runtime.ackIngress({ receiptId: original.receiptId, durableReceiptId: "mysql-expired" });
  assert.equal(supervisor.acknowledgements.at(-1)?.eventId, "$incoming:matrix.org");
  await runtime.stop();
});

test("fails closed on malformed or content-bearing rejection schemas", async (context) => {
  const base = ingress();
  const valid = rejectionForIngress(base);
  const cases: readonly [string, MatrixSidecarIngressRejection][] = [
    ["non-object wrapper", null as unknown as MatrixSidecarIngressRejection],
    ["wrapper metadata", { ...valid, metadata: {} }],
    ["unknown reason", rejectionForIngress(base, { reason: "other" })],
    ["uppercase hash", rejectionForIngress(base, { body_hash: "A".repeat(64) })],
    ["wrong room", rejectionForIngress(base, { room_id: "!other:matrix.org" })],
    ["missing device", (() => {
      const { sender_device_id: _removed, ...rejection } = valid.rejection;
      return { receiptId: valid.receiptId, rejection };
    })()],
    ["body", rejectionForIngress(base, { body: "plaintext" })],
    ["media", rejectionForIngress(base, { media: [] })],
    ["handles", rejectionForIngress(base, { handles: [] })],
    ["reply", rejectionForIngress(base, { reply_to_event_id: null })],
    ["path", rejectionForIngress(base, { path: "/private/plaintext" })],
    ["metadata", rejectionForIngress(base, { metadata: {} })]
  ];
  for (const [name, candidate] of cases) {
    await context.test(name, async () => {
      const supervisor = new FakeSupervisor();
      const { runtime, rejected, start } = createStartedRuntime(supervisor);
      await start();
      supervisor.emitRejected(candidate);
      assert.equal(rejected.length, 0);
      assert.equal(supervisor.failures, 1);
      await runtime.stop();
    });
  }
});

test("counts normal and rejected ingress against one pending bound", async () => {
  const supervisor = new FakeSupervisor();
  const { runtime, observed, rejected, start } = createStartedRuntime(supervisor);
  await start();
  for (let index = 0; index < 63; index += 1) {
    supervisor.emit(ingress({ event_id: `$event-${index}:matrix.org` }, `receipt-${index}`));
  }
  const rejectionSource = ingress({ event_id: "$expired:matrix.org" }, "receipt-expired");
  supervisor.emitRejected(rejectionForIngress(rejectionSource));
  supervisor.emit(ingress({ event_id: "$overflow:matrix.org" }, "receipt-overflow"));
  assert.equal(observed.length, 63);
  assert.equal(rejected.length, 1);
  assert.equal(supervisor.failures, 1);
  await runtime.stop();
});

test("fails closed when either durable subscriber is absent or rejects asynchronously", async () => {
  const supervisor = new FakeSupervisor();
  const runtime = createMatrixRuntime({ supervisor, config, readiness: readyDependencies });
  const unsubscribe = runtime.onIngress(async () => {
    throw new Error("db unavailable");
  });
  runtime.onRejectedIngress(() => undefined);
  await runtime.start();
  supervisor.emit(ingress());
  await turn();
  assert.equal(supervisor.failures, 1);
  unsubscribe();
  supervisor.emit(ingress({}, "ingress-receipt-2"));
  assert.equal(supervisor.failures, 2);
  await runtime.stop();

  const rejectionSupervisor = new FakeSupervisor();
  const rejectionRuntime = createMatrixRuntime({ supervisor: rejectionSupervisor, config, readiness: readyDependencies });
  rejectionRuntime.onIngress(() => undefined);
  const unsubscribeRejection = rejectionRuntime.onRejectedIngress(async () => {
    throw new Error("db unavailable");
  });
  await rejectionRuntime.start();
  rejectionSupervisor.emitRejected(rejectionForIngress(ingress()));
  await turn();
  assert.equal(rejectionSupervisor.failures, 1);
  unsubscribeRejection();
  rejectionSupervisor.emitRejected(rejectionForIngress(ingress({}, "rejected-receipt-2")));
  assert.equal(rejectionSupervisor.failures, 2);
  await rejectionRuntime.stop();
});

test("keeps ingress pending when ACK fails so the exact durable ACK can be retried", async () => {
  const supervisor = new FakeSupervisor();
  const { runtime, start } = createStartedRuntime(supervisor);
  await start();
  supervisor.emit(ingress());
  supervisor.ackFailure = new MatrixSidecarError("transport_failed");
  await assert.rejects(runtime.ackIngress({ receiptId: "ingress-receipt-1", durableReceiptId: "mysql-7" }));
  supervisor.ackFailure = undefined;
  await runtime.ackIngress({ receiptId: "ingress-receipt-1", durableReceiptId: "mysql-7" });
  assert.equal(supervisor.acknowledgements.length, 2);
  assert.equal(supervisor.acknowledgements[1]?.eventId, "$incoming:matrix.org");
  await runtime.stop();
});

test("strictly inspects then reads current- or prior-boot media authorized by the pending ingress frame", async (context) => {
  for (const [name, boot] of [["current", CURRENT_BOOT], ["replay", REPLAY_BOOT]] as const) {
    await context.test(name, async () => {
      const bytes = Buffer.from("%PDF-1.7\ncontent", "ascii");
      const media = mediaReference(boot, bytes);
      const fs = mediaFileSystem(bytes);
      const supervisor = new FakeSupervisor();
      const { runtime, observed, start } = createStartedRuntime(supervisor, readyDependencies, fs.fileSystem);
      await start();
      supervisor.emit(ingress({
        body: null,
        media: [{ handle: media.handle, declared_mime: media.declaredMime, length: media.length, sha256: media.sha256 }]
      }));
      const event = observed[0];
      assert.ok(event);
      const objects = await runtime.readMedia(event.media);
      assert.deepEqual(objects[0]?.bytes, bytes);
      assert.strictEqual(objects[0]?.bytes, fs.readTargets[0]);
      assert.equal(fs.readTargets[0]?.byteLength, bytes.byteLength);
      assert.deepEqual(supervisor.requests[0], {
        method: "inspect_media",
        params: { media: [{ handle: media.handle, declared_mime: media.declaredMime, length: media.length, sha256: media.sha256 }] }
      });
      assert.equal(JSON.stringify(supervisor.requests).includes(SPOOL_PARENT), false);
      assert.ok(fs.paths.every((path) =>
        path === SPOOL_PARENT
        || path === `${SPOOL_PARENT}/boot-${boot}`
        || path.startsWith(`${SPOOL_PARENT}/boot-${boot}/`)
      ));
      assert.ok(fs.paths.includes(`${SPOOL_PARENT}/boot-${boot}/${media.handle}`));
      await runtime.stop();
    });
  }
});

test("rejects path-shaped and pending-frame-absent handles without sending a caller path over NDJSON", async () => {
  const supervisor = new FakeSupervisor();
  const { runtime, start } = createStartedRuntime(supervisor);
  await start();
  supervisor.emit(ingress({ media: [{
    handle: "../device-binding.json",
    declared_mime: "application/pdf",
    length: 5,
    sha256: "a".repeat(64)
  }] }));
  assert.equal(supervisor.failures, 1);
  assert.equal(supervisor.requests.length, 0);

  const other = "d".repeat(32);
  const bytes = Buffer.from("%PDF-x", "ascii");
  const pendingMedia = mediaReference(other, bytes);
  const absentMedia = Object.freeze({
    ...pendingMedia,
    handle: `${other}-${"e".repeat(24)}.pdf`
  });
  supervisor.emit(ingress({
    event_id: "$other:matrix.org",
    body: null,
    media: [{
      handle: pendingMedia.handle,
      declared_mime: pendingMedia.declaredMime,
      length: pendingMedia.length,
      sha256: pendingMedia.sha256
    }]
  }, "ingress-receipt-other"));
  await assert.rejects(
    runtime.readMedia([absentMedia]),
    (error: unknown) => error instanceof MatrixSidecarError && error.code === "invalid_configuration"
  );
  assert.equal(supervisor.requests.length, 0);
  assert.equal(JSON.stringify(supervisor.requests).includes(SPOOL_PARENT), false);
  await runtime.stop();
});

test("fails closed on media symlink, path race, size, hash, and MIME-magic violations", async (context) => {
  const bytes = Buffer.from("%PDF-1.7\ncontent", "ascii");
  const good = mediaReference(CURRENT_BOOT, bytes);
  const cases: readonly [string, MatrixIngressMedia, ReturnType<typeof mediaFileSystem>][] = [
    ["symlink", good, mediaFileSystem(bytes, {
      fileBefore: stat({ kind: "file", dev: 1, ino: 12, size: bytes.length, symlink: true })
    })],
    ["race", good, mediaFileSystem(bytes, {
      fileAfter: stat({ kind: "file", dev: 1, ino: 99, size: bytes.length })
    })],
    ["size", good, mediaFileSystem(bytes, {
      fileBefore: stat({ kind: "file", dev: 1, ino: 12, size: bytes.length + 1 })
    })],
    ["hash", { ...good, sha256: "f".repeat(64) }, mediaFileSystem(bytes)],
    ["close", good, mediaFileSystem(bytes, { closeError: new Error("test-only close failure") })],
    ["magic", {
      ...good,
      handle: `${CURRENT_BOOT}-${TOKEN}.png`,
      declaredMime: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex")
    }, mediaFileSystem(bytes)]
  ];
  for (const [name, media, fs] of cases) {
    await context.test(name, async () => {
      const supervisor = new FakeSupervisor();
      const { runtime, observed, start } = createStartedRuntime(supervisor, readyDependencies, fs.fileSystem);
      await start();
      supervisor.emit(ingress({
        event_id: `$${name}:matrix.org`,
        body: null,
        media: [{ handle: media.handle, declared_mime: media.declaredMime, length: media.length, sha256: media.sha256 }]
      }, `receipt-${name}`));
      const event = observed[0];
      assert.ok(event);
      await assert.rejects(runtime.readMedia(event.media), (error: unknown) => error instanceof MatrixSidecarError && error.code === "protocol_error");
      assert.equal(supervisor.requests[0]?.method, "inspect_media");
      assert.equal(supervisor.failures, 1);
      assert.ok(fs.readTargets.every((target) => target.every((byte) => byte === 0)));
      await runtime.stop();
    });
  }
});

test("wipes earlier verified media if a later object in the batch fails", async () => {
  const bytes = Buffer.from("%PDF-1.7\ncontent", "ascii");
  const first = mediaReference(CURRENT_BOOT, bytes);
  const second = Object.freeze({
    ...mediaReference(CURRENT_BOOT, bytes),
    handle: `${CURRENT_BOOT}-${"d".repeat(24)}.pdf`,
    sha256: "f".repeat(64)
  });
  const fs = mediaFileSystem(bytes);
  const supervisor = new FakeSupervisor();
  const { runtime, observed, start } = createStartedRuntime(supervisor, readyDependencies, fs.fileSystem);
  await start();
  supervisor.emit(ingress({
    body: null,
    media: [first, second].map((item) => ({
      handle: item.handle,
      declared_mime: item.declaredMime,
      length: item.length,
      sha256: item.sha256
    }))
  }));
  const event = observed[0];
  assert.ok(event);
  await assert.rejects(
    runtime.readMedia(event.media),
    (error: unknown) => error instanceof MatrixSidecarError && error.code === "protocol_error"
  );
  assert.equal(fs.readTargets.length, 2);
  assert.ok(fs.readTargets.every((target) => target.every((byte) => byte === 0)));
  await runtime.stop();
});

test("rejects media object and aggregate bounds before binary dispatch", async () => {
  const supervisor = new FakeSupervisor();
  const { runtime, observed, start } = createStartedRuntime(supervisor);
  await start();
  const oversized = {
    handle: `${CURRENT_BOOT}-${TOKEN}.pdf`,
    declared_mime: "application/pdf",
    length: 20 * 1024 * 1024 + 1,
    sha256: "a".repeat(64)
  };
  supervisor.emit(ingress({ body: null, media: [oversized] }));
  assert.equal(observed.length, 0);
  assert.equal(supervisor.failures, 1);

  const aggregate = Array.from({ length: 4 }, (_, index) => ({
    handle: `${String(index + 1).repeat(32)}-${TOKEN}.pdf`,
    declared_mime: "application/pdf",
    length: 17 * 1024 * 1024,
    sha256: String(index + 1).repeat(64)
  }));
  supervisor.emit(ingress({ event_id: "$aggregate:matrix.org", body: null, media: aggregate }, "aggregate-receipt"));
  assert.equal(observed.length, 0);
  assert.equal(supervisor.failures, 2);
  assert.equal(supervisor.requests.length, 0);
  await runtime.stop();
});

test("fails closed on malformed acceptance and rejects non-matrix.org configuration", async () => {
  const supervisor = new FakeSupervisor();
  const { runtime, start } = createStartedRuntime(supervisor);
  await start();
  supervisor.sendResult = { name: "accepted", event_id: "$event:matrix.org", extra: true };
  await assert.rejects(
    runtime.send({ transactionId: "tx-1", body: "body", roomPolicy }),
    (error: unknown) => error instanceof MatrixSidecarError && error.code === "protocol_error"
  );
  assert.equal(supervisor.failures, 1);
  await runtime.stop();

  assert.throws(() => createMatrixRuntime({
    supervisor: new FakeSupervisor(),
    config: { ...config, homeserverUrl: "https://example.org" },
    readiness: readyDependencies
  }), (error: unknown) => error instanceof MatrixSidecarError && error.code === "invalid_configuration");
  assert.throws(() => createMatrixRuntime({
    supervisor: new FakeSupervisor(),
    config: { ...config, authorizedReplayBootIds: [REPLAY_BOOT] },
    readiness: readyDependencies
  }), (error: unknown) => error instanceof MatrixSidecarError && error.code === "invalid_configuration");
});
