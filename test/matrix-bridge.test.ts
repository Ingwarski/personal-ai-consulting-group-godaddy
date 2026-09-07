import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmedMessageFitsMatrixRuntimeLimits,
  DurableMatrixIngress,
  formatConfirmedMessageForMatrix,
  MatrixOrderedOutboxDrainer,
  validateMatrixIngress,
  isSecretLikeMatrixContent,
  type MatrixDeviceTrust,
  type MatrixDeviceTrustResolver
} from "../src/matrix/bridge.ts";
import type { MatrixRoomState, RoomBinding } from "../src/matrix/room-invariant.ts";
import { CONSULTATION_SPECIALISTS } from "../src/runtime/consultation-intake.ts";
import { CONSULTANT_ROLES, resolveConsultantRole } from "../src/consilium/consultant-roles.ts";
import { confirmedMessageFingerprint, matrixTransactionIdFor } from "../src/session/registrar-do.ts";

const binding: RoomBinding = {
  roomId: "!consultant:example.test",
  ownerMxid: "@owner:matrix.org",
  botMxid: "@bot:matrix.org",
  homeserver: "matrix.org",
  botDeviceId: "BOT_DEVICE_1"
};

const secureRoom: MatrixRoomState = {
  roomId: binding.roomId,
  homeserver: "matrix.org",
  encrypted: true,
  joinedMembers: [binding.ownerMxid, binding.botMxid],
  pendingInvites: 0,
  joinRule: "invite",
  historyVisibility: "joined",
  publicAddressOrListing: false,
  guestsAllowed: false,
  widgetsEnabled: false,
  bridgesPresent: false,
  botDeviceVerified: true,
  botDeviceRevoked: false,
  botDeviceId: binding.botDeviceId
};

const roomResolver = (room: MatrixRoomState = secureRoom) => ({
  resolveCurrentRoom: async () => room
});

const trustResolver = (trust: MatrixDeviceTrust = "verified", deliverySafe = true): MatrixDeviceTrustResolver => ({
  resolveOwnerDevice: async () => trust,
  ownerDeliveryIsSafe: async () => deliverySafe
});

const ingress = (overrides: Partial<Parameters<typeof validateMatrixIngress>[2]> = {}) => ({
  eventId: "$matrix-event-0001",
  roomId: binding.roomId,
  senderMxid: binding.ownerMxid,
  senderDeviceId: "OWNER_DEVICE_1",
  encrypted: true,
  body: "Текст",
  ...overrides
});

test("whole-message privacy gate recognizes assigned secrets and labeled identifiers without treating ordinary business numbers as credentials", () => {
  for (const body of [
    "password=abc", "GOOGLE_CLIENT_SECRET = private-value", '"refresh_token": "a-real-token"',
    "SETTINGS_OWNER_PASSWORD: owner-private", "access-token: access-private", "API key: key-private",
    "пароль: мійСекрет", "секрет клієнта = дужеТаємно", "токен доступу: мійТокен", "ключ доступу: приватний",
    "Bearer abcdefghijklmnop", "-----BEGIN RSA PRIVATE KEY-----", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature12345",
    "Картка: 4111 1111 1111 1111", "Картка: 5555-5555-5555-4444", "Номер: 378282246310005", "Картка 2221000000000009", "Картка 6011111111111117",
    "GB82WEST12345698765432", "Реквізити gb82 west 1234 5698 7654 32 Updated details", "IBAN: UA111111111111111111111111111",
    "паспорт: АА123456", "РНОКПП: 1234567890", "tax_id=123456789", "SSN: 123-45-6789"
  ]) assert.equal(isSecretLikeMatrixContent(body), true, body);
  for (const body of [
    "Як змінити пароль? Не надсилайте його в чат.", "Де налаштувати GOOGLE_CLIENT_SECRET?", "API keys and access tokens are confidential.",
    "Виручка 12000000000000, витрати 11000000000000.", "PDF offset: 0000000000000000", "Order: 12345678901234567890",
    "Sequence 4111111111111112 has an invalid card checksum.", "IBAN is a bank-account identifier.", "Паспорт потрібний лише для підтвердження особи."
  ]) assert.equal(isSecretLikeMatrixContent(body), false, body);
});

