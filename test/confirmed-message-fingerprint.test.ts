import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { confirmedMessageFingerprint, type ConfirmedAgentAuthority } from "../src/session/registrar-do.ts";

function permutations<T>(items: readonly T[]): T[][] {
  return items.length === 0 ? [[]] : items.flatMap((item, index) =>
    permutations(items.filter((_, i) => i !== index)).map(rest => [item, ...rest]));
}

test("authority hashes ignore all JSON key permutations but preserve the producer's existing digest", async () => {
  const authority: ConfirmedAgentAuthority = {
    agentId: "critic", provider: "codex", runtimeSessionRef: "critic-thread-01", kind: "critique"
  };
  const base = { role: "Критик", body: "Київ: перевірте припущення.", addressedTo: "Головний консультант", replyToEventId: "$owner-event-01" };
  const original = createHash("sha256").update(JSON.stringify({ ...base, authority })).digest("hex");
  for (const keys of permutations(Object.keys(authority))) {
    const reordered = Object.fromEntries(keys.map(key => [key, authority[key as keyof ConfirmedAgentAuthority]])) as ConfirmedAgentAuthority;
    assert.equal(await confirmedMessageFingerprint({ ...base, authority: reordered }), original);
  }
  for (const changed of [
    { ...authority, agentId: "head" }, { ...authority, provider: "claude_code" as const },
    { ...authority, runtimeSessionRef: "another-thread" }, { ...authority, kind: "revision" as const }
  ]) assert.notEqual(await confirmedMessageFingerprint({ ...base, authority: changed }), original);
  assert.notEqual(await confirmedMessageFingerprint(base), original);
  assert.notEqual(await confirmedMessageFingerprint({ ...base, body: base.body + "!", authority }), original);
});

test("ordinary and control message fingerprints remain byte-compatible", async () => {
  const input = { role: "Система", body: "Запит прийнято." };
  const original = createHash("sha256").update(JSON.stringify({ ...input, addressedTo: null, replyToEventId: null })).digest("hex");
  assert.equal(await confirmedMessageFingerprint(input), original);
});
