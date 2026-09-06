import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import test from "node:test";

import { createMySqlMatrixConsultationMediaStore, extractPdfForConsultation, MATRIX_CONSULTATION_MEDIA_TTL_MS } from "../src/godaddy/matrix-consultation-media.ts";
import type { MatrixIngressMediaObject, ValidatedMatrixIngress } from "../src/godaddy/matrix-runtime.ts";
import type { MySqlConnection, MySqlPool } from "../src/godaddy/mysql-storage.ts";

class MemoryPool implements MySqlPool {
  values = new Map<string, string>();
  committed = 0;
  failCommit = false;
  largestWrite = 0;
  #tail = Promise.resolve();
  async executeAgainst(map: Map<string, string>, statement: string, values: readonly unknown[]) {
    assert.match(statement, /personal_consultant_state/u);
    assert.doesNotMatch(statement, /(?:CREATE|ALTER|DROP) TABLE/u);
    const key = `${values[0]}:${values[1]}`;
    if (statement.startsWith("SELECT")) return [map.has(key) ? [{ stateValue: map.get(key) }] : [], []] as const;
    if (statement.startsWith("DELETE")) map.delete(key);
    else {
      const payload = values[2];
      assert.equal(typeof payload, "string");
      this.largestWrite = Math.max(this.largestWrite, Buffer.byteLength(payload as string));
      map.set(key, payload as string);
    }
    return [{ affectedRows: 1 }, []] as const;
  }
  async execute(statement: string, values: readonly unknown[]) { return this.executeAgainst(this.values, statement, values); }
  async getConnection(): Promise<MySqlConnection> {
    const waiting = this.#tail;
    let unlock!: () => void;
    this.#tail = new Promise<void>((resolve) => { unlock = resolve; });
    let working: Map<string, string>;
    return {
      beginTransaction: async () => { await waiting; working = new Map(this.values); },
      commit: async () => { if (this.failCommit) throw new Error("fixture commit failure"); this.values = working; this.committed += 1; },
      rollback: async () => undefined,
      release: () => unlock(),
      execute: async (statement, values) => this.executeAgainst(working, statement, values)
    };
  }
}

const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const key = Buffer.alloc(32, 0x63);
const jpeg = (body = "ordinary business image"): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(body)]);

function fixture(bytes = jpeg(), id = "$event-media", mime: "image/jpeg" | "image/png" | "application/pdf" = "image/jpeg") {
  const media = { handle: `${"a".repeat(32)}-${"b".repeat(24)}.${mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "pdf"}`, declaredMime: mime, length: bytes.length, sha256: hash(bytes) };
  const event: ValidatedMatrixIngress = { receiptId: "receipt", eventId: id, roomId: "!room:matrix.org", senderMxid: "@owner:matrix.org", senderDeviceId: "VERIFIED", body: "Review the attachment", media: [media] };
  const manifest = [{ declaredMime: media.declaredMime, length: media.length, sha256: media.sha256 }];
  const eventHash = hash(JSON.stringify({ eventId: event.eventId, roomId: event.roomId, senderMxid: event.senderMxid, senderDeviceId: event.senderDeviceId, encrypted: true, bodyHash: hash(JSON.stringify(event.body)), relationEventId: null, mediaManifestHash: hash(JSON.stringify(manifest)) }));
  const objects: readonly MatrixIngressMediaObject[] = [{ ...media, bytes }];
  return { eventHash, event, objects, manifest };
}

test("encrypted media is durable before ACK, restart/replay stable, and caller releases owned plaintext", async () => {
  const pool = new MemoryPool();
  const input = fixture();
  const store = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => 1_000 });
  const receipt = await store.consume(input);
  assert.equal(pool.committed, 1);
  assert.equal(receipt.eventHash, input.eventHash);
  assert.match(receipt.consumptionReceiptHash, /^[a-f0-9]{64}$/u);
  const serialized = [...pool.values.values()].join("");
  assert.ok(!serialized.includes("ordinary business image"));
  assert.ok(!serialized.includes(input.objects[0]!.bytes.toString("base64")));
  assert.ok(!serialized.includes(input.event.media[0]!.handle));
  store.close();
  const restarted = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => 2_000 });
  assert.deepEqual(await restarted.consume(input), receipt);
  const loaded = await restarted.load(input.eventHash, input.manifest);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.requiresDocumentConfirmation, true);
  assert.deepEqual(loaded.objects[0]!.bytes, input.objects[0]!.bytes);
  loaded.release();
  loaded.release();
  assert.ok(loaded.objects[0]!.bytes.every((byte) => byte === 0));
  assert.ok(input.objects[0]!.bytes.some((byte) => byte !== 0), "does not erase caller-owned sidecar bytes");
});

