import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { Worker } from "node:worker_threads";

import { isSecretLikeMatrixContent } from "../matrix/bridge.ts";
import type { MatrixIngressMedia, MatrixIngressMediaObject } from "./matrix-runtime.ts";
import type { DurableMatrixMediaConsumer } from "./matrix-service.ts";
import { MySqlKeyValueStorage, type MySqlPool } from "./mysql-storage.ts";

const DOMAIN = "matrix-consultation-media-v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const CHUNK_BYTES = 128 * 1_024;
const MAX_OBJECT_BYTES = 20 * 1_024 * 1_024;
const MAX_BATCH_BYTES = 64 * 1_024 * 1_024;
const MAX_PENDING_EVENTS = 64;
export const MATRIX_CONSULTATION_MEDIA_TTL_MS = 15 * 60 * 1_000;

export type MatrixConsultationMediaManifest = readonly Readonly<Pick<MatrixIngressMedia, "declaredMime" | "length" | "sha256">>[];
export type MatrixConsultationMediaObject = Readonly<MatrixConsultationMediaManifest[number] & { bytes: Buffer }>;
export type MatrixConsultationMediaLoadResult =
  | Readonly<{
    ok: true;
    objects: readonly MatrixConsultationMediaObject[];
    /** This is staging, not classification, OCR, or permission to call an AI provider. */
    requiresDocumentConfirmation: true;
    release: () => void;
  }>
  | Readonly<{ ok: false; code: "unavailable" | "expired" | "rejected" | "mismatch" }>;

type Pending = Readonly<{ eventHash: string; expiresAtMs: number; length: number }>;
type Index = Readonly<{ version: 1; pending: readonly Pending[] }>;
type RecordValue = Readonly<{
  version: 1;
  eventHash: string;
  manifest: MatrixConsultationMediaManifest;
  manifestHash: string;
  consumptionReceiptHash: string;
  expiresAtMs: number;
  status: "pending" | "expired" | "rejected" | "erased";
}>;
type Chunk = Readonly<{ iv: string; ciphertext: string; tag: string }>;

const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const recordKey = (eventHash: string): string => `record-${eventHash}`;
const chunkKey = (eventHash: string, object: number, chunk: number): string => `chunk-${eventHash}-${object}-${chunk}`;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (): Error => new Error("Matrix attachment staging is unavailable.");

function manifestValue(value: unknown): MatrixConsultationMediaManifest | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return undefined;
  const result: MatrixConsultationMediaManifest[number][] = [];
  for (const item of value) {
    if (!isRecord(item) || !["image/png", "image/jpeg", "application/pdf", "audio/ogg"].includes(item.declaredMime as string)
      || !Number.isSafeInteger(item.length) || (item.length as number) < 1 || (item.length as number) > MAX_OBJECT_BYTES
      || typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) return undefined;
    result.push(Object.freeze({ declaredMime: item.declaredMime as MatrixIngressMedia["declaredMime"], length: item.length as number, sha256: item.sha256 }));
  }
  if (result.reduce((total, item) => total + item.length, 0) > MAX_BATCH_BYTES) return undefined;
  return Object.freeze(result);
}

function detectedMime(bytes: Buffer): MatrixIngressMedia["declaredMime"] | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 5 && [0x25, 0x50, 0x44, 0x46, 0x2d].every((value, index) => bytes[index] === value)) return "application/pdf";
  if (bytes.length >= 4 && [0x4f, 0x67, 0x67, 0x53].every((value, index) => bytes[index] === value)) return "audio/ogg";
  return undefined;
}

