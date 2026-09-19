import assert from "node:assert/strict";
import test from "node:test";

import type { ArchiveService } from "../src/archive/archive-service.ts";
import type { BrowserConsultationService } from "../src/godaddy/browser-consultation-service.ts";
import { handleOwnerWorkspace } from "../src/godaddy/owner-workspace-routes.ts";
import type { InstructionDocumentService } from "../src/instructions/documents.ts";

const record = Object.freeze({
  version: 1 as const,
  requestId: "request-browser-0001",
  sessionId: "session-request-browser-0001",
  taskSha256: "a".repeat(64),
  status: "completed" as const,
  outcome: "direct" as const,
  archiveId: "session-session-request-browser-0001-1",
  createdAt: "2026-09-19T09:00:00.000Z",
  updatedAt: "2026-09-19T09:00:00.000Z"
});

async function dependencies(input: Readonly<{ mutationAllowed?: boolean }> = {}) {
  const archiveKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const consultation = {
    async submit() { return { ok: true as const, record, replayed: false }; },
    async latest() { return { record, messages: [] }; },
    async read() { return { record, messages: [] }; },
    async stop() { return { ok: true as const, record: { ...record, status: "stopped" as const } }; },
    async start() {}, async close() {}
  } as BrowserConsultationService;
  const document = Object.freeze({ id: "agents" as const, title: "Consulting behavior", revision: 1,
    markdown: "# Rules", sha256: "b".repeat(64), updatedAt: "2026-09-19T09:00:00.000Z" });
  const instructions = {
    async initialize() {}, async list() { return [document]; }, async read() { return document; },
    async update() { return { ok: true as const, document: { ...document, revision: 2 } }; },
    async restoreDefault() { return { ok: true as const, document: { ...document, revision: 2 } }; },
    async snapshot() { return { capturedAt: document.updatedAt, documents: [document] }; }
  } as InstructionDocumentService;
  const archiveService = {
    async exportWholeSession() { return { ok: true as const, value: { schemaVersion: "v1" as const, session: {
      sessionId: record.sessionId, generation: 1, startedAt: record.createdAt, settingsSnapshot: {}
    }, messages: [] } }; },
    async deleteWholeSession() { return { ok: true as const, replayed: false }; }
  } as unknown as ArchiveService;
  return {
    consultation, instructions, archiveService, archiveKey,
    async issueActionToken(path: string) { return `token:${path}`; },
    async verifyMutation(_request: Request, path: string) { return input.mutationAllowed === true && path.startsWith("/api/"); },
    async readAsset(asset: string) { return new TextEncoder().encode(`// ${asset}`); }
  };
}

const jsonRequest = (path: string, method: string, value: unknown): Request => new Request(`https://app.example${path}`, {
  method,
  headers: { "content-type": "application/json", origin: "https://app.example", "x-owner-action-token": `token:${path}` },
  body: JSON.stringify(value)
});

test("workspace pages issue purpose-bound tokens without placing instruction text into HTML", async () => {
  const response = await handleOwnerWorkspace(new Request("https://app.example/instructions"), await dependencies());
  assert.equal(response?.status, 200);
  const html = await response!.text();
  assert.match(html, /data-token="token:&#x2F;api&#x2F;instructions"|data-token="token:\/api\/instructions"/u);
  assert.doesNotMatch(html, /# Rules/u);
  assert.match(response!.headers.get("content-security-policy") ?? "", /default-src/u);
});

test("workspace mutations fail closed before parsing or changing state", async () => {
  const response = await handleOwnerWorkspace(jsonRequest("/api/instructions", "PUT", {
    id: "agents", expectedRevision: 1, markdown: "# Changed"
  }), await dependencies());
  assert.equal(response?.status, 403);
  assert.deepEqual(await response!.json(), { error: "forbidden" });
});

test("instruction writes require an exact bounded payload and revision", async () => {
  const input = await dependencies({ mutationAllowed: true });
  const accepted = await handleOwnerWorkspace(jsonRequest("/api/instructions", "PUT", {
    id: "agents", expectedRevision: 1, markdown: "# Changed"
  }), input);
  assert.equal(accepted?.status, 200);
  const extra = await handleOwnerWorkspace(jsonRequest("/api/instructions", "PUT", {
    id: "agents", expectedRevision: 1, markdown: "# Changed", provider: "other"
  }), input);
  assert.equal(extra?.status, 422);
});

test("whole-session export and deletion require explicit confirmation", async () => {
  const input = await dependencies({ mutationAllowed: true });
  for (const path of ["/api/archives/export", "/api/archives/delete"]) {
    const response = await handleOwnerWorkspace(jsonRequest(path, "POST", {
      archiveId: record.archiveId, confirmed: false
    }), input);
    assert.equal(response?.status, 422);
    assert.deepEqual(await response!.json(), { error: "owner_confirmation_required" });
  }
});

test("workspace serves only known assets and rejects unsupported methods", async () => {
  const input = await dependencies();
  const asset = await handleOwnerWorkspace(new Request("https://app.example/assets/consultation.js"), input);
  assert.equal(asset?.status, 200);
  assert.equal(await asset!.text(), "// consultation.js");
  const method = await handleOwnerWorkspace(new Request("https://app.example/consultation", { method: "DELETE" }), input);
  assert.equal(method?.status, 405);
  assert.equal(await handleOwnerWorkspace(new Request("https://app.example/not-managed"), input), undefined);
});