test("accepts only an encrypted event from a crypto-store-verified owner device in the exact private room", async () => {
  const result = await validateMatrixIngress(binding, secureRoom, ingress({ body: "Потрібен консиліум." }), trustResolver());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.body, "Потрібен консиліум.");
    assert.equal(result.value.senderDeviceId, "OWNER_DEVICE_1");
  }
});

test("blocks room drift, wrong room/sender, unencrypted events and secret-like content", async () => {
  const membershipDrift = await validateMatrixIngress(
    binding,
    { ...secureRoom, joinedMembers: [...secureRoom.joinedMembers, "@other:example.test"] },
    ingress(),
    trustResolver()
  );
  const wrongRoom = await validateMatrixIngress(binding, secureRoom, ingress({ roomId: "!wrong:example.test" }), trustResolver());
  const wrongSender = await validateMatrixIngress(binding, secureRoom, ingress({ senderMxid: "@other:example.test" }), trustResolver());
  const unencrypted = await validateMatrixIngress(binding, secureRoom, ingress({ encrypted: false }), trustResolver());
  const publicAddress = await validateMatrixIngress(binding, { ...secureRoom, publicAddressOrListing: true }, ingress(), trustResolver());
  const secret = await validateMatrixIngress(binding, secureRoom, ingress({ body: "OPENAI_API_KEY=do-not-send" }), trustResolver());

  assert.deepEqual(membershipDrift, { ok: false, code: "room_invariant_failed" });
  assert.deepEqual(wrongRoom, { ok: false, code: "wrong_room" });
  assert.deepEqual(wrongSender, { ok: false, code: "sender_not_owner" });
  assert.deepEqual(unencrypted, { ok: false, code: "event_not_encrypted" });
  assert.deepEqual(publicAddress, { ok: false, code: "room_invariant_failed" });
  assert.deepEqual(secret, { ok: false, code: "secret_like_content" });
});

test("fails closed for unverified, revoked, unknown or unavailable owner-device trust", async () => {
  assert.deepEqual(await validateMatrixIngress(binding, secureRoom, ingress(), trustResolver("unverified")), { ok: false, code: "sender_device_unverified" });
  assert.deepEqual(await validateMatrixIngress(binding, secureRoom, ingress(), trustResolver("revoked")), { ok: false, code: "sender_device_revoked" });
  assert.deepEqual(await validateMatrixIngress(binding, secureRoom, ingress(), trustResolver("unknown")), { ok: false, code: "sender_device_unknown" });
  assert.deepEqual(await validateMatrixIngress(binding, secureRoom, ingress(), {
    resolveOwnerDevice: async () => { throw new Error("crypto store unavailable"); },
    ownerDeliveryIsSafe: async () => true
  }), { ok: false, code: "device_trust_unavailable" });
});

test("rejects an ingress body above 64 KiB by UTF-8 bytes before durable storage", async () => {
  const exact = await validateMatrixIngress(binding, secureRoom, ingress({ body: "ї".repeat(32_768) }), trustResolver());
  const oversized = await validateMatrixIngress(binding, secureRoom, ingress({ body: "ї".repeat(32_769) }), trustResolver());
  assert.equal(exact.ok, true);
  assert.deepEqual(oversized, { ok: false, code: "invalid_event" });
});

