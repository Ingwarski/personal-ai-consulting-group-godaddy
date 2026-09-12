import type { ConfirmedAgentMessage } from "../session/registrar-do.ts";
import { validateRoomInvariant, type MatrixRoomState, type RoomBinding } from "./room-invariant.ts";
import { CONSULTANT_COLOUR_SLOTS, HEAD_CONSULTANT, resolveConsultantRole } from "../consilium/consultant-roles.ts";

export type MatrixRolePresentation = Readonly<{
  language?: string;
  /** Slot from the persisted session roster, never derived by hashing a role. */
  roleColorSlot?: number;
  /** Only enable after verifying the client preserves foreground AND background. */
  supportsRoleColours?: boolean;
}>;

export type RawMatrixIngress = Readonly<{
  eventId: string;
  roomId: string;
  senderMxid: string;
  senderDeviceId: string;
  body: string | null;
  relationEventId?: string;
  media?: readonly Readonly<{
    handle: string;
    declaredMime: "image/jpeg" | "image/png" | "application/pdf" | "audio/ogg";
    length: number;
    sha256: string;
  }>[];
  encrypted: boolean;
}>;

export type MatrixIngressMediaMetadata = Readonly<{
  declaredMime: "image/jpeg" | "image/png" | "application/pdf" | "audio/ogg";
  length: number;
  sha256: string;
}>;

export type MatrixIngressEvent = Readonly<{
  eventId: string;
  roomId: string;
  ownerMxid: string;
  senderDeviceId: string;
  body: string | null;
  relationEventId?: string;
  media: readonly MatrixIngressMediaMetadata[];
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

type MatrixIngressFailureCode = Extract<MatrixIngressResult, Readonly<{ ok: false }>>["code"];

export type MatrixDelivery = Readonly<{
  roomId: string;
  body: string;
  formattedBody: string;
  format: "org.matrix.custom.html";
  replyToEventId?: string;
}>;

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
  ownerDeliveryIsSafe(input: Readonly<{
    roomId: string;
    ownerMxid: string;
    botMxid: string;
    botDeviceId: string;
    homeserver: "matrix.org";
  }>): Promise<boolean>;
}

export interface MatrixRoomStateResolver {
  resolveCurrentRoom(binding: RoomBinding): Promise<MatrixRoomState>;
}

export interface MatrixIngressReceiptPort {
  persistIntent(input: Readonly<{
    eventId: string;
    eventHash: string;
    roomId: string;
    ownerMxid: string;
    bodyHash: string;
    workIntent: MatrixIngressEvent;
    mediaManifestHash: string;
    requiresMediaConsumption: boolean;
    now: Date;
  }>): Promise<
    | Readonly<{ ok: true; replayed: boolean; durableAck: boolean; processed: boolean }>
    | Readonly<{ ok: false; code: "event_conflict" }>
  >;
  persistRejection?: (input: Readonly<{
    eventId: string;
    eventHash: string;
    roomId: string;
    ownerMxid: string;
    bodyHash: string;
    mediaManifestHash: string;
    rejectionCode: "secret_like_content";
    now: Date;
  }>) => Promise<
    | Readonly<{ ok: true; replayed: boolean; durableAck: boolean; processed: false }>
    | Readonly<{ ok: false; code: "event_conflict" }>
  >;
  acknowledge(eventId: string, eventHash: string, now: Date): Promise<boolean>;
  markMediaConsumed(input: Readonly<{
    eventId: string;
    eventHash: string;
    mediaManifestHash: string;
    consumptionReceiptHash: string;
    now: Date;
  }>): Promise<boolean>;
}

export type DurableMatrixIngressResult =
  | Readonly<{
      ok: true;
      event: MatrixIngressEvent;
      eventHash: string;
      mediaManifestHash: string;
      replayed: boolean;
      workQueued: boolean;
      durableAck: boolean;
      processed: boolean;
      ephemeralMedia: readonly Readonly<{ handle: string; sha256: string }>[];
    }>
  | Readonly<{
      ok: false;
      code: "secret_like_content";
      durableRejection?: Readonly<{
        eventId: string;
        eventHash: string;
        replayed: boolean;
        durableAck: boolean;
      }>;
    }>
  | Readonly<{
      ok: false;
      code: Exclude<MatrixIngressFailureCode, "secret_like_content"> | "event_conflict" | "receipt_store_failed";
    }>;

