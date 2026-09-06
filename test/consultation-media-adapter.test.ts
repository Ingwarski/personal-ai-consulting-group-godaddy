import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import test from "node:test";

import { createConsultationMediaAdapter } from "../src/godaddy/consultation-media-adapter.ts";
import type { MatrixConsultationMediaStore } from "../src/godaddy/matrix-consultation-media.ts";
import type { ConsultationDocument } from "../src/godaddy/matrix-consultation-service.ts";

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const image = Buffer.from([0xff, 0xd8, 0xff, 0x41, 0x42, 0x43]);
function document(bytes: Buffer, mime: "image/jpeg" | "application/pdf", confirmed = true): ConsultationDocument {
  return { eventHash: hash(bytes), eventId: "$" + hash(bytes), confirmed, manifest: [{ declaredMime: mime, length: bytes.length, sha256: hash(bytes) }] };
}

function textPdf(text = "Business report evidence"): Buffer {
  const stream = deflateSync(Buffer.from(`BT /F1 12 Tf 40 740 Td (${text}) Tj ET`));
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Count 1 /Kids [4 0 R] >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>"),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from("\nendstream")])
  ];
  const parts = [Buffer.from("%PDF-1.7\n")];
  const offsets: number[] = []; let length = parts[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const value = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(value); length += value.length;
  });
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

function harness(data: readonly Readonly<{ document: ConsultationDocument; bytes: Buffer }>[]) {
  const loads: { hash: string; manifest: ConsultationDocument["manifest"] }[] = [];
  const erasures: { hash: string; reason: string }[] = [];
  const buffers: Buffer[] = [];
  const releases: number[] = [];
  let purges = 0;
  const control: { unavailable?: string; throwOnLoad?: string; throwOnErase?: boolean; afterLoad?: () => void } = {};
  const store: MatrixConsultationMediaStore = {
    consume: async () => { throw new Error("not used in adapter fixture"); },
    load: async (eventHash, manifest) => {
      loads.push({ hash: eventHash, manifest });
      if (eventHash === control.throwOnLoad) throw new Error("fixture storage failure");
      if (eventHash === control.unavailable) return { ok: false, code: "expired" };
      const entry = data.find(item => item.document.eventHash === eventHash);
      assert.ok(entry);
      assert.deepEqual(manifest, entry.document.manifest);
      const owned = Buffer.from(entry.bytes); const index = buffers.length;
      buffers.push(owned); releases.push(0);
      control.afterLoad?.();
      return {
        ok: true, requiresDocumentConfirmation: true,
        objects: [{ ...entry.document.manifest[0]!, bytes: owned }],
        release: () => { releases[index] = releases[index]! + 1; owned.fill(0); }
      };
    },
    erase: async (eventHash, reason) => { erasures.push({ hash: eventHash, reason }); if (control.throwOnErase) throw new Error("fixture erase failure"); },
    purgeExpired: async () => { purges += 1; },
    close: () => undefined
  };
  return { adapter: createConsultationMediaAdapter(store), loads, erasures, buffers, releases, control, purges: () => purges };
}

test("every document needs exact affirmative consent before the first durable load", async () => {
  const pdf = textPdf();
  const approved = document(image, "image/jpeg");
  const unapproved = document(pdf, "application/pdf", false);
  const state = harness([{ document: approved, bytes: image }, { document: unapproved, bytes: pdf }]);
  assert.equal(await state.adapter.prepare([approved, unapproved]), undefined);
  assert.equal(state.loads.length, 0);
  assert.equal(state.erasures.length, 0);
  assert.equal(await state.adapter.prepare([{ ...approved, confirmed: "false" as unknown as boolean }]), undefined);
  assert.equal(state.loads.length, 0);
});

test("confirmed documents become actual PDF text and native image bytes with explicit ownership", async () => {
  const pdf = textPdf();
  const first = document(pdf, "application/pdf"); const second = document(image, "image/jpeg");
  const state = harness([{ document: first, bytes: pdf }, { document: second, bytes: image }]);
  const prepared = await state.adapter.prepare([first, second]);
  assert.ok(prepared);
  assert.match(prepared.text, /Business report evidence/u);
  assert.match(prepared.text, /графічні елементи не аналізувалися/u);
  assert.ok(!prepared.text.includes(first.eventHash));
  assert.deepEqual(prepared.images, [{ mime: "image/jpeg", bytes: image }]);
  assert.equal(prepared.images[0]!.bytes, state.buffers[1]);
  assert.deepEqual(state.loads.map(item => item.hash), [first.eventHash, second.eventHash]);
  assert.deepEqual(state.releases, [0, 0]);
  prepared.release();
  assert.deepEqual(state.releases, [1, 1]);
  assert.ok(state.buffers.every(bytes => bytes.every(byte => byte === 0)));
  assert.ok(image.some(byte => byte !== 0));
});

