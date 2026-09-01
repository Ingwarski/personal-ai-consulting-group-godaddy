import assert from "node:assert/strict";
import test from "node:test";

import { deriveInternalEventId, isInternalEventId } from "../src/identity/ids.ts";

test("derives one stable ledger-safe event ID from short or mixed-case provider references", async () => {
  const short = await deriveInternalEventId("codex", "A");
  const mixed = await deriveInternalEventId("claude", "Turn_MixedCase_42");
  assert.equal(isInternalEventId(short), true);
  assert.equal(isInternalEventId(mixed), true);
  assert.equal(await deriveInternalEventId("codex", "A"), short);
  assert.notEqual(short, mixed);
});