export type LeasedMatrixPublication = Readonly<{
  generation: number;
  sequence: number;
  transactionId: string;
  message: ConfirmedAgentMessage;
  replyToEventId?: string;
  leaseOwner: string;
  leaseEpoch: number;
  attemptCount: number;
}>;

export interface MatrixOrderedOutboxPort {
  leaseHead(input: Readonly<{ leaseOwner: string; now: Date; leaseMilliseconds: number }>): Promise<LeasedMatrixPublication | undefined>;
  markAccepted(lease: LeasedMatrixPublication, matrixEventId: string, now: Date): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: "stale_lease" }>>;
  markBlocked(lease: LeasedMatrixPublication, errorCode: string, now: Date): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: "stale_lease" }>>;
  releaseTransient(lease: LeasedMatrixPublication, errorCode: string, now: Date, backoffMilliseconds: number): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: "stale_lease" }>>;
}

const secretLikePatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:OPENAI|ANTHROPIC)_API_KEY\s*=/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  // Match assigned values, not discussion about configuring these fields.
  /(?<![\p{L}\p{N}_])(?:[A-Z][A-Z0-9_]*_)?(?:password|passwd|pwd|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|oauth[_ -]?token|api[_ -]?key|session[_ -]?(?:key|token)|csrf[_ -]?(?:key|token))["']?\s*[:=]\s*["']?[^\s"',;<>]{1,}/iu,
  /(?<![\p{L}\p{N}_])(?:пароль|секрет(?:ний ключ| клієнта)?|клієнтський секрет|токен(?: доступу| оновлення| авторизації)?|ключ (?:доступу|API))["']?\s*[:=]\s*["']?[^\s"',;<>]{1,}/iu,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,2048}\.[A-Za-z0-9_-]{2,8192}\.[A-Za-z0-9_-]{8,2048}(?![A-Za-z0-9_-])/u,
  // Government identifiers require an explicit label; an ordinary long
  // business number or PDF xref offset is not an identity document.
  /(?<![\p{L}\p{N}_])(?:passport(?: number)?|tax[_ -]?id|government[_ -]?id|national[_ -]?id|ssn|social security(?: number)?|паспорт(?:ний номер| номер)?|номер паспорта|РНОКПП|ІПН|ідентифікаційний(?: код| номер)|податковий номер)["']?\s*[:=№]\s*["']?(?:[A-ZА-ЯІЇЄҐ]{1,3}[ -]?)?\d(?:[A-ZА-ЯІЇЄҐ0-9 -]{3,20}\d)/iu,
  // A labeled IBAN is sensitive even if it contains a transcription error.
  /\bIBAN["']?\s*[:=]\s*["']?[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/iu
];

function isPaymentCardNumber(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/gu, "");
  const prefix4 = Number(digits.slice(0, 4));
  const issuerMatches = /^4\d{12}(?:\d{3})?(?:\d{3})?$/u.test(digits) ||
    /^5[1-5]\d{14}$/u.test(digits) || (digits.length === 16 && prefix4 >= 2221 && prefix4 <= 2720) ||
    /^3[47]\d{13}$/u.test(digits) || /^(?:6011\d{12,15}|65\d{14,17}|64[4-9]\d{13,16})$/u.test(digits) ||
    (digits.length >= 16 && digits.length <= 19 && prefix4 >= 3528 && prefix4 <= 3589);
  if (!issuerMatches) return false;
  let checksum = 0;
  for (let index = digits.length - 1, double = false; index >= 0; index -= 1, double = !double) {
    let digit = Number(digits[index]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    checksum += digit;
  }
  return checksum % 10 === 0;
}

function isChecksumValidIban(candidate: string): boolean {
  const compact = candidate.replace(/[ -]/gu, "").toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  const reordered = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of reordered) {
    const decimal = /[A-Z]/u.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of decimal) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Bounded conservative negative gate, not proof that arbitrary content is
 * non-sensitive. Rejection must discard the entire emission; never redact an
 * agent's words and then pretend that altered text was its confirmed message. */
export function isSecretLikeMatrixContent(body: string): boolean {
  if (secretLikePatterns.some(pattern => pattern.test(body))) return true;
  for (const [candidate] of body.matchAll(/(?<!\d)(?<!\d[ -])\d(?:[ -]?\d){12,18}(?![ -]?\d)/gu)) {
    if (isPaymentCardNumber(candidate)) return true;
  }
  for (const [candidate] of body.matchAll(/(?<![A-Z0-9])[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}(?![A-Z0-9])/giu)) {
    // The bounded match may include the next prose word. Check only complete
    // groups, never a prefix cut out of an uninterrupted account/serial token.
    let prefix = candidate;
    while (prefix.length >= 15) {
      if (isChecksumValidIban(prefix)) return true;
      const boundary = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("-"));
      if (boundary < 4) break;
      prefix = prefix.slice(0, boundary);
    }
  }
  return false;
}

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

