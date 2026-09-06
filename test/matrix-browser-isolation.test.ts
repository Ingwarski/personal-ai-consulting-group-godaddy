import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { MATRIX_VERIFIER_HASH, matrixVerifierJavaScript, runMatrixBrowserChecks, validMatrixBrowserReport,
  matrixPreviewVerifierResponse, MATRIX_PREVIEW_VERIFIER, MATRIX_VERIFIER_SCRIPT_PATH, type MatrixBrowserChallenge } from "../src/godaddy/matrix-browser-isolation.ts";

const challenge = (): MatrixBrowserChallenge => ({ nonce: "1".repeat(32), expiresAt: Date.now() + 60000, verifierHash: MATRIX_VERIFIER_HASH,
  paths: ["/assets", "/public/assets"].flatMap(prefix => ["crypto-store", "media-spool"].map(dir => `${prefix}/.personal-consultant-matrix-v1/${dir}/private-path-check-${"2".repeat(32)}`))
    .concat(["/.runtime/matrix/personal-consultant-matrix-sidecar", "/.runtime/matrix/personal-consultant-matrix-setup"]),
  canaries: [`matrix-private-path-canary:${"3".repeat(32)}`],
  positivePath: `/assets/matrix-isolation-positive-${"4".repeat(32)}.txt`, positiveBody: `matrix-isolation-positive:${"5".repeat(32)}` });

test("browser verifier checks actual shared-mount positive body and six denial bodies without transmitting content", async () => {
  const c = challenge(); const paths: string[] = [];
  const report = await runMatrixBrowserChecks(c, async (input, init) => {
    paths.push(String(input)); assert.equal(init?.credentials, "same-origin"); assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store"); assert.ok(init?.signal);
    return String(input) === c.positivePath ? new Response(c.positiveBody) : new Response("Not found", { status: 404 });
  });
  assert.equal(validMatrixBrowserReport(report, c), true); assert.equal(paths.length, 7);
  assert.ok(!JSON.stringify(report).includes(c.positiveBody)); assert.ok(!JSON.stringify(report).includes(c.canaries[0]!));
  for (const changed of [{ ...report, nonce: "wrong" }, { ...report, positive: false }, { ...report, verifierHash: "old" },
    { ...report, results: report.results.slice(1) }, { ...report, results: [...report.results].reverse() },
    { ...report, results: report.results.map(r => ({ ...r, status: 401 })) }, { ...report, cookies: "forbidden" }]) {
    assert.equal(validMatrixBrowserReport(changed, c), false);
  }
});
test("wrong/missing public control proves neither authentication nor shared storage and makes no private requests", async () => {
  for (const response of [new Response("wrong"), new Response("login", { status: 401 }), new Response("Not found", { status: 404 })]) {
    let calls = 0; const c = challenge();
    const report = await runMatrixBrowserChecks(c, async () => { calls++; return response; });
    assert.equal(validMatrixBrowserReport(report, c), false); assert.equal(calls, 1);
  }
});
test("Preview rejects login/redirect/errors, overlong bodies, leaked canaries/ELF/binding and opaque results", async () => {
  const c = challenge();
  const cases = [() => new Response("login"), () => new Response("login", { status: 401 }),
    () => new Response(null, { status: 302 }), () => new Response("bad", { status: 500 }),
    () => new Response("x".repeat(65537), { status: 404 }), () => new Response(c.canaries[0], { status: 404 }),
    () => new Response("\u007fELF", { status: 404 }), () => new Response('{"device_id":"secret"}', { status: 404 }),
    () => { throw Error("network"); }, () => {
      const r = new Response("Not found", { status: 404 }); Object.defineProperty(r, "type", { value: "opaque" }); return r;
    }];
  for (const make of cases) {
    const report = await runMatrixBrowserChecks(c, async input => String(input) === c.positivePath ? new Response(c.positiveBody) : make());
    assert.equal(validMatrixBrowserReport(report, c), false);
  }
});
test("fixed Preview asset binds opener/origin/nonce and rejects service-worker synthetic HTTP", async () => {
  const c = challenge(); const messages: unknown[] = []; const listeners = new Map<string, Function>(); let calls = 0;
  const opener = { postMessage: (value: unknown, origin: string) => { assert.equal(origin, "https://wy2v0putg6.c35.airoapp.ai"); messages.push(value); } };
  const context = { window: { opener, addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
    location: { origin: "https://wy2v0putg6.preview.c35.airoapp.ai", hash: `#${c.nonce}` },
    navigator: { serviceWorker: { controller: null } }, document: { querySelector: () => ({ textContent: "" }) },
    TextDecoder, Uint8Array, AbortSignal, Date, fetch: async (path: string) => { calls++; return path === c.positivePath ? new Response(c.positiveBody) : new Response("Not found", { status: 404 }); } };
  runInNewContext(matrixVerifierJavaScript, context);
  assert.equal(messages.length, 1);
  const listener = listeners.get("message")!;
  await listener({ origin: "https://evil.test", source: opener, data: c });
  await listener({ origin: "https://wy2v0putg6.c35.airoapp.ai", source: {}, data: c });
  await listener({ origin: "https://wy2v0putg6.c35.airoapp.ai", source: opener, data: { ...c, paths: ["https://evil.test"] } });
  assert.equal(calls, 0);
  await listener({ origin: "https://wy2v0putg6.c35.airoapp.ai", source: opener, data: c });
  assert.equal(calls, 7); assert.equal(validMatrixBrowserReport(messages[1], c), true);
  await listener({ origin: "https://wy2v0putg6.c35.airoapp.ai", source: opener, data: c }); assert.equal(calls, 7);
  calls = 0; messages.length = 0;
  runInNewContext(matrixVerifierJavaScript, { ...context, navigator: { serviceWorker: { controller: {} } } });
  assert.equal(calls, 0); assert.equal(messages.length, 0);
});
test("Preview verifier route is static GET-only and cannot accept state or credentials", () => {
  for (const path of [MATRIX_PREVIEW_VERIFIER, MATRIX_VERIFIER_SCRIPT_PATH]) {
    const response = matrixPreviewVerifierResponse(new Request(`https://preview.test${path}`));
    assert.equal(response?.status, 200); assert.equal(response?.headers.get("cache-control"), "no-store");
    assert.equal(matrixPreviewVerifierResponse(new Request(`https://preview.test${path}?token=forbidden`))?.status, 400);
    assert.equal(matrixPreviewVerifierResponse(new Request(`https://preview.test${path}`, { method: "POST" }))?.status, 400);
  }
  assert.equal(matrixPreviewVerifierResponse(new Request("https://preview.test/other")), undefined);
});