/** Accessible metadata/text is only a negative gate, never evidence that a binary document is safe. */
function containsAccessibleSecret(bytes: Buffer): boolean {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  let paymentCard = false;
  for (const [candidate] of text.matchAll(/\b(?:\d[ -]?){13,19}\b/gu)) {
    const digits = candidate.replace(/[ -]/gu, "");
    // PDF xref offsets are not payment cards. Require an issuer prefix and
    // checksum instead of treating every long number (including offsets) as one.
    if (!/^(?:4|5[1-5]|3[47]|6(?:011|5)|2[2-7])/u.test(digits)) continue;
    let sum = 0;
    for (let index = digits.length - 1, alternate = false; index >= 0; index -= 1, alternate = !alternate) {
      let digit = Number(digits[index]);
      if (alternate) { digit *= 2; if (digit > 9) digit -= 9; }
      sum += digit;
    }
    if (sum % 10 === 0) { paymentCard = true; break; }
  }
  return isSecretLikeMatrixContent(text)
    || /(?:password|passwd|client_secret|access_token|refresh_token|api[_ -]?key)\s*[:=]\s*["']?\S{4,}/iu.test(text)
    || /\b(?:UA\d{27}|[A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/u.test(text)
    || /\b(?:passport|tax[_ ]?id|ssn|social security)\s*[:=]\s*\S{4,}/iu.test(text)
    || paymentCard;
}

function readIndex(value: unknown): Index {
  if (value === undefined) return { version: 1, pending: [] };
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.pending) || value.pending.length > MAX_PENDING_EVENTS) throw invalid();
  const pending: Pending[] = [];
  for (const item of value.pending) {
    if (!isRecord(item) || typeof item.eventHash !== "string" || !SHA256.test(item.eventHash)
      || !Number.isSafeInteger(item.expiresAtMs) || (item.expiresAtMs as number) <= 0
      || !Number.isSafeInteger(item.length) || (item.length as number) <= 0 || (item.length as number) > MAX_BATCH_BYTES) throw invalid();
    pending.push({ eventHash: item.eventHash, expiresAtMs: item.expiresAtMs as number, length: item.length as number });
  }
  if (new Set(pending.map((item) => item.eventHash)).size !== pending.length || pending.reduce((sum, item) => sum + item.length, 0) > MAX_BATCH_BYTES) throw invalid();
  return { version: 1, pending };
}

function readRecord(value: unknown, eventHash: string): RecordValue | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.version !== 1 || value.eventHash !== eventHash
    || !["pending", "expired", "rejected", "erased"].includes(value.status as string)
    || !Number.isSafeInteger(value.expiresAtMs) || (value.expiresAtMs as number) <= 0) throw invalid();
  const manifest = manifestValue(value.manifest);
  if (manifest === undefined) throw invalid();
  const manifestHash = digest(JSON.stringify(manifest));
  const consumptionReceiptHash = digest(`${DOMAIN}:${eventHash}:${manifestHash}`);
  if (value.manifestHash !== manifestHash || value.consumptionReceiptHash !== consumptionReceiptHash) throw invalid();
  return { version: 1, eventHash, manifest, manifestHash, consumptionReceiptHash, expiresAtMs: value.expiresAtMs as number, status: value.status as RecordValue["status"] };
}

function chunkAad(record: RecordValue, object: number, chunk: number): Buffer {
  return Buffer.from(JSON.stringify([DOMAIN, record.eventHash, record.manifestHash, record.expiresAtMs, object, chunk]));
}

async function deleteChunks(storage: MySqlKeyValueStorage, record: RecordValue): Promise<void> {
  for (const [objectIndex, object] of record.manifest.entries()) {
    for (let chunkIndex = 0; chunkIndex < Math.ceil(object.length / CHUNK_BYTES); chunkIndex += 1) {
      await storage.delete(chunkKey(record.eventHash, objectIndex, chunkIndex));
    }
  }
}

/**
 * Private, short-lived encrypted staging in the existing MySQL KV table.
 * consume commits all encrypted chunks before returning the sidecar ACK receipt.
 * It does not parse/render PDF, perform OCR, grant consent, or contact a provider.
 * Call purgeExpired from the application's bounded maintenance loop, including
 * while idle, and release every successful load as soon as its caller is done.
 */