const validMatrixEventId = (value: string): boolean => /^\$[A-Za-z0-9$:_-]{8,255}$/.test(value);

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type MatrixDeliveryEvidence = Readonly<{
  kind: "device_delivery" | "owner_read";
  evidenceId: string;
  evidenceHash: string;
  matrixEventId: string;
  roomId: string;
  ownerMxid: string;
  ownerDeviceId: string;
  observedAt: string;
}>;

export async function matrixDeliveryEvidenceHash(
  evidence: Omit<MatrixDeliveryEvidence, "evidenceHash">
): Promise<string> {
  return sha256(evidence);
}

export interface MatrixDeliveryEvidencePort {
  markDeviceDelivered(evidence: MatrixDeliveryEvidence): Promise<boolean>;
  markRead(evidence: MatrixDeliveryEvidence): Promise<boolean>;
}

export class MatrixDeliveryEvidenceRecorder {
  readonly #binding: RoomBinding;
  readonly #roomState: MatrixRoomStateResolver | undefined;
  readonly #deviceTrust: MatrixDeviceTrustResolver | undefined;
  readonly #outbox: MatrixDeliveryEvidencePort;

  constructor(input: Readonly<{
    binding: RoomBinding;
    roomState?: MatrixRoomStateResolver;
    deviceTrust?: MatrixDeviceTrustResolver;
    outbox: MatrixDeliveryEvidencePort;
  }>) {
    this.#binding = input.binding;
    this.#roomState = input.roomState;
    this.#deviceTrust = input.deviceTrust;
    this.#outbox = input.outbox;
  }

