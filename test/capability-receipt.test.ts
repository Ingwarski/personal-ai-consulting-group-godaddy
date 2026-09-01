import assert from "node:assert/strict";
import test from "node:test";

import { decodeCapabilityReceipt, encodeCapabilityReceipt, parseCapabilityReceipt } from "../src/settings/capability-receipt.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

test("a capability receipt round-trips only when its complete catalog remains trusted and current", () => {
  const receipt = createCapabilityReceipt();
  const encoded = encodeCapabilityReceipt(receipt);
  assert.deepEqual(decodeCapabilityReceipt(encoded, activeNow), receipt);
  assert.deepEqual(parseCapabilityReceipt(receipt, activeNow), receipt);
});

test("capability receipt parsing has no fallback for retired, malformed or untrusted models", () => {
  const base = createCapabilityReceipt();
  assert.equal(parseCapabilityReceipt({ ...base, trusted: false }, activeNow), undefined);
  assert.equal(parseCapabilityReceipt({ ...base, defaults: { ...base.defaults, reasoningDepth: "invalid" } }, activeNow), undefined);
  assert.equal(parseCapabilityReceipt({ ...base, codexModels: [{ ...base.codexModels[0], supportedReasoningDepths: ["xhigh"], reasoningMappings: {} }] }, activeNow), undefined);
  assert.equal(decodeCapabilityReceipt("bad!header", activeNow), undefined);
});
