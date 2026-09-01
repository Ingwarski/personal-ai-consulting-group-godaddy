import assert from "node:assert/strict";
import test from "node:test";

import {
  formatConfirmedMessageForMatrix,
  MatrixConfirmedMessagePublisher,
  validateMatrixIngress,
  type MatrixDeviceTrust,
  type MatrixDeviceTrustResolver
} from "../src/matrix/bridge.ts";
import type { MatrixRoomState, RoomBinding } from "../src/matrix/room-invariant.ts";

const binding: RoomBinding = {
  roomId: "!consultant:example.test",
  ownerMxid: "@owner:matrix.org",
  botMxid: "@bot:matrix.org",
  homeserver: "matrix.org"
};

const secureRoom: MatrixRoomState = {
  roomId: binding.roomId,
  encrypted: true,
  joinedMembers: [binding.ownerMxid, binding.botMxid],
  pendingInvites: 0,
  historyVisibility: "joined",
  publicAddressOrListing: false,
  guestsAllowed: false,
  widgetsEnabled: false,
  bridgesPresent: false,
  botDeviceVerified: true,
  botDeviceRevoked: false
};

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

test("accepts only an encrypted event from a crypto-store-verified owner device in the exact private room", async () => {
  const result = await validateMatrixIngress(binding, secureRoom, ingress({ body: "Потрібен консиліум." }), trustResolver());

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.body, "Потрібен консиліум.");
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
  assert.match(delivery.body, /^Фінансовий консультант · 16:20/);
  assert.match(delivery.body, /Повна відповідь\nбез скорочення/);
  assert.equal(delivery.replyToEventId, "$owner-request");
  assert.doesNotMatch(delivery.formattedBody, /internal-event-0002|sequence|bodyHash/);
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

test("stores one idempotent Matrix delivery receipt for a confirmed message and rejects a conflicting retry", async () => {
  const values = new Map<string, unknown>();
  let sends = 0;
  const publisher = new MatrixConfirmedMessagePublisher({
    binding,
    client: {
      send: async ({ transactionId }) => {
        sends += 1;
        assert.match(transactionId, /^pc-1-4-/);
        return { eventId: "$matrix-delivery-0004" };
      }
    },
    receipts: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => { values.set(key, value); }
    },
    deviceTrust: trustResolver()
  });
  const message = {
    generation: 1, sequence: 4, internalEventId: "internal-event-0004", role: "Критик", visibleTime: "16:23",
    body: "Повна критика.", bodyFormat: "markdown" as const, bodyHash: "b".repeat(64), confirmedAt: "2026-08-16T13:23:00.000Z"
  };

  const first = await publisher.publish(message);
  const second = await publisher.publish(message);
  const conflict = await publisher.publish({ ...message, bodyHash: "c".repeat(64) });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.ok && second.replayed, true);
  assert.deepEqual(conflict, { ok: false, code: "receipt_conflict" });
  assert.equal(sends, 1);
});

test("does not send protected output when owner delivery trust is unsafe", async () => {
  let sends = 0;
  const publisher = new MatrixConfirmedMessagePublisher({
    binding,
    client: { send: async () => { sends += 1; return { eventId: "$unexpected-delivery" }; } },
    receipts: { get: async () => undefined, put: async () => {} },
    deviceTrust: trustResolver("verified", false)
  });
  const result = await publisher.publish({
    generation: 1, sequence: 5, internalEventId: "internal-event-0005", role: "Критик", visibleTime: "16:24",
    body: "Не надсилати.", bodyFormat: "markdown", bodyHash: "f".repeat(64), confirmedAt: "2026-08-16T13:24:00.000Z"
  });
  assert.deepEqual(result, { ok: false, code: "owner_delivery_not_trusted" });
  assert.equal(sends, 0);
});