  async record(evidence: MatrixDeliveryEvidence): Promise<boolean> {
    if (this.#roomState === undefined || this.#deviceTrust === undefined) return false;
    if (
      evidence.roomId !== this.#binding.roomId || evidence.ownerMxid !== this.#binding.ownerMxid ||
      !validMatrixEventId(evidence.matrixEventId) ||
      await matrixDeliveryEvidenceHash({
        kind: evidence.kind,
        evidenceId: evidence.evidenceId,
        matrixEventId: evidence.matrixEventId,
        roomId: evidence.roomId,
        ownerMxid: evidence.ownerMxid,
        ownerDeviceId: evidence.ownerDeviceId,
        observedAt: evidence.observedAt
      }) !== evidence.evidenceHash
    ) return false;
    let room: MatrixRoomState;
    try {
      room = await this.#roomState.resolveCurrentRoom(this.#binding);
      if (!validateRoomInvariant(this.#binding, room).ok) return false;
      if (await this.#deviceTrust.resolveOwnerDevice({
        ownerMxid: evidence.ownerMxid,
        deviceId: evidence.ownerDeviceId
      }) !== "verified") return false;
    } catch {
      return false;
    }
    return evidence.kind === "device_delivery"
      ? this.#outbox.markDeviceDelivered(evidence)
      : this.#outbox.markRead(evidence);
  }
}

function validateSidecarEnvelope(binding: RoomBinding, raw: RawMatrixIngress): MatrixIngressResult {
  if (!raw.encrypted) return { ok: false, code: "event_not_encrypted" };
  if (raw.roomId !== binding.roomId) return { ok: false, code: "wrong_room" };
  if (raw.senderMxid !== binding.ownerMxid) return { ok: false, code: "sender_not_owner" };
  const media = raw.media ?? [];
  const validMedia = media.length <= 4 && media.every((item) =>
    /^[A-Za-z0-9._:-]{1,64}$/.test(item.handle) &&
    ["image/jpeg", "image/png", "application/pdf", "audio/ogg"].includes(item.declaredMime) &&
    Number.isSafeInteger(item.length) && item.length > 0 && item.length <= 20 * 1024 * 1024 &&
    /^[a-f0-9]{64}$/.test(item.sha256)
  ) && media.reduce((sum, item) => sum + item.length, 0) <= 64 * 1024 * 1024;
  if (
    !validMatrixEventId(raw.eventId) ||
    !/^[\x21-\x7e]{1,255}$/u.test(raw.senderDeviceId) ||
    (raw.body !== null && (raw.body.length === 0 || raw.body.includes("\0") || new TextEncoder().encode(raw.body).byteLength > 65_536)) ||
    (raw.body === null && media.length === 0) || !validMedia ||
    (raw.relationEventId !== undefined && !validMatrixEventId(raw.relationEventId))
  ) {
    return { ok: false, code: "invalid_event" };
  }
  if (raw.body !== null && isSecretLikeMatrixContent(raw.body)) {
    return { ok: false, code: "secret_like_content" };
  }
  return {
    ok: true,
    value: Object.freeze({
      eventId: raw.eventId,
      roomId: raw.roomId,
      ownerMxid: raw.senderMxid,
      senderDeviceId: raw.senderDeviceId,
      body: raw.body,
      ...(raw.relationEventId === undefined ? {} : { relationEventId: raw.relationEventId }),
      media: Object.freeze(media.map(({ declaredMime, length, sha256: mediaSha256 }) =>
        Object.freeze({ declaredMime, length, sha256: mediaSha256 })
      ))
    })
  };
}

/**
 * Validates the Node-owned envelope and content policy after the checksum-
 * pinned Rust sidecar has already verified E2EE, room state and sender trust.
 */
export function validateSidecarMatrixIngress(
  binding: RoomBinding,
  raw: RawMatrixIngress
): MatrixIngressResult {
  return validateSidecarEnvelope(binding, raw);
}

export async function validateMatrixIngress(
  binding: RoomBinding,
  roomState: MatrixRoomState,
  raw: RawMatrixIngress,
  deviceTrust: MatrixDeviceTrustResolver
): Promise<MatrixIngressResult> {
  const roomInvariant = validateRoomInvariant(binding, roomState);
  if (!roomInvariant.ok) return { ok: false, code: "room_invariant_failed" };
  const envelope = validateSidecarEnvelope(binding, raw);
  if (!envelope.ok) return envelope;
  let trust: MatrixDeviceTrust;
  try {
    trust = await deviceTrust.resolveOwnerDevice({ ownerMxid: binding.ownerMxid, deviceId: raw.senderDeviceId });
  } catch {
    return { ok: false, code: "device_trust_unavailable" };
  }
  if (trust === "revoked") return { ok: false, code: "sender_device_revoked" };
  if (trust === "unverified") return { ok: false, code: "sender_device_unverified" };
  if (trust === "unknown") return { ok: false, code: "sender_device_unknown" };
  return envelope;
}

export function formatConfirmedMessageForMatrix(
  binding: RoomBinding,
  message: ConfirmedAgentMessage,
  replyToEventId?: string,
  presentation?: MatrixRolePresentation
): MatrixDelivery {
  const content = formatConfirmedMessageContentForMatrix(message, presentation);
  return Object.freeze({
    roomId: binding.roomId,
    ...content,
    format: "org.matrix.custom.html",
    ...(replyToEventId === undefined ? {} : { replyToEventId })
  });
}

export function formatConfirmedMessageContentForMatrix(
  message: ConfirmedAgentMessage,
  presentation?: MatrixRolePresentation
): Readonly<{ body: string; formattedBody: string }> {
  // Keep the registrar's immutable control identity/hash intact. The visible
  // label identifies the head's coordination function without presenting an
  // automatic status notice as a model-authored specialist or Critic reply.
  const service = ["Система", "System", "Service"].includes(message.role) && message.authority === undefined;
  const known = service ? HEAD_CONSULTANT : resolveConsultantRole(message.role);
  const language = (presentation?.language ?? message.language ?? "uk").split("-")[0];
  const serviceLabel = ({ uk: "службове повідомлення", en: "service notice", ru: "служебное сообщение", es: "aviso de servicio",
    fr: "message de service", de: "Statusmeldung", pl: "komunikat systemowy" } as Record<string, string>)[language!] ?? "service notice";
  const observationLabel = ({ uk: "спостереження із зображення", en: "image observation", ru: "наблюдение по изображению", es: "observación de imagen",
    fr: "observation d’image", de: "Bildbeobachtung", pl: "obserwacja obrazu" } as Record<string, string>)[language!] ?? "image observation";
  const visibleRole = known === undefined ? message.role : `${known.emoji} ${known.role}`;
  const addressedRoles = message.addressedTo?.split("; ").map(role => resolveConsultantRole(role)?.role ?? role).join("; ");
  const stageKind = String(message.consensusKind);
  const proposalForReview = stageKind === "proposal" && addressedRoles !== undefined;
  const addressee = addressedRoles === undefined || proposalForReview ? "" : ` → ${addressedRoles}`;
  // A Critic message must be visually unmistakable in a long consultation.
  // The final is possible only after that review has been durably recorded, so
  // its header states that fact without altering the exact agreed answer body.
  const stageLabels: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    en: { proposal: "Candidate for review", final: "Approved after Critic review", unresolved: "Unresolved", safety_handoff: "Safety handoff", critic_review: "Critic review", specialist_review: "Specialist review", head_review: "Head review" },
    uk: { proposal: "Пропозиція для перевірки", final: "Погоджено після перевірки Критика", unresolved: "Без консенсусу", safety_handoff: "Допомога людини для безпеки", critic_review: "Перевірка Критика", specialist_review: "Перевірка спеціаліста", head_review: "Перевірка Головного консультанта" },
    es: { proposal: "Propuesta", final: "Aprobado tras la revisión del crítico", unresolved: "Sin consenso", safety_handoff: "Ayuda humana para la seguridad", critic_review: "Revisión del crítico", specialist_review: "Revisión del especialista", head_review: "Revisión del responsable" },
    fr: { proposal: "Proposition", final: "Approuvé après l’examen du critique", unresolved: "Sans consensus", safety_handoff: "Aide humaine pour la sécurité", critic_review: "Examen du critique", specialist_review: "Examen du spécialiste", head_review: "Examen du responsable" },
    de: { proposal: "Vorschlag", final: "Nach Kritikprüfung bestätigt", unresolved: "Kein Konsens", safety_handoff: "Menschliche Sicherheitshilfe", critic_review: "Kritikprüfung", specialist_review: "Fachprüfung", head_review: "Prüfung durch die Leitung" },
    pl: { proposal: "Propozycja", final: "Zatwierdzono po ocenie krytyka", unresolved: "Brak konsensusu", safety_handoff: "Pomoc człowieka dla bezpieczeństwa", critic_review: "Ocena krytyka", specialist_review: "Ocena specjalisty", head_review: "Ocena głównego konsultanta" },
    ru: { proposal: "Предложение", final: "Согласовано после проверки Критика", unresolved: "Без консенсуса", safety_handoff: "Помощь человека для безопасности", critic_review: "Проверка Критика", specialist_review: "Проверка специалиста", head_review: "Проверка главного консультанта" }
  };
  const stageLabel = (stageLabels[language!] ?? stageLabels.en)![stageKind];
  const stage = stageLabel === undefined ? "" : ` · ${stageLabel}`;
  const header = `${visibleRole}${service ? ` · ${message.internalEventId.startsWith("mx-image-") ? observationLabel : serviceLabel}` : ""}${stage}${addressee} · ${message.visibleTime}`;
  const slot = presentation?.roleColorSlot;
  const colour = known !== undefined && presentation?.supportsRoleColours === true && Number.isSafeInteger(slot) && slot! >= 0 && slot! < CONSULTANT_COLOUR_SLOTS.length
    ? CONSULTANT_COLOUR_SLOTS[slot!] : undefined;
  const styledHeader = colour === undefined ? escapeHtml(header)
    : `<span data-mx-color="${colour}" data-mx-bg-color="#ffffff">${escapeHtml(header)}</span>`;
  const proposalLabels = ({
    uk: ["Рецензенти", "Запропонована відповідь власнику"], en: ["Reviewers", "Proposed answer to the owner"],
    ru: ["Рецензенты", "Предлагаемый ответ владельцу"], es: ["Revisores", "Respuesta propuesta al propietario"],
    fr: ["Relecteurs", "Réponse proposée au propriétaire"], de: ["Prüfende", "Vorgeschlagene Antwort an den Eigentümer"],
    pl: ["Recenzenci", "Proponowana odpowiedź dla właściciela"]
  } as Readonly<Record<string, readonly [string, string]>>)[language!] ?? ["Reviewers", "Proposed answer to the owner"];
  const plainFrame = proposalForReview
    ? `\n${proposalLabels[0]}: ${addressedRoles}\n\n${proposalLabels[1]}:\n\n`
    : "\n\n";
  const formattedFrame = proposalForReview
    ? `<p><strong>${escapeHtml(proposalLabels[0])}:</strong> ${escapeHtml(addressedRoles!)}</p><p><em>${escapeHtml(proposalLabels[1])}:</em></p>`
    : "";
  return Object.freeze({
    body: `${header}${plainFrame}${message.body}`,
    formattedBody: `<strong>${styledHeader}</strong><br>${formattedFrame}${renderMarkdownParagraphs(message.body)}`
  });
}

