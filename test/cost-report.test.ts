import assert from "node:assert/strict";
import test from "node:test";

import { formatCostReport, parseCostReport } from "../src/costs/cost-report.ts";

const factualInput = {
  reportedAt: "2026-08-16T18:00:00.000Z",
  subscriptions: [
    { provider: "ChatGPT/Codex", status: "configured", monthlyAmount: 20, currency: "USD", source: "owner_configured" },
    { provider: "Claude Code", status: "unknown" }
  ],
  infrastructure: [
    { service: "Cloudflare", period: "2026-08", amount: 0, currency: "USD", source: "Cloudflare invoice" },
    { service: "matrix.org", period: "2026-08", amount: 0, currency: "USD", source: "current free plan" }
  ],
  providerUsage: [
    { provider: "Codex", status: "available", reportedAt: "2026-08-16T17:59:00.000Z", usage: "доступно", limit: "у межах підписки" },
    { provider: "Claude Code", status: "unavailable", reportedAt: "2026-08-16T17:59:00.000Z" }
  ]
};

test("reports only configured subscription fees, factual infrastructure spend and provider status without fabricating session token cost", () => {
  const parsed = parseCostReport(factualInput);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("Expected factual report.");
  assert.equal(parsed.value.aiSessionMarginalCost, "included_in_subscription_not_attributable");
  const body = formatCostReport(parsed.value);
  assert.match(body, /20 USD\/міс/);
  assert.match(body, /matrix\.org: 0 USD за 2026-08/);
  assert.match(body, /сума не налаштована — невідомо/);
  assert.match(body, /не розподіляється на окрему сесію/);
  assert.doesNotMatch(body, /520|підсумок|token/i);
});

test("fails closed for a fabricated per-session/token amount, unknown fields, or incomplete provider status", () => {
  assert.deepEqual(parseCostReport({ ...factualInput, perSessionTokenCost: 12 }), { ok: false, code: "forbidden_session_cost" });
  assert.deepEqual(parseCostReport({ ...factualInput, subscriptions: factualInput.subscriptions.slice(0, 1) }), { ok: false, code: "invalid_cost_report" });
  assert.deepEqual(parseCostReport({ ...factualInput, providerUsage: [{ provider: "Codex", status: "available", reportedAt: "2026-08-16T17:59:00.000Z" }] }), {
    ok: false, code: "invalid_cost_report"
  });
});
