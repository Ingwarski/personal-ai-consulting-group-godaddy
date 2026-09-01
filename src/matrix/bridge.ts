import type { ConfirmedAgentMessage } from "../session/registrar-do.ts";
import { validateRoomInvariant, type MatrixRoomState, type RoomBinding } from "./room-invariant.ts";

export type RawMatrixIngress = Readonly<{
  eventId: string;
  roomId: string;
  senderMxid: string;
  senderDeviceId: string;
  body: string;
  encrypted: boolean;
}>;

export type MatrixIngressEvent = Readonly<{
  eventId: string;
  roomId: string;
  ownerMxid: string;
  body: string;
}>;

export type MatrixIngressResult =
  | Readonly<{ ok: true; value: MatrixIngressEvent }>
  | Readonly<{
      ok: false;
      code:
        | "room_invariant_failed"
        | "wrong_room"
        | "sender_not_owner"
        | "sender_device_unverified"
        | "sender_device_revoked"
        | "sender_device_unknown"
        | "device_trust_unavailable"
        | "event_not_encrypted"
        | "invalid_event"
        | "secret_like_content";
    }>;

export type MatrixDelivery = Readonly<{
  roomId: string;
  body: string;
  formattedBody: string;
  format: "org.matrix.custom.html";
  replyToEventId?: string;
}>;

export type MatrixDeliveryReceipt = Readonly<{
  generation: number;
  sequence: number;
  bodyHash: string;
  transactionId: string;
  matrixEventId: string;
}>;

export interface MatrixDeliveryReceiptStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface MatrixE2eeDeliveryClient {
  send(input: Readonly<{ delivery: MatrixDelivery; transactionId: string }>): Promise<Readonly<{ eventId: string }>>;
}

export type MatrixDeviceTrust = "verified" | "unverified" | "revoked" | "unknown";

/**
 * The bridge adapter must resolve trust from the Matrix crypto store. Trust is
 * intentionally not accepted as caller-supplied event metadata.
 */
export interface MatrixDeviceTrustResolver {
  resolveOwnerDevice(input: Readonly<{ ownerMxid: string; deviceId: string }>): Promise<MatrixDeviceTrust>;
  ownerDeliveryIsSafe(input: Readonly<{ ownerMxid: string }>): Promise<boolean>;
}

export type MatrixPublicationResult =
  | Readonly<{ ok: true; receipt: MatrixDeliveryReceipt; replayed: boolean }>
  | Readonly<{
      ok: false;
      code:
        | "receipt_conflict"
        | "owner_delivery_not_trusted"
        | "device_trust_unavailable"
        | "matrix_send_failed"
        | "invalid_matrix_event_id"
        | "receipt_store_failed";
    }>;

const secretLikePatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:OPENAI|ANTHROPIC)_API_KEY\s*=/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i
];

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const renderInlineMarkdown = (value: string): string =>
  escapeHtml(value).replace(/\*\*(?=\S)(.+?\S)\*\*/g, "<strong>$1</strong>");

/** Render only the Markdown constructs emitted by this product. */
const renderMarkdownParagraphs = (body: string): string => {
  const lines = body.split("\n");
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.trim().length === 0) {
      index += 1;
      continue;
    }

    const heading = /^(#{2,3})[ \t]+(.+)$/.exec(lines[index] ?? "");
    if (heading !== null) {
      const level = heading[1]?.length;
      output.push(`<h${level}>${renderInlineMarkdown(heading[2] ?? "")}</h${level}>`);
      index += 1;
      continue;
    }

    const ordered = /^\d+\.[ \t]+(.+)$/.exec(lines[index] ?? "");
    const unordered = /^[-*][ \t]+(.+)$/.exec(lines[index] ?? "");
    if (ordered !== null || unordered !== null) {
      const tag = ordered !== null ? "ol" : "ul";
      const pattern = ordered !== null ? /^\d+\.[ \t]+(.+)$/ : /^[-*][ \t]+(.+)$/;
      const items: string[] = [];
      while (index < lines.length) {
        const item = pattern.exec(lines[index] ?? "");
        if (item === null) break;
        items.push(`<li>${renderInlineMarkdown(item[1] ?? "")}</li>`);
        index += 1;
      }
      output.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line.trim().length === 0 || /^(?:#{2,3}[ \t]+|\d+\.[ \t]+|[-*][ \t]+)/.test(line)) break;
      paragraph.push(renderInlineMarkdown(line));
      index += 1;
    }
    output.push(`<p>${paragraph.join("<br>")}</p>`);
  }
  return output.join("");
};

const deliveryKey = (message: ConfirmedAgentMessage): string =>
  `matrix-delivery:${message.generation}:${message.sequence}`;

const transactionIdFor = (message: ConfirmedAgentMessage): string =>
  `pc-${message.generation}-${message.sequence}-${message.bodyHash.slice(0, 24)}`;

const validMatrixEventId = (value: string): boolean => /^\$[A-Za-z0-9$:_-]{8,255}$/.test(value);

