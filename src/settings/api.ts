import type { OwnerSettingsService, SettingsReadModel, SettingsWriteResult } from "./owner-settings-do.ts";

export type SettingsRequestGuards = Readonly<{
  allowsMutation: (request: Request) => boolean | Promise<boolean>;
}>;

const json = (body: unknown, status: number, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });

const writeStatus = (result: SettingsWriteResult): number => {
  if (result.ok) return 200;
  if (result.code === "revision_conflict" || result.code === "idempotency_conflict") return 409;
  if (result.code === "not_initialized") return 503;
  if (
    result.code !== "invalid_if_match" &&
    result.code !== "invalid_idempotency_key"
  ) return 422;
  return 400;
};

const MAX_MUTATION_BODY_BYTES = 16_384;

const isJsonRequest = (request: Request): boolean =>
  request.headers.get("content-type")?.toLowerCase().startsWith("application/json") === true;

const isResetConfirmation = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 && body.confirmed === true;
};

type JsonBodyReadResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; code: "invalid_json" | "body_too_large" }>;

async function safelyReadJson(request: Request): Promise<JsonBodyReadResult> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MUTATION_BODY_BYTES) {
    return { ok: false, code: "body_too_large" };
  }

  try {
    const reader = request.body?.getReader();
    if (reader === undefined) return { ok: false, code: "invalid_json" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_MUTATION_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, code: "body_too_large" };
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, code: "invalid_json" };
  }
}

function readResponse(read: SettingsReadModel | undefined): Response {
  if (read === undefined) {
    return json({ error: "settings_not_initialized" }, 503);
  }

  return json(
    {
      document: read.document,
      defaults: read.defaults,
      effectiveForNextSession: read.effectiveForNextSession,
      effectiveIncompatibility: read.effectiveIncompatibility,
      activeSessionSnapshot: read.activeSessionSnapshot,
      activeSessionStatus: read.activeSessionStatus
    },
    200,
    { etag: read.etag }
  );
}

export async function handleSettingsApi(
  request: Request,
  ownerSettings: OwnerSettingsService,
  guards: SettingsRequestGuards
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/settings" && request.method === "GET") {
    return readResponse(await ownerSettings.read());
  }

  if (path !== "/api/settings" && path !== "/api/settings/reset") {
    return json({ error: "not_found" }, 404);
  }
  const isSave = path === "/api/settings" && request.method === "PUT";
  const isReset = path === "/api/settings/reset" && request.method === "POST";
  if (!isSave && !isReset) {
    return json(
      { error: "method_not_allowed" },
      405,
      { allow: path === "/api/settings" ? "GET, PUT" : "POST" }
    );
  }

  if (!(await guards.allowsMutation(request))) return json({ error: "forbidden" }, 403);
  if (!isJsonRequest(request)) return json({ error: "unsupported_media_type" }, 415);

  const body = await safelyReadJson(request);
  if (!body.ok) return json({ error: body.code }, body.code === "body_too_large" ? 413 : 400);

  const ifMatch = request.headers.get("if-match") ?? undefined;
  const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
  const result = isSave
    ? await ownerSettings.save(body.value, ifMatch, idempotencyKey)
    : isResetConfirmation(body.value)
      ? await ownerSettings.reset(ifMatch, idempotencyKey)
      : ({ ok: false, code: "invalid_reset_confirmation" } as const);

  if (!result.ok) {
    if (result.code === "invalid_reset_confirmation") {
      return json({ error: result.code }, 422);
    }
    return json({ error: result.code }, writeStatus(result));
  }
  return json(
    { document: result.document, replayed: result.replayed },
    200,
    { etag: result.etag }
  );
}
