import { createHash } from "node:crypto";
import { securityHeaders } from "../http/security-headers.ts";

export const MATRIX_PREVIEW_ORIGIN = "https://wy2v0putg6.preview.c35.airoapp.ai";
export const MATRIX_PUBLISHED_ORIGIN = "https://wy2v0putg6.c35.airoapp.ai";
export const MATRIX_PREVIEW_VERIFIER = "/operations/matrix/preview-isolation";
export type MatrixControlVisibility = "published_control_visible_in_preview" | "published_control_not_visible_in_preview";
export type MatrixBrowserChallenge = Readonly<{
  nonce: string; expiresAt: number; verifierHash: string;
  paths: readonly string[]; canaries: readonly string[];
  positivePath: string; positiveBody: string;
}>;
export type MatrixBrowserReport = Readonly<{
  nonce: string; verifierHash: string; positive: boolean;
  controlVisibility: MatrixControlVisibility | "unconfirmed";
  results: readonly Readonly<{ path: string; status: number; denied: boolean }>[];
}>;

// Exported so the exact function tested in Node is serialized into the fixed
// browser asset. No response body, cookies or platform share token leave Preview.
export async function runMatrixBrowserChecks(challenge: MatrixBrowserChallenge, fetchImpl: typeof fetch): Promise<MatrixBrowserReport> {
  const read = async (path: string): Promise<{ status: number; bytes: Uint8Array; controlResult: string | null } | undefined> => {
    try {
      const response = await fetchImpl(path, { method: "GET", credentials: "same-origin", redirect: "error",
        cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(5_000),
        headers: { Accept: "application/octet-stream", "Cache-Control": "no-cache" } });
      if (response.redirected || response.type === "opaque" || response.type === "opaqueredirect") return undefined;
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      if (reader !== undefined) try {
        for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength;
          if (length > 65_536) return undefined; chunks.push(next.value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { status: response.status, bytes, controlResult: response.headers.get("x-matrix-control-result") };
    } catch { return undefined; }
  };
  const positive = await read(challenge.positivePath);
  const controlBody = positive === undefined ? "" : new TextDecoder().decode(positive.bytes);
  // Published proves the exact marker exists over HTTP before and after this
  // report. Preview need not share its files; a generic 404 is never sufficient.
  const controlVisibility = positive?.status === 200 && positive.controlResult === "ok" && controlBody === challenge.positiveBody
    ? "published_control_visible_in_preview"
    : positive?.status === 404 && positive.controlResult === "missing_file" && controlBody === "Not found."
      ? "published_control_not_visible_in_preview" : "unconfirmed";
  const positiveOk = controlVisibility !== "unconfirmed";
  const signatures = ["\u007fELF", '"device_id"', '"store_fingerprint"', '"bot_mxid"', ...challenge.canaries];
  const results = await Promise.all(challenge.paths.map(async path => {
    const response = positiveOk ? await read(path) : undefined;
    const body = response === undefined ? "" : new TextDecoder("latin1").decode(response.bytes);
    return { path, status: response?.status ?? 0, denied: response !== undefined
      && (response.status === 403 || response.status === 404) && signatures.every(value => !body.includes(value)) };
  }));
  return { nonce: challenge.nonce, verifierHash: challenge.verifierHash, positive: positiveOk, controlVisibility, results };
}

export function validMatrixBrowserReport(value: unknown, challenge: MatrixBrowserChallenge): value is MatrixBrowserReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as MatrixBrowserReport;
  return Object.keys(report).sort().join() === "controlVisibility,nonce,positive,results,verifierHash"
    && report.nonce === challenge.nonce && report.verifierHash === challenge.verifierHash && report.positive === true
    && (report.controlVisibility === "published_control_visible_in_preview" || report.controlVisibility === "published_control_not_visible_in_preview")
    && Array.isArray(report.results) && report.results.length === challenge.paths.length
    && report.results.every((item, index) => typeof item === "object" && item !== null
      && Object.keys(item).sort().join() === "denied,path,status" && item.path === challenge.paths[index]
      && (item.status === 403 || item.status === 404) && item.denied === true);
}

const bootstrap = String.raw`
(() => {
  const published = "https://wy2v0putg6.c35.airoapp.ai";
  const preview = "https://wy2v0putg6.preview.c35.airoapp.ai";
  const nonce = location.hash.slice(1);
  const output = document.querySelector("[data-verifier-status]");
  const say = text => { if (output) output.textContent = text; };
  const openerWindow = window.opener;
  if (location.origin !== preview || !openerWindow || !/^[a-f0-9]{32}$/.test(nonce)
      || navigator.serviceWorker?.controller) { say("Перевірка недоступна: відкрийте її з Published. Service Worker не допускається."); return; }
  let used = false;
  window.addEventListener("message", async event => {
    if (event.origin !== published || event.source !== openerWindow || used) return;
    const c = event.data;
    const privatePath = /^\/(?:assets|public\/assets)\/\.personal-consultant-matrix-v1\/(?:crypto-store|media-spool)\/(?:private-path-check-[a-f0-9]{32}|device-binding\.json|provisioning-intent\.json)$/;
    const binaryPath = /^\/runtime\/matrix\/personal-consultant-matrix-(?:sidecar|setup)$/;
    if (!c || c.nonce !== nonce || c.verifierHash !== VERIFIER_HASH || !Number.isSafeInteger(c.expiresAt)
      || c.expiresAt <= Date.now() || c.expiresAt > Date.now() + 300000 || !Array.isArray(c.paths)
      || c.paths.length !== 6 || new Set(c.paths).size !== 6 || c.paths.some(p => typeof p !== "string" || !(privatePath.test(p) || binaryPath.test(p)))
      || !Array.isArray(c.canaries) || c.canaries.length < 1 || c.canaries.length > 2
      || c.canaries.some(v => typeof v !== "string" || !/^matrix-private-path-canary:[a-f0-9]{32}$/.test(v))
      || !/^\/assets\/matrix-isolation-positive-[a-f0-9]{32}\.txt$/.test(c.positivePath)
      || !/^matrix-isolation-positive:[a-f0-9]{32}$/.test(c.positiveBody)) { say("Невідповідний або прострочений запит перевірки."); return; }
    used = true; say("Перевіряємо реальні HTTP-відповіді. Паролі та cookies залишаються в цьому браузері.");
    const result = await runMatrixBrowserChecks(c, fetch);
    if (navigator.serviceWorker?.controller || Date.now() >= c.expiresAt) result.positive = false;
    say(result.positive && result.results.every(r => r.denied) ? "Перевірка Preview пройдена. Результат передано Published." : "Перевірка не пройдена. Секрети не створено. Поверніться до Published.");
    openerWindow.postMessage(result, published);
  });
  openerWindow.postMessage({ type: "matrix-preview-ready", nonce, verifierHash: VERIFIER_HASH }, published);
})();`;
const source = `const runMatrixBrowserChecks = ${runMatrixBrowserChecks.toString()};\n${bootstrap}`;
// Hash the template (including the tested checker), then inject its identity.
export const MATRIX_VERIFIER_HASH = createHash("sha256").update(source).digest("hex");
export const MATRIX_VERIFIER_SCRIPT_PATH = `/assets/matrix-preview-isolation.${MATRIX_VERIFIER_HASH}.js`;
export const matrixVerifierJavaScript = `const VERIFIER_HASH = "${MATRIX_VERIFIER_HASH}";\n${source}`;
export function matrixPreviewVerifierResponse(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (url.pathname !== MATRIX_PREVIEW_VERIFIER && url.pathname !== MATRIX_VERIFIER_SCRIPT_PATH) return undefined;
  if (request.method !== "GET" || url.search) return new Response("Invalid verifier request.", { status: 400, headers: securityHeaders() });
  if (url.pathname === MATRIX_VERIFIER_SCRIPT_PATH) return new Response(matrixVerifierJavaScript,
    { headers: securityHeaders({ "content-type": "application/javascript; charset=utf-8" }) });
  return new Response(`<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Перевірка приватності Preview</title><link rel="stylesheet" href="/assets/owner-panel.css"><script src="${MATRIX_VERIFIER_SCRIPT_PATH}" defer></script></head><body class="settings-shell"><main class="settings-page owner-panel"><div class="owner-panel-content"><h1>Перевірка приватності Preview</h1><p role="status" data-verifier-status>Очікуємо захищений запит із Published.</p><p>Ця сторінка лише читає тимчасові контрольні файли. Вона не змінює Preview і не передає cookies, ключі або вміст відповідей.</p></div></main></body></html>`,
    { headers: securityHeaders({ "content-type": "text/html; charset=utf-8" }) });
}