test("unavailable later document releases already-loaded bytes and forwards no partial payload", async () => {
  const pdf = textPdf(); const first = document(image, "image/jpeg"); const second = document(pdf, "application/pdf");
  const state = harness([{ document: first, bytes: image }, { document: second, bytes: pdf }]);
  state.control.unavailable = second.eventHash;
  assert.equal(await state.adapter.prepare([first, second]), undefined);
  assert.deepEqual(state.releases, [1]);
  assert.ok(state.buffers[0]!.every(byte => byte === 0));
});

test("storage exceptions still release every previously loaded object", async () => {
  const pdf = textPdf(); const first = document(image, "image/jpeg"); const second = document(pdf, "application/pdf");
  const state = harness([{ document: first, bytes: image }, { document: second, bytes: pdf }]);
  state.control.throwOnLoad = second.eventHash;
  await assert.rejects(state.adapter.prepare([first, second]), /fixture storage failure/u);
  assert.deepEqual(state.releases, [1]);
  assert.ok(state.buffers[0]!.every(byte => byte === 0));
});

test("a secret discovered in PDF extraction rejects exact document and exposes no partial image/text payload", async () => {
  const pdf = textPdf("password=privateCredential");
  assert.ok(!pdf.toString("latin1").includes("password=privateCredential"));
  const first = document(image, "image/jpeg"); const second = document(pdf, "application/pdf");
  const state = harness([{ document: first, bytes: image }, { document: second, bytes: pdf }]);
  assert.equal(await state.adapter.prepare([first, second]), undefined);
  assert.deepEqual(state.erasures, [{ hash: second.eventHash, reason: "rejected" }]);
  assert.deepEqual(state.releases, [1, 1]);
  assert.ok(state.buffers.every(bytes => bytes.every(byte => byte === 0)));
});

test("failed rejection erasure does not prevent in-memory cleanup", async () => {
  const pdf = textPdf("password=privateCredential"); const item = document(pdf, "application/pdf");
  const state = harness([{ document: item, bytes: pdf }]); state.control.throwOnErase = true;
  await assert.rejects(state.adapter.prepare([item]), /fixture erase failure/u);
  assert.deepEqual(state.releases, [1]);
  assert.ok(state.buffers[0]!.every(byte => byte === 0));
});

test("already cancelled preparation never loads an image", async () => {
  const item = document(image, "image/jpeg"); const state = harness([{ document: item, bytes: image }]);
  const controller = new AbortController(); controller.abort();
  assert.equal(await state.adapter.prepare([item], controller.signal), undefined);
  assert.equal(state.loads.length, 0);
});

test("Stop during durable image load releases bytes and never returns them for provider use", async () => {
  const item = document(image, "image/jpeg"); const state = harness([{ document: item, bytes: image }]);
  const controller = new AbortController(); state.control.afterLoad = () => controller.abort();
  assert.equal(await state.adapter.prepare([item], controller.signal), undefined);
  assert.deepEqual(state.releases, [1]);
  assert.ok(state.buffers[0]!.every(byte => byte === 0));
});

test("Stop terminates PDF extraction and releases plaintext instead of yielding parsed content", async () => {
  const pdf = textPdf(); const item = document(pdf, "application/pdf");
  const state = harness([{ document: item, bytes: pdf }]); const controller = new AbortController();
  const pending = state.adapter.prepare([item], controller.signal);
  setTimeout(() => controller.abort(), 1);
  assert.equal(await pending, undefined);
  assert.deepEqual(state.releases, [1]);
  assert.ok(state.buffers[0]!.every(byte => byte === 0));
});

test("explicit exact-event erasure and idle-expiry maintenance use only the durable store", async () => {
  const item = document(image, "image/jpeg"); const state = harness([{ document: item, bytes: image }]);
  await state.adapter.erase(item.eventHash);
  await state.adapter.purgeExpired();
  assert.deepEqual(state.erasures, [{ hash: item.eventHash, reason: "processed" }]);
  assert.equal(state.purges(), 1);
  assert.equal(state.loads.length, 0);
});