export function createMySqlMatrixConsultationMediaStore(input: Readonly<{
  pool: MySqlPool;
  encryptionKey: Uint8Array;
  now?: () => number;
}>) {
  if (!(input.encryptionKey instanceof Uint8Array) || input.encryptionKey.byteLength !== 32) throw invalid();
  const key = Buffer.from(input.encryptionKey);
  const storage = new MySqlKeyValueStorage({ executor: input.pool, namespace: DOMAIN });
  const now = input.now ?? Date.now;
  let closed = false;
  const loadedBuffers = new Set<() => void>();
  const currentTime = (): number => {
    const value = now();
    if (closed || !Number.isSafeInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER - MATRIX_CONSULTATION_MEDIA_TTL_MS) throw invalid();
    return value;
  };

  const expire = async (transaction: MySqlKeyValueStorage, index: Index, timestamp: number): Promise<Index> => {
    const pending: Pending[] = [];
    for (const item of index.pending) {
      if (item.expiresAtMs > timestamp) { pending.push(item); continue; }
      const record = readRecord(await transaction.get(recordKey(item.eventHash)), item.eventHash);
      if (record === undefined || record.status !== "pending" || record.expiresAtMs !== item.expiresAtMs) throw invalid();
      await deleteChunks(transaction, record);
      await transaction.put(recordKey(item.eventHash), { ...record, status: "expired" });
    }
    const result: Index = { version: 1, pending };
    await transaction.put("pending-index", result);
    return result;
  };

  const consume: DurableMatrixMediaConsumer = async (value) => {
    const timestamp = currentTime();
    if (!SHA256.test(value.eventHash)) throw invalid();
    const manifest = manifestValue(value.event.media);
    if (manifest === undefined || value.objects.length !== manifest.length
      || new Set(value.event.media.map((item) => item.handle)).size !== manifest.length) throw invalid();
    const expectedEventHash = digest(JSON.stringify({
      eventId: value.event.eventId, roomId: value.event.roomId, senderMxid: value.event.senderMxid,
      senderDeviceId: value.event.senderDeviceId, encrypted: true,
      bodyHash: digest(JSON.stringify(value.event.body)), relationEventId: value.event.relationEventId ?? null,
      mediaManifestHash: digest(JSON.stringify(manifest))
    }));
    if (value.eventHash !== expectedEventHash) throw invalid();
    const owned: Buffer[] = [];
    let rejected = false;
    try {
      for (const [index, expected] of manifest.entries()) {
        const object: MatrixIngressMediaObject | undefined = value.objects[index];
        const extension = expected.declaredMime === "image/jpeg" ? "jpg" : expected.declaredMime === "image/png" ? "png" : expected.declaredMime === "application/pdf" ? "pdf" : "ogg";
        if (object === undefined || !Buffer.isBuffer(object.bytes) || object.bytes.length !== expected.length
          || object.handle !== value.event.media[index]?.handle || object.declaredMime !== expected.declaredMime
          || !/^[a-f0-9]{32}-[a-f0-9]{24}\.(?:jpg|png|pdf|ogg)$/u.test(object.handle) || !object.handle.endsWith(`.${extension}`)
          || object.sha256 !== expected.sha256 || object.length !== expected.length) throw invalid();
        const bytes = Buffer.from(object.bytes);
        owned.push(bytes);
        if (digest(bytes) !== expected.sha256 || detectedMime(bytes) !== expected.declaredMime) throw invalid();
        // A valid transport event containing a secret is a durable denial,
        // not a transient consumer failure. Persist metadata without bytes and
        // return its receipt so ACK can release the sidecar queue for Stop/new
        // inputs. Only invalid transport integrity above throws for retry.
        // Binary audio cannot be inspected as text. The ordinary body and the
        // later transcript still pass the same secret gate before any advice.
        rejected ||= expected.declaredMime === "audio/ogg" ? false : containsAccessibleSecret(bytes);
      }
      const manifestHash = digest(JSON.stringify(manifest));
      const record: RecordValue = {
        version: 1, eventHash: value.eventHash, manifest, manifestHash,
        consumptionReceiptHash: digest(`${DOMAIN}:${value.eventHash}:${manifestHash}`),
        expiresAtMs: timestamp + MATRIX_CONSULTATION_MEDIA_TTL_MS,
        status: rejected ? "rejected" : "pending"
      };
      return await storage.transaction(async (transaction) => {
        const index = await expire(transaction, readIndex(await transaction.get("pending-index")), timestamp);
        const previous = readRecord(await transaction.get(recordKey(value.eventHash)), value.eventHash);
        if (previous !== undefined) {
          if (previous.manifestHash !== manifestHash) throw invalid();
          return Object.freeze({ eventHash: value.eventHash, consumptionReceiptHash: previous.consumptionReceiptHash });
        }
        if (!rejected) {
          const length = manifest.reduce((sum, item) => sum + item.length, 0);
          if (index.pending.length >= MAX_PENDING_EVENTS || index.pending.reduce((sum, item) => sum + item.length, 0) + length > MAX_BATCH_BYTES) throw invalid();
          for (const [objectIndex, bytes] of owned.entries()) {
            for (let offset = 0, chunkIndex = 0; offset < bytes.length; offset += CHUNK_BYTES, chunkIndex += 1) {
              const iv = randomBytes(12);
              const cipher = createCipheriv("aes-256-gcm", key, iv);
              cipher.setAAD(chunkAad(record, objectIndex, chunkIndex));
              const ciphertext = Buffer.concat([cipher.update(bytes.subarray(offset, offset + CHUNK_BYTES)), cipher.final()]);
              const chunk: Chunk = { iv: Buffer.from(iv).toString("base64"), ciphertext: ciphertext.toString("base64"), tag: Buffer.from(cipher.getAuthTag()).toString("base64") };
              await transaction.put(chunkKey(record.eventHash, objectIndex, chunkIndex), chunk);
            }
          }
          await transaction.put("pending-index", { version: 1, pending: [...index.pending, { eventHash: record.eventHash, expiresAtMs: record.expiresAtMs, length }] });
        }
        if (currentTime() >= record.expiresAtMs) throw invalid();
        await transaction.put(recordKey(value.eventHash), record);
        return Object.freeze({ eventHash: value.eventHash, consumptionReceiptHash: record.consumptionReceiptHash });
      });
    } finally {
      for (const bytes of owned) bytes.fill(0);
    }
  };

  const load = async (eventHash: string, expectedManifest: MatrixConsultationMediaManifest): Promise<MatrixConsultationMediaLoadResult> => {
    const owned: Buffer[] = [];
    const release = (): void => { for (const bytes of owned) bytes.fill(0); loadedBuffers.delete(release); };
    try {
      const timestamp = currentTime();
      const manifest = manifestValue(expectedManifest);
      if (!SHA256.test(eventHash) || manifest === undefined) return { ok: false, code: "mismatch" };
      return await storage.transaction(async (transaction): Promise<MatrixConsultationMediaLoadResult> => {
        const index = await expire(transaction, readIndex(await transaction.get("pending-index")), timestamp);
        const record = readRecord(await transaction.get(recordKey(eventHash)), eventHash);
        if (record === undefined) return { ok: false, code: "unavailable" };
        if (record.manifestHash !== digest(JSON.stringify(manifest))) return { ok: false, code: "mismatch" };
        if (record.status === "expired") return { ok: false, code: "expired" };
        if (record.status !== "pending") return { ok: false, code: "rejected" };
        if (!index.pending.some((item) => item.eventHash === eventHash && item.expiresAtMs === record.expiresAtMs)) throw invalid();
        const objects: MatrixConsultationMediaObject[] = [];
        for (const [objectIndex, metadata] of record.manifest.entries()) {
          const bytes = Buffer.alloc(metadata.length);
          owned.push(bytes);
          for (let offset = 0, chunkIndex = 0; offset < bytes.length; offset += CHUNK_BYTES, chunkIndex += 1) {
            const chunk = await transaction.get<unknown>(chunkKey(eventHash, objectIndex, chunkIndex));
            if (!isRecord(chunk) || typeof chunk.iv !== "string" || typeof chunk.ciphertext !== "string" || typeof chunk.tag !== "string"
              || chunk.iv.length !== 16 || chunk.tag.length !== 24 || chunk.ciphertext.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw invalid();
            const iv = Buffer.from(chunk.iv, "base64");
            const tag = Buffer.from(chunk.tag, "base64");
            const ciphertext = Buffer.from(chunk.ciphertext, "base64");
            if (iv.length !== 12 || tag.length !== 16 || ciphertext.length !== Math.min(CHUNK_BYTES, bytes.length - offset)
              || iv.toString("base64") !== chunk.iv || tag.toString("base64") !== chunk.tag || ciphertext.toString("base64") !== chunk.ciphertext) throw invalid();
            const decipher = createDecipheriv("aes-256-gcm", key, iv);
            decipher.setAAD(chunkAad(record, objectIndex, chunkIndex));
            decipher.setAuthTag(tag);
            let plain: Buffer | undefined;
            try {
              plain = decipher.update(ciphertext);
              decipher.final();
              bytes.set(plain, offset);
            } finally { plain?.fill(0); }
          }
          if (digest(bytes) !== metadata.sha256 || detectedMime(bytes) !== metadata.declaredMime
            || (metadata.declaredMime !== "audio/ogg" && containsAccessibleSecret(bytes))) throw invalid();
          objects.push(Object.freeze({ ...metadata, bytes }));
        }
        if (currentTime() >= record.expiresAtMs) throw invalid();
        loadedBuffers.add(release);
        return Object.freeze({ ok: true, objects: Object.freeze(objects), requiresDocumentConfirmation: true, release });
      });
    } catch {
      release();
      return { ok: false, code: "unavailable" };
    }
  };

  return Object.freeze({
    consume,
    load,
    async erase(eventHash: string, reason: "rejected" | "processed" | "cancelled"): Promise<void> {
      currentTime();
      if (!SHA256.test(eventHash) || !["rejected", "processed", "cancelled"].includes(reason)) throw invalid();
      await storage.transaction(async (transaction) => {
        const index = readIndex(await transaction.get("pending-index"));
        const record = readRecord(await transaction.get(recordKey(eventHash)), eventHash);
        if (record === undefined) return;
        await deleteChunks(transaction, record);
        await transaction.put(recordKey(eventHash), { ...record, status: reason === "rejected" ? "rejected" : "erased" });
        await transaction.put("pending-index", { version: 1, pending: index.pending.filter((item) => item.eventHash !== eventHash) });
      });
    },
    async purgeExpired(): Promise<void> {
      const timestamp = currentTime();
      await storage.transaction(async (transaction) => { await expire(transaction, readIndex(await transaction.get("pending-index")), timestamp); });
    },
    close(): void { closed = true; key.fill(0); for (const release of loadedBuffers) release(); }
  });
}

export type MatrixConsultationMediaStore = ReturnType<typeof createMySqlMatrixConsultationMediaStore>;

export type MatrixConsultationPdfResult =
  | Readonly<{ ok: true; text: string; totalPages: number; contentMode: "text_only" }>
  | Readonly<{ ok: false; code: "unsupported_pdf" | "scanned_pdf" | "secret_content" | "limit_exceeded" | "timed_out" | "cancelled" | "unavailable" }>;

// Fixed trusted worker source; neither PDF text nor caller options enter code.
// The serverless parser runs on this worker's event loop, so a parent-owned
// termination timer, rather than Promise.race inside the parser, bounds CPU.
const PDF_TEXT_WORKER = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
globalThis.fetch = () => Promise.reject(new Error("Network is disabled."));
globalThis.XMLHttpRequest = undefined;
(async () => {
  let task;
  const data = new Uint8Array(workerData.bytes);
  try {
    const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1")
      .replace(/#([a-fA-F0-9]{2})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
    if (/\/(?:Encrypt|JavaScript|JS|AA|OpenAction|Launch|RichMedia|EmbeddedFile|Filespec|XFA|AcroForm)(?=[\s/<>\[\](){}%]|$)/.test(raw)) {
      parentPort.postMessage({ ok: false, code: "unsupported_pdf" }); return;
    }
    const { getDocument } = await import(workerData.moduleUrl);
    task = getDocument({
      data, verbosity: 0, isEvalSupported: false, enableXfa: false,
      useSystemFonts: false, disableFontFace: true, useWasm: false,
      useWorkerFetch: false, disableRange: true, disableStream: true,
      disableAutoFetch: true, stopAtErrors: true, maxImageSize: 16777216,
      isOffscreenCanvasSupported: false, isImageDecoderSupported: false
    });
    task.onPassword = () => { void task.destroy(); };
    const pdf = await task.promise;
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 20) {
      parentPort.postMessage({ ok: false, code: "limit_exceeded" }); return;
    }
    const metadata = await pdf.getMetadata();
    const attachments = await pdf.getAttachments();
    const actions = await pdf.getJSActions();
    const fields = await pdf.getFieldObjects();
    if (pdf.isPureXfa || metadata.info?.IsXFAPresent || metadata.info?.IsAcroFormPresent
      || attachments !== null || actions !== null || fields !== null
      || await pdf.getOpenAction() !== null || await pdf.getPermissions() !== null) {
      parentPort.postMessage({ ok: false, code: "unsupported_pdf" }); return;
    }
    const metadataText = JSON.stringify({ info: metadata.info, metadata: metadata.metadata?.getAll() ?? null });
    if (Buffer.byteLength(metadataText, "utf8") > 65536) {
      parentPort.postMessage({ ok: false, code: "limit_exceeded" }); return;
    }
    let text = "";
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const pageActions = await page.getJSActions();
      const annotations = await page.getAnnotations({ intent: "any" });
      if (page.isPureXfa || pageActions !== null || annotations.some((annotation) =>
        annotation.actions || annotation.file || annotation.richMedia
        || ["Widget", "FileAttachment", "RichMedia", "Screen"].includes(annotation.subtype))) {
        parentPort.postMessage({ ok: false, code: "unsupported_pdf" }); return;
      }
      const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
      let pageText = "";
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          for (const item of next.value.items) {
            if (typeof item.str !== "string") continue;
            pageText += item.str + (item.hasEOL ? "\n" : " ");
            if (Buffer.byteLength(text, "utf8") + Buffer.byteLength(pageText, "utf8") > 65536) {
              parentPort.postMessage({ ok: false, code: "limit_exceeded" }); return;
            }
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
      // Do not silently omit image-only pages from a mixed/scanned document.
      if (pageText.trim().length === 0) {
        parentPort.postMessage({ ok: false, code: "scanned_pdf" }); return;
      }
      text += (text ? "\n\n" : "") + pageText.trim();
      page.cleanup();
    }
    if (Buffer.byteLength(text, "utf8") > 65536) {
      parentPort.postMessage({ ok: false, code: "limit_exceeded" }); return;
    }
    parentPort.postMessage({ ok: true, text, totalPages: pdf.numPages, metadataText });
  } catch { parentPort.postMessage({ ok: false, code: "unsupported_pdf" }); }
  finally {
    if (task) await task.destroy().catch(() => {});
    try { data.fill(0); } catch {}
  }
})().catch(() => parentPort.postMessage({ ok: false, code: "unsupported_pdf" }));
`;

let pdfWorkerActive = false;

/**
 * Call only after the dispatcher has validated explicit per-document consent.
 * No remote OCR, rendering, URL loading, model call, or inherited environment.
 * The result deliberately says text_only: it is not a visual interpretation.
 */
export async function extractPdfForConsultation(
  bytes: Uint8Array,
  options: Readonly<{ signal?: AbortSignal; timeoutMilliseconds?: number }> = {}
): Promise<MatrixConsultationPdfResult> {
  if (options.signal?.aborted) return { ok: false, code: "cancelled" };
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_OBJECT_BYTES) return { ok: false, code: "limit_exceeded" };
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (detectedMime(view) !== "application/pdf") return { ok: false, code: "unsupported_pdf" };
  if (containsAccessibleSecret(view)) return { ok: false, code: "secret_content" };
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 5_000;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 5_000 || pdfWorkerActive) return { ok: false, code: "unavailable" };
  pdfWorkerActive = true;
  const owned = new Uint8Array(bytes);
  try {
    const worker = new Worker(PDF_TEXT_WORKER, {
      eval: true,
      workerData: { bytes: owned.buffer, moduleUrl: import.meta.resolve("unpdf/pdfjs") },
      transferList: [owned.buffer],
      env: {}, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
    });
    // Parser diagnostics may include document text. Never forward them to logs.
    worker.stdout?.resume(); worker.stderr?.resume();
    return await new Promise<MatrixConsultationPdfResult>((resolve) => {
      let settled = false;
      const finish = (result: MatrixConsultationPdfResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        void worker.terminate().then(() => resolve(result), () => resolve({ ok: false, code: "unavailable" }));
      };
      const abort = (): void => finish({ ok: false, code: "cancelled" });
      const timer = setTimeout(() => finish({ ok: false, code: "timed_out" }), timeoutMilliseconds);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      worker.on("error", () => finish({ ok: false, code: "unavailable" }));
      worker.on("exit", () => finish({ ok: false, code: "unavailable" }));
      worker.on("message", (message: unknown) => {
        if (!isRecord(message)) { finish({ ok: false, code: "unavailable" }); return; }
        if (message.ok === false && ["unsupported_pdf", "scanned_pdf", "limit_exceeded"].includes(message.code as string)) {
          finish({ ok: false, code: message.code as "unsupported_pdf" | "scanned_pdf" | "limit_exceeded" }); return;
        }
        if (message.ok !== true || typeof message.text !== "string" || message.text.trim().length === 0
          || Buffer.byteLength(message.text) > 65_536 || typeof message.metadataText !== "string" || Buffer.byteLength(message.metadataText) > 65_536
          || !Number.isSafeInteger(message.totalPages) || (message.totalPages as number) < 1 || (message.totalPages as number) > 20) {
          finish({ ok: false, code: "unavailable" }); return;
        }
        if (containsAccessibleSecret(Buffer.from(message.text)) || containsAccessibleSecret(Buffer.from(message.metadataText))) {
          finish({ ok: false, code: "secret_content" }); return;
        }
        finish({ ok: true, text: message.text, totalPages: message.totalPages as number, contentMode: "text_only" });
      });
    });
  } catch {
    return { ok: false, code: "unavailable" };
  } finally {
    // Transfer detaches this copy; a failed constructor leaves it owned here.
    if (owned.byteLength > 0) owned.fill(0);
    pdfWorkerActive = false;
  }
}