export function confirmedMessageFitsMatrixRuntimeLimits(message: ConfirmedAgentMessage): boolean {
  const delivery = formatConfirmedMessageContentForMatrix(message);
  const encoder = new TextEncoder();
  return encoder.encode(delivery.body).byteLength <= 64 * 1024 &&
    encoder.encode(delivery.formattedBody).byteLength <= 128 * 1024;
}

/**
 * Persists the complete validated work intent before making the sidecar ACK
 * eligible. Dispatch is never performed inline: a separately leased,
 * idempotent consumer registers the Session. A crash before ACK simply causes
 * the sidecar to replay the same event hash and recover the durable intent.
 */
export class DurableMatrixIngress {
  readonly #binding: RoomBinding;
  readonly #roomState: MatrixRoomStateResolver;
  readonly #deviceTrust: MatrixDeviceTrustResolver;
  readonly #receipts: MatrixIngressReceiptPort;
  readonly #now: () => Date;

  constructor(input: Readonly<{
    binding: RoomBinding;
    roomState: MatrixRoomStateResolver;
    deviceTrust: MatrixDeviceTrustResolver;
    receipts: MatrixIngressReceiptPort;
    now: () => Date;
  }>) {
    this.#binding = input.binding;
    this.#roomState = input.roomState;
    this.#deviceTrust = input.deviceTrust;
    this.#receipts = input.receipts;
    this.#now = input.now;
  }

