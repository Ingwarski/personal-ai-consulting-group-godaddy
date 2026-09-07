import { MATRIX_WAKE_PATH, parseMatrixWakeConfiguration } from "./matrix-wake.ts";

const RULE_ID = "ai.personal-consultant.matrix.owner-room";
const MAX_RESPONSE_BYTES = 64 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Explicit operator action only. Not called by server startup or Settings. */
export async function registerMatrixWake(input: Readonly<{
  environment: Record<string, unknown>;
  apply: boolean;
  fetcher?: typeof fetch;
}>): Promise<Readonly<{ status: "validated_only" | "registered"; pusherChanged: boolean; ruleChanged: boolean }>> {
  const environment = input.environment;
  const configuration = parseMatrixWakeConfiguration(environment);
  if (configuration === undefined || environment.MATRIX_HOMESERVER_URL !== "https://matrix.org"
    || typeof environment.MATRIX_ACCESS_TOKEN !== "string" || environment.MATRIX_ACCESS_TOKEN.length < 16
    || typeof environment.MATRIX_BOT_MXID !== "string" || typeof environment.MATRIX_BOT_DEVICE_ID !== "string"
    || typeof environment.MATRIX_OWNER_MXID !== "string" || typeof environment.SETTINGS_PUBLIC_ORIGIN !== "string") {
    throw new Error("Matrix wake configuration is incomplete.");
  }
  const origin = new URL(environment.SETTINGS_PUBLIC_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== environment.SETTINGS_PUBLIC_ORIGIN
    || origin.username !== "" || origin.password !== "" || !/^[a-z0-9-]+\.c\d+\.airoapp\.ai$/u.test(origin.hostname)) {
    throw new Error("Matrix wake requires the exact existing GoDaddy Published HTTPS origin.");
  }
  if (!input.apply) return { status: "validated_only", pusherChanged: false, ruleChanged: false };
  const fetcher = input.fetcher ?? fetch;
  const requestJson = async (url: string, init: RequestInit): Promise<unknown> => {
    const result = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!result.ok || Number(result.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) {
      throw new Error("Matrix wake registration request was not accepted.");
    }
    const reader = result.body?.getReader();
    if (reader === undefined) throw new Error("Matrix wake registration returned no result.");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error("Matrix wake registration result exceeded its limit.");
        chunks.push(chunk.value);
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  };
  const headers = { authorization: `Bearer ${environment.MATRIX_ACCESS_TOKEN}`, "content-type": "application/json" };
  const api = "https://matrix.org/_matrix/client/v3";
  const who = await requestJson(`${api}/account/whoami`, { headers });
  if (!record(who) || who.user_id !== environment.MATRIX_BOT_MXID || who.device_id !== environment.MATRIX_BOT_DEVICE_ID) {
    throw new Error("Matrix wake registration account or device does not match the existing bot.");
  }
  // A count-only probe verifies gateway access without waking transport or
  // creating a consultation. No access token leaves the fixed homeserver.
  const wakeUrl = `${origin.origin}${MATRIX_WAKE_PATH}`;
  const probe = await requestJson(wakeUrl, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ notification: { counts: { unread: 0 }, devices: [
      { app_id: configuration.appId, pushkey: configuration.pushKey }
    ] } }) });
  if (!record(probe) || !Array.isArray(probe.rejected) || probe.rejected.length !== 0) {
    throw new Error("Matrix wake endpoint probe failed.");
  }
  const pushers = await requestJson(`${api}/pushers`, { headers });
  const rules = await requestJson(`${api}/pushrules/`, { headers });
  if (!record(pushers) || !Array.isArray(pushers.pushers) || !record(rules) || !record(rules.global)
    || !Array.isArray(rules.global.override)) throw new Error("Matrix push configuration could not be inspected.");
  const conditions = [
    { kind: "event_match", key: "room_id", pattern: configuration.roomId },
    { kind: "event_match", key: "sender", pattern: environment.MATRIX_OWNER_MXID }
  ];
  const actions = ["notify", { set_tweak: "highlight", value: false }];
  const existingRule = rules.global.override.find((value) => record(value) && value.rule_id === RULE_ID);
  // Preserve existing user override precedence instead of silently bypassing
  // an intentional mute. Server default rules cannot be `after` targets.
  const lastUserRule = rules.global.override.filter((value) => record(value) && value.default !== true
    && typeof value.rule_id === "string" && !value.rule_id.startsWith(".") && value.rule_id !== RULE_ID).at(-1);
  const ruleOrder = record(lastUserRule) && typeof lastUserRule.rule_id === "string"
    ? `?after=${encodeURIComponent(lastUserRule.rule_id)}` : "";
  if (existingRule !== undefined && (!record(existingRule) || existingRule.enabled !== true
    || JSON.stringify(existingRule.conditions) !== JSON.stringify(conditions)
    || JSON.stringify(existingRule.actions) !== JSON.stringify(actions))) {
    throw new Error("The dedicated Matrix wake rule already exists with different settings; it was not overwritten.");
  }
  const pusher = {
    pushkey: configuration.pushKey, kind: "http", app_id: configuration.appId,
    app_display_name: "Personal Consultant", device_display_name: "GoDaddy Published Matrix wake",
    lang: "en", data: { url: wakeUrl, format: "event_id_only" }, append: true
  };
  const existingPusher = pushers.pushers.find((value) => record(value)
    && value.app_id === configuration.appId && value.pushkey === configuration.pushKey);
  if (existingPusher !== undefined && (!record(existingPusher) || existingPusher.kind !== "http"
    || !record(existingPusher.data) || existingPusher.data.url !== wakeUrl || existingPusher.data.format !== "event_id_only")) {
    throw new Error("The dedicated Matrix pusher has different settings; it was not overwritten.");
  }
  // Never replace the account rule set, remove a pusher, or disable encryption.
  if (existingRule === undefined) await requestJson(`${api}/pushrules/global/override/${RULE_ID}${ruleOrder}`, {
    method: "PUT", headers, body: JSON.stringify({ conditions, actions })
  });
  if (existingPusher === undefined) await requestJson(`${api}/pushers/set`, {
    method: "POST", headers, body: JSON.stringify(pusher)
  });
  return { status: "registered", pusherChanged: existingPusher === undefined, ruleChanged: existingRule === undefined };
}