test("formats only a registrar-confirmed role, time and complete body for Matrix delivery", () => {
  const delivery = formatConfirmedMessageForMatrix(binding, {
    generation: 1,
    sequence: 2,
    internalEventId: "internal-event-0002",
    role: "Фінансовий консультант",
    visibleTime: "16:20",
    body: "Повна відповідь\nбез скорочення.",
    bodyFormat: "markdown",
    bodyHash: "a".repeat(64),
    confirmedAt: "2026-08-16T13:20:00.000Z"
  }, "$owner-request");

  assert.equal(delivery.roomId, binding.roomId);
  assert.match(delivery.body, /^📊 Financial Consultant · 16:20/);
  assert.match(delivery.body, /Повна відповідь\nбез скорочення/);
  assert.equal(delivery.replyToEventId, "$owner-request");
  assert.doesNotMatch(delivery.formattedBody, /internal-event-0002|sequence|bodyHash/);
});

test("shows every consultant and Critic under their exact registered role", () => {
  for (const role of ["Головний консультант", ...CONSULTATION_SPECIALISTS.map(item => item.role), "Критик"]) {
    const delivery = formatConfirmedMessageForMatrix(binding, {
      generation: 1, sequence: 1, internalEventId: "role-label-event", role, visibleTime: "18:10",
      body: "Повна підтверджена репліка.", bodyFormat: "markdown", bodyHash: "a".repeat(64),
      confirmedAt: "2026-09-07T15:10:00.000Z"
    });
    const known = resolveConsultantRole(role)!;
    assert.equal(delivery.body, `${known.emoji} ${known.role} · 18:10\n\nПовна підтверджена репліка.`);
    assert.equal(delivery.formattedBody, `<strong>${known.emoji} ${known.role} · 18:10</strong><p>Повна підтверджена репліка.</p>`);
    assert.doesNotMatch(delivery.body, /Система/u);
  }
});

test("labels automatic notices as head coordination without changing stored identity or retry transaction", async () => {
  const input = { role: "Система", body: "Очікую завершення запиту.\nГотової відповіді ще немає." };
  const message = Object.freeze({
    ...input, generation: 1, sequence: 2, internalEventId: "control-role-label-event", visibleTime: "18:11",
    bodyFormat: "markdown" as const, bodyHash: await confirmedMessageFingerprint(input),
    confirmedAt: "2026-09-07T15:11:00.000Z"
  });
  const before = JSON.stringify(message);
  const transactionId = matrixTransactionIdFor(message);
  const delivery = formatConfirmedMessageForMatrix(binding, message, "$original-owner-event");
  assert.equal(delivery.body, `🧭 Head Consultant · службове повідомлення · 18:11\n\n${input.body}`);
  assert.match(delivery.formattedBody, /^<strong>🧭 Head Consultant · службове повідомлення · 18:11<\/strong>/u);
  assert.doesNotMatch(delivery.formattedBody, /Система/u);
  assert.equal(delivery.replyToEventId, "$original-owner-event");
  assert.equal(JSON.stringify(message), before);
  assert.equal(await confirmedMessageFingerprint(input), message.bodyHash);
  assert.equal(matrixTransactionIdFor(message), transactionId);
  // An authority-bearing agent name must never be relabeled as a control.
  const agent = formatConfirmedMessageForMatrix(binding, {
    ...message, authority: { agentId: "head", provider: "codex", runtimeSessionRef: "thread-head", kind: "assignment" }
  });
  assert.match(agent.body, /^Система · 18:11/u);
});