test("failed transaction yields no ACK receipt or partial encrypted staging", async () => {
  const pool = new MemoryPool(); pool.failCommit = true;
  const store = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => 1_000 });
  await assert.rejects(store.consume(fixture()));
  assert.equal(pool.values.size, 0);
});

test("hash, MIME, exact manifest order, event binding, and count are validated before storage", async () => {
  const pool = new MemoryPool();
  const store = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => 1_000 });
  const input = fixture();
  for (const invalid of [
    { ...input, eventHash: "c".repeat(64) },
    { ...input, objects: [{ ...input.objects[0]!, sha256: "c".repeat(64) }] },
    { ...input, objects: [{ ...input.objects[0]!, handle: "wrong" }] },
    { ...input, objects: [{ ...input.objects[0]!, bytes: Buffer.alloc(input.objects[0]!.length, 1) }] },
    { ...input, objects: [] },
    fixture(jpeg(), "$wrong-mime", "image/png")
  ]) await assert.rejects(store.consume(invalid));
  assert.equal(pool.values.size, 0);
});

test("20 MiB per object, 64 MiB aggregate and four-object bounds reject before copying", async () => {
  const pool = new MemoryPool();
  const store = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => 1_000 });
  const input = fixture();
  for (const media of [
    [{ ...input.event.media[0]!, length: 20 * 1_024 * 1_024 + 1 }],
    Array.from({ length: 4 }, (_, i) => ({ ...input.event.media[0]!, handle: `distinct-${i}`, length: 17 * 1_024 * 1_024 })),
    Array.from({ length: 5 }, (_, i) => ({ ...input.event.media[0]!, handle: `distinct-${i}` }))
  ]) await assert.rejects(store.consume({ ...input, event: { ...input.event, media } }));
  assert.equal(pool.values.size, 0);
});

test("large permitted media is encrypted in bounded SQL chunks", async () => {
  const pool = new MemoryPool();
  const store = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => 1_000 });
  const input = fixture(jpeg("x".repeat(400_000)));
  await store.consume(input);
  assert.ok(pool.largestWrite < 180_000);
  const loaded = await store.load(input.eventHash, input.manifest);
  assert.equal(loaded.ok, true);
  if (loaded.ok) { assert.deepEqual(loaded.objects[0]!.bytes, input.objects[0]!.bytes); loaded.release(); }
});

test("ciphertext, GCM tag, metadata expiry, and wrong-key tampering never returns plaintext", async () => {
  for (const tamper of ["ciphertext", "tag", "expiresAtMs", "key"] as const) {
    const pool = new MemoryPool();
    const input = fixture();
    const store = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => 1_000 });
    await store.consume(input);
    if (tamper !== "key") {
      const target = [...pool.values.keys()].find((name) => name.includes(tamper === "expiresAtMs" ? ":record-" : ":chunk-"))!;
      const data = JSON.parse(pool.values.get(target)!);
      data[tamper] = tamper === "expiresAtMs" ? data[tamper] + 1 : Buffer.alloc(Buffer.from(data[tamper], "base64").length, 0).toString("base64");
      pool.values.set(target, JSON.stringify(data));
    }
    const reader = tamper === "key" ? createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: Buffer.alloc(32, 7), now: () => 1_000 }) : store;
    assert.deepEqual(await reader.load(input.eventHash, input.manifest), { ok: false, code: "unavailable" });
  }
});