  async accept(raw: RawMatrixIngress): Promise<DurableMatrixIngressResult> {
    if (this.#roomState === undefined || this.#deviceTrust === undefined) {
      return { ok: false, code: "room_invariant_failed" };
    }
    let room: MatrixRoomState;
    try {
      room = await this.#roomState.resolveCurrentRoom(this.#binding);
    } catch {
      return { ok: false, code: "room_invariant_failed" };
    }
    const validated = await validateMatrixIngress(this.#binding, room, raw, this.#deviceTrust);
    if (!validated.ok) return validated;
    return this.#persistValidated(raw, validated.value);
  }

  /**
   * Entry point for the checksum-pinned Rust boundary. The sidecar has already
   * revalidated E2EE, current room membership/policy and cross-signed sender
   * trust; Node still enforces its own exact envelope and content policy.
   */
  async acceptSidecarValidated(raw: RawMatrixIngress): Promise<DurableMatrixIngressResult> {
    const validated = validateSidecarMatrixIngress(this.#binding, raw);
    if (!validated.ok) {
      return validated.code === "secret_like_content"
        ? this.#persistSecretRejection(raw)
        : validated;
    }
    return this.#persistValidated(raw, validated.value);
  }

  async #persistValidated(
    raw: RawMatrixIngress,
    validated: MatrixIngressEvent
  ): Promise<DurableMatrixIngressResult> {
    const bodyHash = await sha256(validated.body);
    const mediaManifestHash = await sha256(validated.media);
    const eventHash = await sha256({
      eventId: raw.eventId,
      roomId: raw.roomId,
      senderMxid: raw.senderMxid,
      senderDeviceId: raw.senderDeviceId,
      encrypted: raw.encrypted,
      bodyHash,
      relationEventId: validated.relationEventId ?? null,
      mediaManifestHash
    });
    try {
      const receipt = await this.#receipts.persistIntent({
        eventId: raw.eventId,
        eventHash,
        roomId: raw.roomId,
        ownerMxid: raw.senderMxid,
        bodyHash,
        workIntent: validated,
        mediaManifestHash,
        requiresMediaConsumption: validated.media.length > 0,
        now: this.#now()
      });
      if (!receipt.ok) return receipt;
      const ephemeralMedia = raw.media ?? [];
      return Object.freeze({
        ok: true,
        event: validated,
        eventHash,
        mediaManifestHash,
        replayed: receipt.replayed,
        workQueued: !receipt.replayed,
        durableAck: receipt.durableAck,
        processed: receipt.processed,
        ephemeralMedia: Object.freeze(ephemeralMedia.map(({ handle, sha256: mediaSha256 }) =>
          Object.freeze({ handle, sha256: mediaSha256 })
        ))
      });
    } catch {
      return { ok: false, code: "receipt_store_failed" };
    }
  }

  async #persistSecretRejection(raw: RawMatrixIngress): Promise<DurableMatrixIngressResult> {
    const persistRejection = this.#receipts.persistRejection;
    if (persistRejection === undefined) return { ok: false, code: "secret_like_content" };
    const media = (raw.media ?? []).map(({ declaredMime, length, sha256: mediaSha256 }) =>
      Object.freeze({ declaredMime, length, sha256: mediaSha256 })
    );
    const bodyHash = await sha256(raw.body);
    const mediaManifestHash = await sha256(media);
    const eventHash = await sha256({
      eventId: raw.eventId,
      roomId: raw.roomId,
      senderMxid: raw.senderMxid,
      senderDeviceId: raw.senderDeviceId,
      encrypted: raw.encrypted,
      bodyHash,
      relationEventId: raw.relationEventId ?? null,
      mediaManifestHash
    });
    try {
      const receipt = await persistRejection({
        eventId: raw.eventId,
        eventHash,
        roomId: raw.roomId,
        ownerMxid: raw.senderMxid,
        bodyHash,
        mediaManifestHash,
        rejectionCode: "secret_like_content",
        now: this.#now()
      });
      if (!receipt.ok) return receipt;
      return Object.freeze({
        ok: false,
        code: "secret_like_content",
        durableRejection: Object.freeze({
          eventId: raw.eventId,
          eventHash,
          replayed: receipt.replayed,
          durableAck: receipt.durableAck
        })
      });
    } catch {
      return { ok: false, code: "receipt_store_failed" };
    }
  }

  async recordAckSent(eventId: string, eventHash: string): Promise<boolean> {
    return this.#receipts.acknowledge(eventId, eventHash, this.#now());
  }

  async recordMediaConsumed(input: Readonly<{
    eventId: string;
    eventHash: string;
    mediaManifestHash: string;
    consumptionReceiptHash: string;
  }>): Promise<boolean> {
    return this.#receipts.markMediaConsumed({ ...input, now: this.#now() });
  }
}