test("role colours are opt-in, accessible seven-slot headers with mandatory emoji/plain text and immutable body", () => {
  const base = { generation: 1, sequence: 1, internalEventId: "colour-event", visibleTime: "12:34", body: "**Exact advice**\n\nДослівний текст.",
    bodyFormat: "markdown" as const, bodyHash: "a".repeat(64), confirmedAt: "2026-09-08T09:34:00.000Z", language: "en" };
  const colours: string[] = [];
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  for (let slot = 0; slot < 7; slot++) {
    const known = CONSULTANT_ROLES[slot]!;
    const message = { ...base, role: known.role, addressedTo: "Критик; Головний консультант" };
    const before = JSON.stringify(message);
    const plain = formatConfirmedMessageForMatrix(binding, message);
    assert.doesNotMatch(plain.formattedBody, /data-mx-color/u);
    const styled = formatConfirmedMessageForMatrix(binding, message, undefined, { roleColorSlot: slot, supportsRoleColours: true });
    assert.equal(styled.body, plain.body);
    assert.ok(styled.body.endsWith(base.body));
    assert.ok(styled.body.startsWith(`${known.emoji} ${known.role} → Critic; Head Consultant`));
    const colour = /data-mx-color="(#[a-f0-9]{6})"/u.exec(styled.formattedBody)?.[1];
    assert.ok(colour);
    colours.push(colour);
    assert.ok(1.05 / (luminance(colour) + 0.05) >= 4.5);
    assert.match(styled.formattedBody, /data-mx-bg-color="#ffffff"/u);
    assert.equal(JSON.stringify(message), before);
  }
  assert.equal(new Set(colours).size, 7);
  for (const slot of [-1, 7, NaN, 1.2]) {
    assert.doesNotMatch(formatConfirmedMessageForMatrix(binding, { ...base, role: "Critic" }, undefined,
      { roleColorSlot: slot, supportsRoleColours: true }).formattedBody, /data-mx-color/u);
  }
});

test("candidate and exact approved final remain visible but have distinct localized stage headers", () => {
  const base = { generation: 1, sequence: 1, internalEventId: "stage-event", visibleTime: "12:34", body: "Exactly the same agreed recommendation.",
    bodyFormat: "markdown" as const, bodyHash: "a".repeat(64), confirmedAt: "2026-09-08T09:34:00.000Z", language: "en", role: "Head Consultant" };
  for (const [consensusKind, label] of [["proposal", "Candidate"], ["final", "Approved"], ["unresolved", "Unresolved"], ["safety_handoff", "Safety handoff"]] as const) {
    const result = formatConfirmedMessageForMatrix(binding, { ...base, consensusKind });
    assert.ok(result.body.startsWith(`🧭 Head Consultant · ${label} · 12:34`));
    assert.ok(result.body.endsWith(base.body));
  }
});

test("enforces the actual plaintext and formatted Matrix runtime byte envelopes without truncation", () => {
  const base = {
    generation: 1, sequence: 1, internalEventId: "internal-envelope-event", role: "R", visibleTime: "12:00",
    bodyFormat: "markdown" as const, bodyHash: "a".repeat(64), confirmedAt: "2026-09-04T12:00:00.000Z"
  };
  const prefixBytes = new TextEncoder().encode("R · 12:00\n\n").byteLength;
  assert.equal(confirmedMessageFitsMatrixRuntimeLimits({ ...base, body: "a".repeat(65_536 - prefixBytes) }), true);
  assert.equal(confirmedMessageFitsMatrixRuntimeLimits({ ...base, body: "a".repeat(65_537 - prefixBytes) }), false);
  assert.equal(confirmedMessageFitsMatrixRuntimeLimits({ ...base, body: "<".repeat(40_000) }), false);
});

