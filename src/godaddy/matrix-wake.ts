import { createHash, timingSafeEqual } from "node:crypto";

export const MATRIX_WAKE_PATH = "/_matrix/push/v1/notify";
export const MATRIX_WAKE_APP_ID = "ai.personal-consultant.matrix";
export const MATRIX_WAKE_MAX_BYTES = 16 * 1024;
const MAX_DEVICES = 16;
const MAX_RECEIPTS = 1024;
const RECEIPT_TTL_MS = 5 * 60_000;

export type MatrixWakeConfiguration = Readonly<{ roomId: string; pushKey: string; appId: string }>;
export type MatrixWakeGateway = Readonly<{ handle: (request: Request) => Promise<Response> }>;

/** Opt-in Published only. No browser cookie, Matrix access token or model credentials here. */
export function parseMatrixWakeConfiguration(environment: Record<string, unknown>): MatrixWakeConfiguration | undefined {
  if (environment.RUNTIME_MODE !== "production" || environment.GODADDY_STATE_DATABASE_ROLE !== "published"
    || typeof environment.MATRIX_WAKE_ENABLED !== "string" || environment.MATRIX_WAKE_ENABLED.toLowerCase() !== "true"
    || (environment.MATRIX_SETUP_MODE !== undefined && environment.MATRIX_SETUP_MODE !== "disabled")
    || typeof environment.MATRIX_ROOM_ID !== "string" || !/^![^\s:]{1,255}:[^\s]{1,255}$/u.test(environment.MATRIX_ROOM_ID)
    || typeof environment.MATRIX_WAKE_PUSH_KEY !== "string" || !/^[a-f0-9]{64}$/u.test(environment.MATRIX_WAKE_PUSH_KEY)) return undefined;
  return Object.freeze({ roomId: environment.MATRIX_ROOM_ID, pushKey: environment.MATRIX_WAKE_PUSH_KEY, appId: MATRIX_WAKE_APP_ID });
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const response = (status: number): Response => Response.json({ rejected: [] }, {
  status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff",
    ...(status === 503 || status === 429 ? { "retry-after": "5" } : {}) }
});

async function readBounded(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MATRIX_WAKE_MAX_BYTES)) throw new Error("body_limit");
  const reader = request.body?.getReader();
  if (reader === undefined) throw new Error("body_required");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { void reader.cancel().catch(() => undefined); reject(new Error("body_timeout")); }, 2_000);
    });
    while (true) {
      const chunk = await Promise.race([reader.read(), expired]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MATRIX_WAKE_MAX_BYTES) throw new Error("body_limit");
      chunks.push(chunk.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Untrusted wake hints only. The callback must start/check the existing E2EE
 * transport and return true only when its authenticated handoff is ready.
 * It must NOT ingest this notification as a user request or call an agent.
 */
export function createMatrixWakeGateway(input: Readonly<{
  configuration: MatrixWakeConfiguration;
  wake: () => Promise<boolean>;
  now?: () => number;
  handoffTimeoutMs?: number;
}>): MatrixWakeGateway {
  const now = input.now ?? Date.now;
  const timeoutMs = input.handoffTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error("Invalid wake timeout.");
  const secret = Buffer.from(input.configuration.pushKey, "utf8");
  const receipts = new Map<string, number>();
  let handoff: Promise<boolean> | undefined;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let readers = 0;
  let waitingHandoffs = 0;

  return Object.freeze({ async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== MATRIX_WAKE_PATH || url.search !== "" || request.method !== "POST") return response(404);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      || (request.headers.get("content-encoding") ?? "identity") !== "identity") return response(415);
    if (readers >= 4) return response(429);
    readers += 1;
    let value: unknown;
    try { value = await readBounded(request); }
    catch { return response(400); }
    finally { readers -= 1; }
    if (!record(value) || !record(value.notification)) return response(400);
    const notification = value.notification;
    // Synapse adds prio even in event_id_only mode. Its count-only badge
    // update also has empty legacy id/sender and a null type. Accept these
    // content-free variants, never a full message notification.
    if (Object.keys(notification).some((key) => !["event_id", "room_id", "counts", "devices", "prio", "id", "sender", "type"].includes(key))
      || (notification.prio !== undefined && notification.prio !== "high" && notification.prio !== "low")
      || (notification.id !== undefined && notification.id !== "")
      || (notification.sender !== undefined && notification.sender !== "")
      || (notification.type !== undefined && notification.type !== null)) return response(400);
    if (!Array.isArray(notification.devices) || notification.devices.length < 1 || notification.devices.length > MAX_DEVICES) return response(400);
    let authenticated = false;
    for (const device of notification.devices) {
      if (!record(device) || typeof device.pushkey !== "string" || device.pushkey.length > 512) return response(400);
      const key = Buffer.from(device.pushkey, "utf8");
      const matches = key.byteLength === secret.byteLength && timingSafeEqual(key, secret);
      if (matches && device.app_id === input.configuration.appId) authenticated = true;
    }
    // Never return a valid pushkey in `rejected`: homeservers delete those pushers.
    if (!authenticated) return response(403);
    // Count-only notifications need no sync or agent work.
    if (notification.event_id === undefined && notification.room_id === undefined) return response(200);
    // Pushers are account-scoped: another room's existing rules may notify
    // this gateway too. Acknowledge-and-ignore an authenticated foreign-room
    // hint so it cannot poison the homeserver's ordered retry queue. No wake.
    if (notification.room_id !== input.configuration.roomId) return response(200);
    if (typeof notification.event_id !== "string" || !/^\$[^\s]{1,254}$/u.test(notification.event_id)) return response(400);
    const eventHash = createHash("sha256").update(notification.event_id).digest("hex");
    const timestamp = now();
    for (const [key, expires] of receipts) if (expires <= timestamp) receipts.delete(key);
    if (receipts.has(eventHash)) return response(200);
    if (waitingHandoffs >= 16) return response(429);
    if (handoff === undefined) {
      if (timestamp - lastAttempt < 1_000) return response(429);
      lastAttempt = timestamp;
      const started = Promise.resolve().then(input.wake).then((ready) => ready === true, () => false);
      handoff = started;
      void started.finally(() => { if (handoff === started) handoff = undefined; });
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    waitingHandoffs += 1;
    try {
      const ready = await Promise.race([handoff, new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      })]);
      if (!ready) return response(503);
      // This is a bounded in-memory wake receipt, not a durable message ACK.
      // Real event dedupe/cursor commits remain in authenticated Matrix ingress.
      if (receipts.size >= MAX_RECEIPTS) receipts.delete(receipts.keys().next().value!);
      receipts.set(eventHash, now() + RECEIPT_TTL_MS);
      return response(200);
    } finally {
      waitingHandoffs -= 1;
      if (timeout !== undefined) clearTimeout(timeout);
    }
  } });
}
