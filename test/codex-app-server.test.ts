import assert from "node:assert/strict";
import test from "node:test";

import { probeCodexAppServer } from "../src/runtime/codex-app-server.ts";

const readyResponses: Record<string, unknown> = {
  "account/read": { account: { type: "chatgpt", planType: "subscription" }, requiresOpenaiAuth: true },
  "model/list": {
    data: [{
      id: "runtime-selected-codex",
      model: "runtime-selected-codex",
      displayName: "Runtime Codex",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }]
    }]
  },
  "account/rateLimits/read": { rateLimits: { rateLimitReachedType: null } }
};

test("discovery paginates the full runtime catalog and retains only the explicitly requested hidden Astra", async () => {
  const modelCalls: unknown[] = [];
  const astra = { id: "astra-option", model: "gpt-6-astra", displayName: "GPT-6 Astra", hidden: true,
    supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] };
  const result = await probeCodexAppServer({ request: async (method, params) => {
    if (method !== "model/list") return readyResponses[method];
    modelCalls.push(params);
    const cursor = (params as { cursor?: string }).cursor;
    return cursor === undefined ? { ...readyResponses[method] as object, nextCursor: "page-two" }
      : { data: [astra, { ...astra, id: "gpt-6-astra", model: "another-hidden-model" }], nextCursor: null };
  } }, { privateSingleOwner: true });
  assert.equal(result.runtime.readiness, "ready");
  assert.deepEqual(result.models.map(model => model.productId), ["runtime-selected-codex", "astra-option"]);
  assert.equal(modelCalls.length, 2);
  assert.ok(modelCalls.every(params => (params as { includeHidden: boolean }).includeHidden));
});

test("discovery rejects a cyclic pagination cursor instead of looping or accepting an incomplete catalog", async () => {
  let calls = 0;
  const result = await probeCodexAppServer({ request: async (method) => {
    if (method !== "model/list") return readyResponses[method];
    calls++;
    return { ...readyResponses[method] as object, nextCursor: "repeated" };
  } }, { privateSingleOwner: true });
  assert.equal(result.runtime.readiness, "unavailable");
  assert.equal(calls, 2);
});

test("Codex capability discovery accepts only managed ChatGPT OAuth and the app-server's visible model catalog", async () => {
  const calls: string[] = [];
  const result = await probeCodexAppServer({
    request: async (method) => {
      calls.push(method);
      return readyResponses[method];
    }
  }, { privateSingleOwner: true });

  assert.deepEqual(calls, ["account/read", "model/list", "account/rateLimits/read"]);
  assert.equal(result.runtime.authMode, "chatgpt_oauth");
  assert.equal(result.runtime.readiness, "ready");
  assert.deepEqual(result.runtime.availableModelIds, ["runtime-selected-codex"]);
  assert.equal(result.models[0]?.runtimeModelId, "runtime-selected-codex");
  assert.equal(result.defaultModelId, "runtime-selected-codex");
});

test("Codex discovery skips a provider-returned hidden model but still rejects malformed visible entries", async () => {
  const withHidden = {
    data: [
      { id: "hidden-model", hidden: true },
      ...(readyResponses["model/list"] as { data: unknown[] }).data
    ]
  };
  const visible = await probeCodexAppServer({
    request: async (method) => method === "model/list" ? withHidden : readyResponses[method]
  }, { privateSingleOwner: true });
  assert.deepEqual(visible.runtime.availableModelIds, ["runtime-selected-codex"]);

  const malformedVisible = await probeCodexAppServer({
    request: async (method) => method === "model/list" ? { data: [...withHidden.data, { id: "malformed-visible", hidden: false }] } : readyResponses[method]
  }, { privateSingleOwner: true });
  assert.equal(malformedVisible.runtime.readiness, "unavailable");
});

test("Codex discovery preserves the current provider-advertised efforts for the selected model", async () => {
  const result = await probeCodexAppServer({
    request: async (method) => method === "model/list" ? {
      data: [{
        id: "current-codex", model: "current-codex", displayName: "Current Codex", hidden: false, isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: "minimal" },
          { reasoningEffort: "low" },
          { reasoningEffort: "high" },
          { reasoningEffort: "ultra" }
        ]
      }]
    } : readyResponses[method]
  }, { privateSingleOwner: true });
  assert.equal(result.runtime.readiness, "ready");
  assert.deepEqual(result.models[0]?.supportedReasoningEfforts, ["minimal", "low", "high", "ultra"]);
  assert.deepEqual(result.models[0]?.reasoningMappings, { minimal: "minimal", low: "low", high: "high", ultra: "ultra" });
});

test("Codex discovery fails closed for a key/cloud auth mode, a reached subscription limit, malformed catalog or transport error", async () => {
  const apiKey = await probeCodexAppServer({ request: async () => ({ account: { type: "apiKey" } }) }, { privateSingleOwner: true });
  assert.equal(apiKey.runtime.authMode, "other");
  assert.equal(apiKey.runtime.readiness, "auth_required");

  const limited = await probeCodexAppServer({
    request: async (method) => method === "account/read" ? readyResponses[method] : method === "model/list" ? readyResponses[method] : { rateLimits: { rateLimitReachedType: "primary" } }
  }, { privateSingleOwner: true });
  assert.equal(limited.runtime.readiness, "quota_blocked");

  const malformed = await probeCodexAppServer({
    request: async (method) => method === "account/read" ? readyResponses[method] : { data: [{ id: "bad" }] }
  }, { privateSingleOwner: true });
  assert.equal(malformed.runtime.readiness, "unavailable");
});