export async function validateMatrixIngress(
  binding: RoomBinding,
  roomState: MatrixRoomState,
  raw: RawMatrixIngress,
  deviceTrust: MatrixDeviceTrustResolver
): Promise<MatrixIngressResult> {
  const roomInvariant = validateRoomInvariant(binding, roomState);
  if (!roomInvariant.ok) return { ok: false, code: "room_invariant_failed" };
  if (!raw.encrypted) return { ok: false, code: "event_not_encrypted" };
  if (raw.roomId !== binding.roomId) return { ok: false, code: "wrong_room" };
  if (raw.senderMxid !== binding.ownerMxid) return { ok: false, code: "sender_not_owner" };
  if (
    !/^[A-Za-z0-9$:_-]{8,255}$/.test(raw.eventId) ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(raw.senderDeviceId) ||
    raw.body.length === 0
  ) {
    return { ok: false, code: "invalid_event" };
  }
  let trust: MatrixDeviceTrust;
  try {
    trust = await deviceTrust.resolveOwnerDevice({ ownerMxid: binding.ownerMxid, deviceId: raw.senderDeviceId });
  } catch {
    return { ok: false, code: "device_trust_unavailable" };
  }
  if (trust === "revoked") return { ok: false, code: "sender_device_revoked" };
  if (trust === "unverified") return { ok: false, code: "sender_device_unverified" };
  if (trust === "unknown") return { ok: false, code: "sender_device_unknown" };
  if (secretLikePatterns.some((pattern) => pattern.test(raw.body))) {
    return { ok: false, code: "secret_like_content" };
  }
  return {
    ok: true,
    value: Object.freeze({
      eventId: raw.eventId,
      roomId: raw.roomId,
      ownerMxid: raw.senderMxid,
      body: raw.body
    })
  };
}

export function formatConfirmedMessageForMatrix(
  binding: RoomBinding,
  message: ConfirmedAgentMessage,
  replyToEventId?: string
): MatrixDelivery {
  const header = `${message.role} · ${message.visibleTime}`;
  return Object.freeze({
    roomId: binding.roomId,
    body: `${header}\n\n${message.body}`,
    formattedBody: `<strong>${escapeHtml(header)}</strong>${renderMarkdownParagraphs(message.body)}`,
    format: "org.matrix.custom.html",
    ...(replyToEventId === undefined ? {} : { replyToEventId })
  });
}

/**
 * Delivery accepts only a Registrar-confirmed body. The stable transaction id
 * lets the Matrix client make a retry idempotent even if a crash occurs after
 * send and before the local receipt write. Nothing here decrypts, edits or
 * generates Matrix content; the E2EE client in the bridge container owns that.
 */
export class MatrixConfirmedMessagePublisher {
  readonly #binding: RoomBinding;
  readonly #client: MatrixE2eeDeliveryClient;
  readonly #receipts: MatrixDeliveryReceiptStore;
  readonly #deviceTrust: MatrixDeviceTrustResolver;

  constructor(input: Readonly<{
    binding: RoomBinding;
    client: MatrixE2eeDeliveryClient;
    receipts: MatrixDeliveryReceiptStore;
    deviceTrust: MatrixDeviceTrustResolver;
  }>) {
    this.#binding = input.binding;
    this.#client = input.client;
    this.#receipts = input.receipts;
    this.#deviceTrust = input.deviceTrust;
  }

  async publish(message: ConfirmedAgentMessage, replyToEventId?: string): Promise<MatrixPublicationResult> {
    const key = deliveryKey(message);
    const existing = await this.#receipts.get<MatrixDeliveryReceipt>(key);
    if (existing !== undefined) {
      if (existing.bodyHash !== message.bodyHash) return { ok: false, code: "receipt_conflict" };
      return { ok: true, receipt: existing, replayed: true };
    }
    try {
      if (!await this.#deviceTrust.ownerDeliveryIsSafe({ ownerMxid: this.#binding.ownerMxid })) {
        return { ok: false, code: "owner_delivery_not_trusted" };
      }
    } catch {
      return { ok: false, code: "device_trust_unavailable" };
    }
    const transactionId = transactionIdFor(message);
    let sent: Readonly<{ eventId: string }>;
    try {
      sent = await this.#client.send({ delivery: formatConfirmedMessageForMatrix(this.#binding, message, replyToEventId), transactionId });
    } catch {
      return { ok: false, code: "matrix_send_failed" };
    }
    if (!validMatrixEventId(sent.eventId)) return { ok: false, code: "invalid_matrix_event_id" };
    const receipt = Object.freeze({
      generation: message.generation,
      sequence: message.sequence,
      bodyHash: message.bodyHash,
      transactionId,
      matrixEventId: sent.eventId
    });
    try {
      await this.#receipts.put(key, receipt);
    } catch {
      return { ok: false, code: "receipt_store_failed" };
    }
    return { ok: true, receipt, replayed: false };
  }
}
