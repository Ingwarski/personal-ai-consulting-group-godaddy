import type { ArchiveService } from "../archive/archive-service.ts";
import type { InstructionDocumentService } from "../instructions/documents.ts";
import { isInstructionDocumentId } from "../instructions/documents.ts";
import { securityHeaders } from "../http/security-headers.ts";
import { ownerPanelDocument } from "../settings/ui/owner-panel.ts";
import type { BrowserConsultationService } from "./browser-consultation-service.ts";

export const OWNER_WORKSPACE_PATHS = new Set([
  "/consultation", "/api/consultations", "/api/consultations/stop",
  "/instructions", "/api/instructions", "/api/instructions/restore",
  "/api/archives/export", "/api/archives/delete",
  "/assets/consultation.js", "/assets/instructions.js"
]);

type OwnerWorkspaceDependencies = Readonly<{
  consultation: BrowserConsultationService;
  instructions: InstructionDocumentService;
  archiveService: ArchiveService;
  archiveKey: CryptoKey;
  issueActionToken: (path: string) => Promise<string | undefined>;
  verifyMutation: (request: Request, path: string) => Promise<boolean>;
  readAsset: (asset: "consultation.js" | "instructions.js") => Promise<Uint8Array>;
}>;

const escapeHtml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const response = (body: BodyInit | null, status: number, contentType: string, extra: HeadersInit = {}): Response => {
  const headers = securityHeaders(new Headers(extra));
  headers.set("content-type", contentType);
  return new Response(body, { status, headers });
};
const json = (body: unknown, status = 200, extra: HeadersInit = {}): Response => response(JSON.stringify(body), status, "application/json; charset=utf-8", extra);
const plain = (body: string, status: number, extra: HeadersInit = {}): Response => response(body, status, "text/plain; charset=utf-8", extra);