test("renders the closed Markdown subset and keeps injected HTML inert", () => {
  const delivery = formatConfirmedMessageForMatrix(binding, {
    generation: 1,
    sequence: 3,
    internalEventId: "internal-event-0003",
    role: "Стратег",
    visibleTime: "16:21",
    body: "## Рішення\n\n**Важливо**\nдругий рядок\n\n1. Перше\n2. Друге\n\n- Один\n- Два\n\n### Ризик\n\n<img onerror=alert(1)> <script>bad()</script>",
    bodyFormat: "markdown",
    bodyHash: "d".repeat(64),
    confirmedAt: "2026-08-16T13:21:00.000Z"
  });

  assert.match(delivery.formattedBody, /<h2>Рішення<\/h2>/);
  assert.match(delivery.formattedBody, /<p><strong>Важливо<\/strong><br>другий рядок<\/p>/);
  assert.match(delivery.formattedBody, /<ol><li>Перше<\/li><li>Друге<\/li><\/ol>/);
  assert.match(delivery.formattedBody, /<ul><li>Один<\/li><li>Два<\/li><\/ul>/);
  assert.match(delivery.formattedBody, /<h3>Ризик<\/h3>/);
  assert.match(delivery.formattedBody, /&lt;img onerror=alert\(1\)&gt; &lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(delivery.formattedBody, /<img|<script>/);
});

test("keeps the legacy HTML output byte-identical when the body contains no Markdown", () => {
  const delivery = formatConfirmedMessageForMatrix(binding, {
    generation: 1, sequence: 2, internalEventId: "internal-event-plain", role: "Роль", visibleTime: "16:20",
    body: "Перший рядок\nдругий.\n\nНовий абзац.", bodyFormat: "markdown", bodyHash: "e".repeat(64),
    confirmedAt: "2026-08-16T13:20:00.000Z"
  });
  assert.equal(delivery.formattedBody, "<strong>Роль · 16:20</strong><p>Перший рядок<br>другий.</p><p>Новий абзац.</p>");
});

test("persists a durable work intent before ACK eligibility and never dispatches inline", async () => {
  const rows = new Map<string, { hash: string; acked: boolean; processed: boolean }>();
  const durable = new DurableMatrixIngress({
    binding,
    roomState: roomResolver(),
    deviceTrust: trustResolver(),
    now: () => new Date("2026-09-04T12:00:00.000Z"),
    receipts: {
      persistIntent: async (input) => {
        const existing = rows.get(input.eventId);
        if (existing !== undefined) {
          if (existing.hash !== input.eventHash) return { ok: false, code: "event_conflict" as const };
          return { ok: true, replayed: true, durableAck: true, processed: existing.processed };
        }
        assert.equal(input.workIntent.body, "Текст");
        rows.set(input.eventId, { hash: input.eventHash, acked: false, processed: false });
        return { ok: true, replayed: false, durableAck: true, processed: false };
      },
      acknowledge: async (eventId) => {
        const row = rows.get(eventId);
        if (row === undefined) return false;
        row.acked = true;
        return true;
      },
      markMediaConsumed: async () => false
    }
  });

  const first = await durable.accept(ingress());
  assert.equal(first.ok && first.workQueued, true);
  assert.equal(first.ok && first.durableAck, true);
  if (!first.ok) return;
  assert.equal(await durable.recordAckSent(first.event.eventId, first.eventHash), true);
  const replay = await durable.accept(ingress());
  assert.equal(replay.ok && replay.replayed, true);
  assert.equal(replay.ok && replay.workQueued, false);
  assert.equal(replay.ok && replay.durableAck, true);
});

test("durably rejects secret-like sidecar input without storing its plaintext", async () => {
  let rejectedHash: string | undefined;
  let intentWrites = 0;
  const durable = new DurableMatrixIngress({
    binding,
    roomState: roomResolver(),
    deviceTrust: trustResolver(),
    now: () => new Date("2026-09-04T12:00:00.000Z"),
    receipts: {
      persistIntent: async () => {
        intentWrites += 1;
        return { ok: true, replayed: false, durableAck: true, processed: false };
      },
      persistRejection: async (input) => {
        assert.equal(Object.hasOwn(input, "body"), false);
        assert.doesNotMatch(JSON.stringify(input), /do-not-persist/u);
        rejectedHash = input.eventHash;
        return { ok: true, replayed: false, durableAck: true, processed: false };
      },
      acknowledge: async () => true,
      markMediaConsumed: async () => false
    }
  });

  const result = await durable.acceptSidecarValidated(ingress({
    body: "OPENAI_API_KEY=do-not-persist"
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "secret_like_content");
  assert.equal(result.durableRejection?.eventHash, rejectedHash);
  assert.equal(result.durableRejection?.durableAck, true);
  assert.equal(intentWrites, 0);
});

test("preserves nullable media intent and reply relation without persisting handles, and ACKs only after durable media consumption", async () => {
  const rows = new Map<string, { hash: string; mediaManifestHash: string; mediaConsumed: boolean }>();
  let persistedIntent: unknown;
  const durable = new DurableMatrixIngress({
    binding,
    roomState: roomResolver(),
    deviceTrust: trustResolver(),
    now: () => new Date("2026-09-04T12:00:00.000Z"),
    receipts: {
      persistIntent: async (input) => {
        persistedIntent = input.workIntent;
        const existing = rows.get(input.eventId);
        if (existing !== undefined) {
          if (existing.hash !== input.eventHash) return { ok: false, code: "event_conflict" as const };
          return { ok: true, replayed: true, durableAck: existing.mediaConsumed, processed: false };
        }
        rows.set(input.eventId, {
          hash: input.eventHash,
          mediaManifestHash: input.mediaManifestHash,
          mediaConsumed: false
        });
        return { ok: true, replayed: false, durableAck: false, processed: false };
      },
      acknowledge: async (eventId, eventHash) => {
        const row = rows.get(eventId);
        return row?.hash === eventHash && row.mediaConsumed;
      },
      markMediaConsumed: async (input) => {
        const row = rows.get(input.eventId);
        if (row?.hash !== input.eventHash || row.mediaManifestHash !== input.mediaManifestHash) return false;
        row.mediaConsumed = true;
        return true;
      }
    }
  });
  const rawMedia = {
    handle: "boot-1-media-1",
    declaredMime: "application/pdf" as const,
    length: 4096,
    sha256: "a".repeat(64)
  };
  const raw = ingress({
    eventId: "$matrix-media-event-0001",
    body: null,
    relationEventId: "$matrix-parent-event-0001",
    media: [rawMedia]
  });
  const first = await durable.accept(raw);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.event.body, null);
  assert.equal(first.event.relationEventId, "$matrix-parent-event-0001");
  assert.deepEqual(first.event.media, [{
    declaredMime: "application/pdf", length: 4096, sha256: "a".repeat(64)
  }]);
  assert.deepEqual(first.ephemeralMedia, [{ handle: rawMedia.handle, sha256: rawMedia.sha256 }]);
  assert.doesNotMatch(JSON.stringify(persistedIntent), /boot-1-media-1|handle|path/);
  assert.equal(first.durableAck, false);
  assert.equal(await durable.recordAckSent(first.event.eventId, first.eventHash), false);
  assert.equal(await durable.recordMediaConsumed({
    eventId: first.event.eventId,
    eventHash: first.eventHash,
    mediaManifestHash: first.mediaManifestHash,
    consumptionReceiptHash: "b".repeat(64)
  }), true);
  assert.equal(await durable.recordAckSent(first.event.eventId, first.eventHash), true);

  const replay = await durable.accept({ ...raw, media: [{ ...rawMedia, handle: "boot-1-media-replay" }] });
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.eventHash, first.eventHash);
  assert.equal(replay.replayed, true);
  assert.equal(replay.workQueued, false);
  assert.equal(replay.durableAck, true);
});

test("rejects media paths and out-of-contract media before durable receipt creation", async () => {
  let persisted = false;
  const durable = new DurableMatrixIngress({
    binding,
    roomState: roomResolver(),
    deviceTrust: trustResolver(),
    now: () => new Date(),
    receipts: {
      persistIntent: async () => { persisted = true; return { ok: true, replayed: false, durableAck: false, processed: false }; },
      acknowledge: async () => false,
      markMediaConsumed: async () => false
    }
  });
  const result = await durable.accept(ingress({
    body: null,
    media: [{ handle: "../private/file", declaredMime: "image/png", length: 8, sha256: "c".repeat(64) }]
  }));
  assert.deepEqual(result, { ok: false, code: "invalid_event" });
  assert.equal(persisted, false);
});

test("drains one leased record with its stored transaction ID and records homeserver acceptance only", async () => {
  const accepted: string[] = [];
  const leased = {
    generation: 1,
    sequence: 7,
    transactionId: "pc-1-7-777777777777777777777777",
    message: {
      generation: 1, sequence: 7, internalEventId: "internal-event-0007", role: "Стратег", visibleTime: "16:26",
      body: "Канонічний текст.", bodyFormat: "markdown" as const, bodyHash: "7".repeat(64), confirmedAt: "2026-08-16T13:26:00.000Z"
    },
    replyToEventId: "$owner-request-0007",
    leaseOwner: "node-worker-01",
    leaseEpoch: 3,
    attemptCount: 1
  };
  const drainer = new MatrixOrderedOutboxDrainer({
    binding,
    leaseOwner: "node-worker-01",
    now: () => new Date("2026-09-04T12:00:00.000Z"),
    roomState: roomResolver(),
    deviceTrust: trustResolver(),
    client: {
      send: async (input) => {
        assert.equal(input.transactionId, leased.transactionId);
        assert.equal(input.delivery.replyToEventId, leased.replyToEventId);
        return { eventId: "$homeserver-accepted-0007" };
      }
    },
    outbox: {
      leaseHead: async () => leased,
      markAccepted: async (_lease, eventId) => { accepted.push(eventId); return { ok: true }; },
      markBlocked: async () => ({ ok: true }),
      releaseTransient: async () => ({ ok: true })
    }
  });
  assert.deepEqual(await drainer.drainOne(), {
    ok: true,
    state: "accepted",
    transactionId: leased.transactionId,
    matrixEventId: "$homeserver-accepted-0007"
  });
  assert.deepEqual(accepted, ["$homeserver-accepted-0007"]);
});

test("retries transient room-state failure with bounded backoff but blocks confirmed drift for reconciliation", async () => {
  const releases: number[] = [];
  const blocked: string[] = [];
  const reconciliations: string[] = [];
  const leased = {
    generation: 2, sequence: 1, transactionId: "pc-2-1-888888888888888888888888",
    message: {
      generation: 2, sequence: 1, internalEventId: "internal-event-0008", role: "Стратег", visibleTime: "16:27",
      body: "Текст.", bodyFormat: "markdown" as const, bodyHash: "8".repeat(64), confirmedAt: "2026-08-16T13:27:00.000Z"
    },
    leaseOwner: "node-worker-01", leaseEpoch: 1, attemptCount: 2
  };
  const outbox = {
    leaseHead: async () => leased,
    markAccepted: async () => ({ ok: true } as const),
    markBlocked: async (_lease: typeof leased, reason: string) => { blocked.push(reason); return { ok: true } as const; },
    releaseTransient: async (_lease: typeof leased, _code: string, _now: Date, backoff: number) => {
      releases.push(backoff);
      return { ok: true } as const;
    }
  };
  const unavailable = new MatrixOrderedOutboxDrainer({
    binding, outbox, leaseOwner: "node-worker-01", now: () => new Date(), deviceTrust: trustResolver(),
    roomState: { resolveCurrentRoom: async () => { throw new Error("temporary sync gap"); } },
    client: { send: async () => ({ eventId: "$never-sent-0001" }) }
  });
  assert.deepEqual(await unavailable.drainOne(), { ok: false, code: "room_invariant_failed" });
  assert.deepEqual(releases, [2_000]);
  assert.deepEqual(blocked, []);

  const drifted = new MatrixOrderedOutboxDrainer({
    binding, outbox, leaseOwner: "node-worker-01", now: () => new Date(), deviceTrust: trustResolver(),
    roomState: roomResolver({ ...secureRoom, joinedMembers: [...secureRoom.joinedMembers, "@other:matrix.org"] }),
    client: { send: async () => ({ eventId: "$never-sent-0002" }) },
    onReconciliationRequired: (input) => { reconciliations.push(input.reason); }
  });
  assert.deepEqual(await drifted.drainOne(), { ok: false, code: "room_invariant_failed" });
  assert.deepEqual(blocked, ["room_invariant_failed"]);
  assert.deepEqual(reconciliations, ["room_invariant_failed"]);
});
