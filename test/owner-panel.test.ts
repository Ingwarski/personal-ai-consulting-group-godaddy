import assert from "node:assert/strict";
import test from "node:test";
import { ownerPanelDocument } from "../src/settings/ui/owner-panel.ts";
import { operationDocument, loginDocument } from "../src/godaddy/settings-runtime.ts";
import { matrixSetupDocument } from "../src/godaddy/matrix-setup-page.ts";

test("shared shell escapes titles and rejects script injection", () => {
  assert.match(ownerPanelDocument({ title: "<Title>&", content: "<h1>Content</h1>" }), /&lt;Title&gt;&amp;/);
  assert.throws(() => ownerPanelDocument({ title: "Title", content: "", scriptPath: '" onload="alert(1)' }));
});
test("utility pages retain action tokens and semantic navigation with independent provider sections", () => {
  const runtime = operationDocument({ codex: "ready", claude: "not_checked", catalogReady: false, actionTokens: { "/operations/runtime/catalog": "synthetic-token" } });
  assert.match(runtime, /aria-labelledby="codex-setup-title"/);
  assert.match(runtime, /aria-labelledby="claude-setup-title"/);
  assert.match(runtime, /aria-current="page">Підписки ШІ/);
  assert.equal((runtime.match(/name="formToken" value="synthetic-token"/g) ?? []).length, 2);
  assert.match(loginDocument("<unsafe>"), /value="&lt;unsafe&gt;"/);
  const matrix = matrixSetupDocument({ state: "prepared" }, "synthetic-token");
  assert.match(matrix, /\/assets\/owner-panel.css/);
  assert.match(matrix, /name="action" value="resume"/);
  assert.match(matrix, /data-owner-action-status/);
});