export type MatrixDrainResult =
  | Readonly<{ ok: true; state: "idle" }>
  | Readonly<{ ok: true; state: "accepted"; transactionId: string; matrixEventId: string }>
  | Readonly<{ ok: false; code: "room_invariant_failed" | "device_trust_unavailable" | "owner_delivery_not_trusted" | "matrix_send_failed" | "invalid_matrix_event_id" | "stale_lease" | "outbox_unavailable" | "outbox_corrupt" | "retry_exhausted" }>;

export type MatrixOutboxReconciliation = (input: Readonly<{
  generation: number;
  sequence: number;
  reason: "room_invariant_failed" | "owner_delivery_not_trusted" | "invalid_matrix_event_id" | "retry_exhausted";
}>) => void | Promise<void>;

/**
 * One bounded drain step. The MySQL port selects only the strict canonical
 * head. Policy is freshly resolved after the lease and immediately before the
 * send. Transport failure leaves the lease to expire, so the next attempt uses
 * the exact same deterministic transaction ID.
 */
export class MatrixOrderedOutboxDrainer {
  readonly #binding: RoomBinding;
  readonly #outbox: MatrixOrderedOutboxPort;
  readonly #client: MatrixE2eeDeliveryClient;
  readonly #roomState: MatrixRoomStateResolver;
  readonly #deviceTrust: MatrixDeviceTrustResolver;
  readonly #leaseOwner: string;
  readonly #now: () => Date;
  readonly #leaseMilliseconds: number;
  readonly #onReconciliationRequired: MatrixOutboxReconciliation | undefined;