test("15 minute expiry clears encrypted chunks, keeps a stable tombstone and does not resurrect on replay", async () => {
  const pool = new MemoryPool(); let now = 1_000;
  const store = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => now });
  const input = fixture(); const receipt = await store.consume(input);
  now += MATRIX_CONSULTATION_MEDIA_TTL_MS;
  await store.purgeExpired();
  assert.ok(![...pool.values.keys()].some((name) => name.includes(":chunk-")));
  assert.deepEqual(await store.load(input.eventHash, input.manifest), { ok: false, code: "expired" });
  assert.deepEqual(await store.consume(input), receipt);
  assert.ok(![...pool.values.keys()].some((name) => name.includes(":chunk-")));
});

test("rejection and cancellation erase only the exact pending event, never resurrect after replay", async () => {
  const pool = new MemoryPool();
  const store = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => 1_000 });
  const first = fixture(); const second = fixture(jpeg("second"), "$second");
  const receipt = await store.consume(first); await store.consume(second);
  await store.erase(first.eventHash, "cancelled");
  assert.deepEqual(await store.load(first.eventHash, first.manifest), { ok: false, code: "rejected" });
  assert.deepEqual(await store.consume(first), receipt);
  const loaded = await store.load(second.eventHash, second.manifest);
  assert.equal(loaded.ok, true);
  if (loaded.ok) loaded.release();
});

test("accessible secrets are rejected without storing content; consent cannot bypass this", async () => {
  for (const secret of ["sk-" + "a".repeat(24), "password=veryPrivate", "-----BEGIN PRIVATE KEY-----", "Bearer " + "b".repeat(30), "UA" + "1".repeat(27)]) {
    const pool = new MemoryPool();
    const store = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => 1_000 });
    const input = fixture(jpeg(secret));
    const receipt = await store.consume(input);
    assert.deepEqual(Object.keys(receipt).sort(), ["consumptionReceiptHash", "eventHash"]);
    assert.equal(receipt.eventHash, input.eventHash);
    assert.match(receipt.consumptionReceiptHash, /^[a-f0-9]{64}$/u);
    assert.ok(![...pool.values.values()].join("").includes(secret));
    assert.ok(![...pool.values.keys()].some((name) => name.includes(":chunk-")));
    assert.deepEqual(await store.load(input.eventHash, input.manifest), { ok: false, code: "rejected" });
    store.close();
    const restarted = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => 2_000 });
    assert.deepEqual(await restarted.consume(input), receipt);
    assert.deepEqual(await restarted.load(input.eventHash, input.manifest), { ok: false, code: "rejected" });
    assert.ok(![...pool.values.keys()].some((name) => name.includes(":chunk-")));
    const index = [...pool.values.entries()].find(([name]) => name.endsWith(":pending-index"))!;
    assert.deepEqual(JSON.parse(index[1]).pending, [], "a rejected attachment never consumes pending work capacity");
  }
});

test("mismatched load manifests fail closed and close zeroes outstanding plaintext", async () => {
  const pool = new MemoryPool();
  const store = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => 1_000 });
  const input = fixture(); await store.consume(input);
  assert.deepEqual(await store.load(input.eventHash, [{ ...input.manifest[0]!, sha256: "d".repeat(64) }]), { ok: false, code: "mismatch" });
  const loaded = await store.load(input.eventHash, input.manifest);
  assert.equal(loaded.ok, true);
  store.close();
  if (loaded.ok) assert.ok(loaded.objects[0]!.bytes.every((byte) => byte === 0));
  assert.deepEqual(await store.load(input.eventHash, input.manifest), { ok: false, code: "unavailable" });
  await assert.rejects(store.consume(input));
});

test("pending event count is bounded across callers sharing the same database", async () => {
  const pool = new MemoryPool();
  const first = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => 1_000 });
  const second = createMySqlMatrixConsultationMediaStore({ pool, encryptionKey: key, now: () => 1_000 });
  await Promise.all(Array.from({ length: 64 }, (_, index) => (index % 2 ? first : second).consume(fixture(jpeg("image"), `$event-${index}`))));
  await assert.rejects(first.consume(fixture(jpeg("image"), "$over-capacity")));
  await first.erase(fixture(jpeg("image"), "$event-0").eventHash, "rejected");
  await second.consume(fixture(jpeg("image"), "$within-capacity"));
});