async function body(request: Request, maximumBytes: number): Promise<unknown | undefined> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return undefined;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) return undefined;
  try {
    const reader = request.body?.getReader();
    if (reader === undefined) return undefined;
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximumBytes) { await reader.cancel(); return undefined; }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export async function handleOwnerWorkspace(request: Request, input: OwnerWorkspaceDependencies): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!OWNER_WORKSPACE_PATHS.has(url.pathname)) return undefined;

  if (url.pathname === "/assets/consultation.js" || url.pathname === "/assets/instructions.js") {
    if (request.method !== "GET") return plain("Method not allowed.", 405, { allow: "GET" });
    const asset = url.pathname.endsWith("consultation.js") ? "consultation.js" : "instructions.js";
    const bytes = await input.readAsset(asset);
    return response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 200, "application/javascript; charset=utf-8");
  }

  if (url.pathname === "/consultation") {
    if (request.method !== "GET") return plain("Method not allowed.", 405, { allow: "GET" });
    const [submitToken, stopToken, exportToken, deleteToken] = await Promise.all([
      input.issueActionToken("/api/consultations"), input.issueActionToken("/api/consultations/stop"),
      input.issueActionToken("/api/archives/export"), input.issueActionToken("/api/archives/delete")
    ]);
    if ([submitToken, stopToken, exportToken, deleteToken].some(token => token === undefined)) return plain("Access denied.", 403);
    return response(ownerPanelDocument({ title: "Consultation", section: "consultation", scriptPath: "/assets/consultation.js", content: `
      <h1>Private consultation</h1>
      <p>Your request is sent only after explicit consent. Passwords, access tokens, payment-card data and government identifiers are rejected.</p>
      <form id="consultation-form" data-submit-token="${escapeHtml(submitToken!)}">
        <label for="consultation-task">Request</label>
        <textarea id="consultation-task" name="task" rows="10" maxlength="64000" required></textarea>
        <label><input id="consultation-consent" type="checkbox" required> I consent to processing this request with the configured AI providers.</label>
        <button type="submit">Start consultation</button>
      </form>
      <div id="consultation-state" role="status" aria-live="polite"></div>
      <div id="consultation-messages" aria-live="polite"></div>
      <div class="owner-actions">
        <button id="consultation-stop" type="button" data-token="${escapeHtml(stopToken!)}" disabled>Stop</button>
        <button id="consultation-export" type="button" data-token="${escapeHtml(exportToken!)}" disabled>Export encrypted archive</button>
        <button id="consultation-delete" type="button" data-token="${escapeHtml(deleteToken!)}" disabled>Delete whole archive</button>
      </div>
    ` }), 200, "text/html; charset=utf-8");
  }

  if (url.pathname === "/instructions") {
    if (request.method !== "GET") return plain("Method not allowed.", 405, { allow: "GET" });
    const [saveToken, restoreToken] = await Promise.all([
      input.issueActionToken("/api/instructions"), input.issueActionToken("/api/instructions/restore")
    ]);
    if (saveToken === undefined || restoreToken === undefined) return plain("Access denied.", 403);
    return response(ownerPanelDocument({ title: "Instructions", section: "instructions", scriptPath: "/assets/instructions.js", content: `
      <h1>Instructions</h1>
      <p>These Markdown documents are encrypted in the database and pinned into each new consultation snapshot. They cannot change authentication, consent, provider, tool or security rules.</p>
      <label for="instruction-document">Document</label><select id="instruction-document"></select>
      <label for="instruction-markdown">Markdown</label><textarea id="instruction-markdown" rows="28" maxlength="65536"></textarea>
      <div class="owner-actions">
        <button id="instruction-save" type="button" data-token="${escapeHtml(saveToken)}">Save</button>
        <button id="instruction-restore" type="button" data-token="${escapeHtml(restoreToken)}">Restore reviewed repository default</button>
      </div>
      <p id="instruction-status" role="status" aria-live="polite"></p>
    ` }), 200, "text/html; charset=utf-8");
  }

  if (url.pathname === "/api/consultations" && request.method === "GET") {
    if (url.searchParams.size > 1 || [...url.searchParams.keys()].some(key => key !== "requestId")) return json({ error: "invalid_request" }, 400);
    const requestId = url.searchParams.get("requestId");
    const view = requestId === null ? await input.consultation.latest() : await input.consultation.read(requestId);
    return json({ consultation: view ?? null });
  }

  if (["/api/instructions"].includes(url.pathname) && request.method === "GET") {
    if (url.search) return json({ error: "invalid_request" }, 400);
    return json({ documents: await input.instructions.list() });
  }

  if (!["POST", "PUT"].includes(request.method)) return plain("Method not allowed.", 405);
  if (!await input.verifyMutation(request, url.pathname)) return json({ error: "forbidden" }, 403);
  const value = await body(request, url.pathname === "/api/instructions" ? 70_000 : 70_000);
  if (value === undefined) return json({ error: "invalid_json" }, 400);

  if (url.pathname === "/api/consultations") {
    if (request.method !== "POST" || !exactRecord(value, ["requestId", "task", "consent"]) || typeof value.task !== "string" || typeof value.consent !== "boolean" || typeof value.requestId !== "string") return json({ error: "invalid_request" }, 422);
    const result = await input.consultation.submit({ requestId: value.requestId, task: value.task, consent: value.consent });
    return result.ok ? json(result, result.replayed ? 200 : 202) : json({ error: result.code }, result.code === "busy" ? 409 : 422);
  }
  if (url.pathname === "/api/consultations/stop") {
    if (request.method !== "POST" || !exactRecord(value, ["requestId"]) || typeof value.requestId !== "string") return json({ error: "invalid_request" }, 422);
    const result = await input.consultation.stop(value.requestId);
    return result.ok ? json(result) : json({ error: result.code }, result.code === "not_found" ? 404 : 409);
  }
  if (url.pathname === "/api/instructions") {
    if (request.method !== "PUT" || !exactRecord(value, ["id", "expectedRevision", "markdown"]) || !isInstructionDocumentId(value.id) || !Number.isSafeInteger(value.expectedRevision) || typeof value.markdown !== "string") return json({ error: "invalid_document" }, 422);
    const result = await input.instructions.update({ id: value.id, expectedRevision: value.expectedRevision as number, markdown: value.markdown });
    return result.ok ? json(result) : json({ error: result.code }, result.code === "revision_conflict" ? 409 : 422);
  }
  if (url.pathname === "/api/instructions/restore") {
    if (request.method !== "POST" || !exactRecord(value, ["id", "expectedRevision", "confirmed"]) || !isInstructionDocumentId(value.id) || !Number.isSafeInteger(value.expectedRevision) || value.confirmed !== true) return json({ error: "invalid_document" }, 422);
    const result = await input.instructions.restoreDefault({ id: value.id, expectedRevision: value.expectedRevision as number });
    return result.ok ? json(result) : json({ error: result.code }, result.code === "revision_conflict" ? 409 : 422);
  }
  if (url.pathname === "/api/archives/export") {
    if (request.method !== "POST" || !exactRecord(value, ["archiveId", "confirmed"]) || typeof value.archiveId !== "string" || value.confirmed !== true) return json({ error: "owner_confirmation_required" }, 422);
    const result = await input.archiveService.exportWholeSession({ archiveId: value.archiveId, key: input.archiveKey, ownerConfirmed: true });
    return result.ok ? json(result.value, 200, { "content-disposition": `attachment; filename="${value.archiveId}.json"` }) : json({ error: result.code }, result.code === "archive_not_found" ? 404 : 409);
  }
  if (url.pathname === "/api/archives/delete") {
    if (request.method !== "POST" || !exactRecord(value, ["archiveId", "confirmed"]) || typeof value.archiveId !== "string" || value.confirmed !== true) return json({ error: "owner_confirmation_required" }, 422);
    const result = await input.archiveService.deleteWholeSession({ archiveId: value.archiveId, ownerConfirmed: true });
    return result.ok ? json(result) : json({ error: result.code }, result.code === "archive_not_found" ? 404 : 409);
  }
  return json({ error: "not_found" }, 404);
}