  constructor(input: Readonly<{
    binding: RoomBinding;
    outbox: MatrixOrderedOutboxPort;
    client: MatrixE2eeDeliveryClient;
    roomState: MatrixRoomStateResolver;
    deviceTrust: MatrixDeviceTrustResolver;
    leaseOwner: string;
    now: () => Date;
    leaseMilliseconds?: number;
    onReconciliationRequired?: MatrixOutboxReconciliation;
  }>) {
    this.#binding = input.binding;
    this.#outbox = input.outbox;
    this.#client = input.client;
    this.#roomState = input.roomState;
    this.#deviceTrust = input.deviceTrust;
    this.#leaseOwner = input.leaseOwner;
    this.#now = input.now;
    this.#leaseMilliseconds = input.leaseMilliseconds ?? 30_000;
    this.#onReconciliationRequired = input.onReconciliationRequired;
  }

  async drainOne(): Promise<MatrixDrainResult> {
    let lease: LeasedMatrixPublication | undefined;
    try {
      lease = await this.#outbox.leaseHead({
        leaseOwner: this.#leaseOwner,
        now: this.#now(),
        leaseMilliseconds: this.#leaseMilliseconds
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "matrix_outbox_corrupt") {
        return { ok: false, code: "outbox_corrupt" };
      }
      return { ok: false, code: "outbox_unavailable" };
    }
    if (lease === undefined) return { ok: true, state: "idle" };

    let room: MatrixRoomState;
    try {
      room = await this.#roomState.resolveCurrentRoom(this.#binding);
    } catch {
      return this.#retryTransient(lease, "room_state_unavailable", "room_invariant_failed");
    }
    if (!validateRoomInvariant(this.#binding, room).ok) {
      if (!(await this.#block(lease, "room_invariant_failed"))) return { ok: false, code: "stale_lease" };
      return { ok: false, code: "room_invariant_failed" };
    }
    try {
      if (!await this.#deviceTrust.ownerDeliveryIsSafe(this.#binding)) {
        if (!(await this.#block(lease, "owner_delivery_not_trusted"))) return { ok: false, code: "stale_lease" };
        return { ok: false, code: "owner_delivery_not_trusted" };
      }
    } catch {
      return this.#retryTransient(lease, "device_trust_unavailable", "device_trust_unavailable");
    }

    let sent: Readonly<{ eventId: string }>;
    try {
      sent = await this.#client.send({
        delivery: formatConfirmedMessageForMatrix(this.#binding, lease.message, lease.replyToEventId),
        transactionId: lease.transactionId
      });
    } catch {
      return this.#retryTransient(lease, "matrix_send_failed", "matrix_send_failed");
    }
    if (!validMatrixEventId(sent.eventId)) {
      if (!(await this.#block(lease, "invalid_matrix_event_id"))) return { ok: false, code: "stale_lease" };
      return { ok: false, code: "invalid_matrix_event_id" };
    }
    const accepted = await this.#outbox.markAccepted(lease, sent.eventId, this.#now());
    if (!accepted.ok) return { ok: false, code: "stale_lease" };
    return { ok: true, state: "accepted", transactionId: lease.transactionId, matrixEventId: sent.eventId };
  }

  async #retryTransient(
    lease: LeasedMatrixPublication,
    storedCode: string,
    resultCode: "room_invariant_failed" | "device_trust_unavailable" | "matrix_send_failed"
  ): Promise<MatrixDrainResult> {
    if (lease.attemptCount >= 8) {
      if (!(await this.#block(lease, "retry_exhausted"))) return { ok: false, code: "stale_lease" };
      return { ok: false, code: "retry_exhausted" };
    }
    const backoff = Math.min(300_000, 1_000 * (2 ** Math.max(0, lease.attemptCount - 1)));
    const released = await this.#outbox.releaseTransient(lease, storedCode, this.#now(), backoff);
    return released.ok ? { ok: false, code: resultCode } : { ok: false, code: "stale_lease" };
  }

  async #block(
    lease: LeasedMatrixPublication,
    reason: "room_invariant_failed" | "owner_delivery_not_trusted" | "invalid_matrix_event_id" | "retry_exhausted"
  ): Promise<boolean> {
    const blocked = await this.#outbox.markBlocked(lease, reason, this.#now());
    if (!blocked.ok) return false;
    await this.#onReconciliationRequired?.({
      generation: lease.generation,
      sequence: lease.sequence,
      reason
    });
    return true;
  }
}
