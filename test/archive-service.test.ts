import assert from "node:assert/strict";
import test from "node:test";

import { ArchiveService } from "../src/archive/archive-service.ts";
import type { ArchiveRecord, ArchiveStorage, ArchiveTombstone } from "../src/archive/storage.ts";
import { RegistrarDO, type SessionGeneration } from "../src/session/registrar-do.ts";
import { resolveEffectiveSessionSnapshot } from "../src/settings/snapshot.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";
import { MemoryRegistrarStorage } from "./fixtures/memory-registrar-storage.ts";

class MemoryArchiveStorage implements ArchiveStorage {
  readonly records = new Map<string, ArchiveRecord>();
  readonly tombstones = new Map<string, ArchiveTombstone>();

  async get(archiveId: string): Promise<ArchiveRecord | undefined> {
    const value = this.records.get(archiveId);
    return value === undefined ? undefined : structuredClone(value);
  }

  async getTombstone(archiveId: string): Promise<ArchiveTombstone | undefined> {
    const value = this.tombstones.get(archiveId);
    return value === undefined ? undefined : structuredClone(value);
  }

  async stage(record: ArchiveRecord): Promise<void> {
    if (this.records.has(record.archiveId)) throw new Error("duplicate stage");
    this.records.set(record.archiveId, structuredClone(record));
  }

  async commit(archiveId: string): Promise<ArchiveRecord | undefined> {
    const staged = this.records.get(archiveId);
    if (staged === undefined || staged.lifecycle !== "staged") return undefined;
    const committed: ArchiveRecord = { ...staged, lifecycle: "committed" };
    this.records.set(archiveId, committed);
    return structuredClone(committed);
  }

  async tombstone(archiveId: string, tombstone: ArchiveTombstone): Promise<boolean> {
    if (!this.records.has(archiveId)) return false;
    this.records.delete(archiveId);
    this.tombstones.set(archiveId, structuredClone(tombstone));
    return true;
  }
}

async function closedTranscript(): Promise<Readonly<{ session: SessionGeneration; messages: Awaited<ReturnType<RegistrarDO["getConfirmedMessages"]>> }>> {
  const receipt = createCapabilityReceipt();
  const snapshot = resolveEffectiveSessionSnapshot({ sessionId: "archive-settings", settingsRevision: 1, settings: receipt.defaults, capabilityReceipt: receipt }, activeNow);
  if (!snapshot.ok) throw new Error("Expected snapshot.");
  const registrar = new RegistrarDO({ storage: new MemoryRegistrarStorage(), now: () => activeNow });
  const started = await registrar.startSession({ sessionId: "consultation-archive", settingsSnapshot: snapshot.value });
  if (!started.ok) throw new Error("Expected session.");
  for (const [eventId, role, body] of [
    ["archive-event-0001", "Фінансовий консультант", "Повний **висновок** фінансів."],
    ["archive-event-0002", "Критик", "Повна критика для головного консультанта."]
  ] as const) {
    const appended = await registrar.appendConfirmedMessage({ generation: started.value.generation, eventId, role, body });
    if (!appended.ok) throw new Error("Expected message.");
  }
  const stopped = await registrar.stopSession(started.value.generation);
  if (!stopped.ok) throw new Error("Expected stopped session.");
  return Object.freeze({ session: stopped.value, messages: await registrar.getConfirmedMessages(stopped.value.generation) });
}

async function archiveKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

test("seals an immutable whole transcript with AEAD and exports its exact visible bodies only after owner confirmation", async () => {
  const storage = new MemoryArchiveStorage();
  const service = new ArchiveService({ storage, now: () => activeNow });
  const key = await archiveKey();
  const transcript = await closedTranscript();
  const sealed = await service.seal({ ...transcript, key });
  assert.equal(sealed.ok, true);
  if (!sealed.ok) throw new Error("Expected archive.");
  const stored = storage.records.get(sealed.archiveId);
  assert.ok(stored);
  assert.equal(stored?.lifecycle, "committed");
  assert.doesNotMatch(JSON.stringify(stored), /Повний \*\*висновок\*\* фінансів|archive-event-0001/);
  assert.deepEqual(await service.exportWholeSession({ archiveId: sealed.archiveId, key, ownerConfirmed: false }), {
    ok: false, code: "owner_confirmation_required"
  });
  const exported = await service.exportWholeSession({ archiveId: sealed.archiveId, key, ownerConfirmed: true });
  assert.equal(exported.ok, true);
  if (!exported.ok) throw new Error("Expected export.");
  assert.deepEqual(exported.value.messages.map((message) => message.body), transcript.messages.map((message) => message.body));
  assert.doesNotMatch(JSON.stringify(exported.value), /internalEventId|bodyHash/);
  assert.deepEqual(await service.seal({ ...transcript, key }), {
    ok: true, archiveId: sealed.archiveId, replayed: true, manifest: sealed.manifest
  });
});

test("detects encrypted-content tampering and keeps whole-session deletion explicit, retry-safe and irreversible", async () => {
  const storage = new MemoryArchiveStorage();
  const service = new ArchiveService({ storage, now: () => activeNow });
  const key = await archiveKey();
  const transcript = await closedTranscript();
  const sealed = await service.seal({ ...transcript, key });
  if (!sealed.ok) throw new Error("Expected archive.");
  const current = storage.records.get(sealed.archiveId);
  if (current === undefined) throw new Error("Expected stored record.");
  storage.records.set(sealed.archiveId, { ...current, ciphertextBase64: `${current.ciphertextBase64.slice(0, -2)}AA` });
  assert.deepEqual(await service.exportWholeSession({ archiveId: sealed.archiveId, key, ownerConfirmed: true }), {
    ok: false, code: "archive_integrity_failed"
  });

  storage.records.set(sealed.archiveId, current);
  assert.deepEqual(await service.deleteWholeSession({ archiveId: sealed.archiveId, ownerConfirmed: false }), {
    ok: false, code: "owner_confirmation_required"
  });
  assert.deepEqual(await service.deleteWholeSession({ archiveId: sealed.archiveId, ownerConfirmed: true }), { ok: true, replayed: false });
  assert.deepEqual(await service.deleteWholeSession({ archiveId: sealed.archiveId, ownerConfirmed: true }), { ok: true, replayed: true });
  assert.deepEqual(await service.exportWholeSession({ archiveId: sealed.archiveId, key, ownerConfirmed: true }), {
    ok: false, code: "archive_deleted"
  });
  assert.deepEqual(await service.seal({ ...transcript, key }), { ok: false, code: "session_deleted" });
});