/** Minimal structurally valid source-controlled fixtures, not remote documents. */
function textPdf(texts: readonly string[] = ["Ordinary business report"], extraCatalog = "", compressed = false): Buffer {
  const objects: Buffer[] = [
    Buffer.from(`<< /Type /Catalog /Pages 2 0 R ${extraCatalog} >>`),
    Buffer.from(`<< /Type /Pages /Count ${texts.length} /Kids [${texts.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] >>`),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  ];
  for (const [index, text] of texts.entries()) {
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`));
    const source = Buffer.from(`BT /F1 ${text.length > 10_000 ? "0.001" : "12"} Tf 40 740 Td (${text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj ET`);
    const stream = compressed ? deflateSync(source) : source;
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${stream.length}${compressed ? " /Filter /FlateDecode" : ""} >>\nstream\n`), stream, Buffer.from("\nendstream")]));
  }
  const parts = [Buffer.from("%PDF-1.7\n")];
  const offsets = [0]; let length = parts[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(part); length += part.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

test("Node22 worker extracts actual text PDF with no native canvas or external service", async () => {
  const bytes = textPdf(["Ordinary business report", "Second page with profit discussion"]);
  const original = Buffer.from(bytes);
  const result = await extractPdfForConsultation(bytes);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.match(result.text, /Ordinary business report/u);
    assert.match(result.text, /Second page with profit discussion/u);
    assert.equal(result.totalPages, 2);
    assert.equal(result.contentMode, "text_only");
  }
  assert.deepEqual(bytes, original, "ownership transfer does not detach caller bytes");
});

test("extracted compressed secret is blocked before provider handoff", async () => {
  const bytes = textPdf(["password=topSecretValue"], "", true);
  assert.ok(!bytes.toString("latin1").includes("password=topSecretValue"));
  assert.deepEqual(await extractPdfForConsultation(bytes), { ok: false, code: "secret_content" });
});

test("scripts, escaped script names, XFA, embedded files and encrypted PDFs are refused", async () => {
  for (const content of [
    "/OpenAction << /S /JavaScript /JS (app.alert) >>",
    "/Java#53cript << /JS (app.alert) >>",
    "/XFA (data)", "/EmbeddedFile (data)", "/Encrypt (data)"
  ]) assert.deepEqual(await extractPdfForConsultation(textPdf(undefined, content)), { ok: false, code: "unsupported_pdf" });
});

test("scanned or mixed image-only pages are not silently omitted", async () => {
  assert.deepEqual(await extractPdfForConsultation(textPdf([""])), { ok: false, code: "scanned_pdf" });
  assert.deepEqual(await extractPdfForConsultation(textPdf(["Visible text", ""])), { ok: false, code: "scanned_pdf" });
});

test("PDF page and UTF8 output limits fail without returning partial text", async () => {
  assert.deepEqual(await extractPdfForConsultation(textPdf(Array.from({ length: 21 }, () => "Page"))), { ok: false, code: "limit_exceeded" });
  assert.deepEqual(await extractPdfForConsultation(textPdf(["x".repeat(70_000)])), { ok: false, code: "limit_exceeded" });
});

test("hard worker timeout and cancellation terminate before admitting the next extraction", async () => {
  assert.deepEqual(await extractPdfForConsultation(textPdf(), { timeoutMilliseconds: 1 }), { ok: false, code: "timed_out" });
  const controller = new AbortController();
  const pending = extractPdfForConsultation(textPdf(), { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await pending, { ok: false, code: "cancelled" });
  assert.equal((await extractPdfForConsultation(textPdf())).ok, true);
});

test("PDF worker concurrency is bounded and cannot be expanded through caller options", async () => {
  const first = extractPdfForConsultation(textPdf());
  assert.deepEqual(await extractPdfForConsultation(textPdf()), { ok: false, code: "unavailable" });
  assert.equal((await first).ok, true);
  assert.deepEqual(await extractPdfForConsultation(textPdf(), { timeoutMilliseconds: 6_000 }), { ok: false, code: "unavailable" });
  assert.deepEqual(await extractPdfForConsultation(Buffer.from("not a PDF")), { ok: false, code: "unsupported_pdf" });
});
