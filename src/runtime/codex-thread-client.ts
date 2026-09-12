import type { ProviderReasoningEffort } from "../settings/types.ts";
import type { CodexAppServerTransport } from "./codex-app-server.ts";
import { JsonRpcClient, type JsonRpcNotification } from "./json-rpc-client.ts";
import { isExternalRuntimeId } from "../identity/ids.ts";
import { chmod, mkdtemp, rm, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CodexThreadLease = Readonly<{
  threadId: string;
  modelId: string;
  cwd?: string;
  /** Web search is a per-thread capability, never a turn-controlled escape hatch. */
  webSearch?: boolean;
}>;
export type CodexTurnImage = Readonly<{ mime: "image/png" | "image/jpeg"; bytes: Uint8Array }>;
/** A Matrix voice note is accepted only after the encrypted ingress pipeline
 * has verified its Ogg container. It is staged in the lease-only workspace
 * and sent as a native app-server audio input, never as a public URL. */
export type CodexTurnAudio = Readonly<{ mime: "audio/ogg"; bytes: Uint8Array }>;

function validImages(images: readonly CodexTurnImage[]): boolean {
  if (!Array.isArray(images) || images.length > 4) return false;
  let total = 0;
  return images.every(image => {
    if (image === null || typeof image !== "object" || !(image.bytes instanceof Uint8Array) ||
      image.bytes.byteLength > 20 * 1024 * 1024 || image.bytes.byteLength < 8) return false;
    total += image.bytes.byteLength;
    const bytes = image.bytes;
    return total <= 64 * 1024 * 1024 && (image.mime === "image/png"
      ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
      : image.mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255);
  });
}

function validAudios(audios: readonly CodexTurnAudio[]): boolean {
  if (!Array.isArray(audios) || audios.length > 1) return false;
  return audios.every(audio => audio !== null && typeof audio === "object"
    && audio.mime === "audio/ogg" && audio.bytes instanceof Uint8Array
    && audio.bytes.byteLength >= 4 && audio.bytes.byteLength <= 20 * 1024 * 1024
    && [0x4f, 0x67, 0x67, 0x53].every((byte, index) => audio.bytes[index] === byte));
}

export type CodexThreadResult =
  | Readonly<{ ok: true; value: CodexThreadLease }>
  | Readonly<{ ok: false; code: "transport_error" | "invalid_thread_response" }>;

export type CodexTurnResult =
  | Readonly<{ ok: true; turnId: string; body: string }>
  | Readonly<{
      ok: false;
      code: "transport_error" | "invalid_turn_response" | "turn_failed" | "missing_agent_message" | "turn_timeout" | "turn_cancelled";
    }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown, max = 32_000): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const nonEmptyPrompt = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 256 * 1024;

// Pinned 0.153.1 feature keys plus its experimental empty-environments
// contract. ReadOnly alone does NOT restrict reads of credential files; no
// environment removes filesystem tools, and these flags remove other external
// tool channels. Harmless core utilities (for example clock) may remain.
export const CODEX_ANALYSIS_CONFIG = Object.freeze({
  web_search: "disabled",
  features: Object.freeze({
    shell_tool: false, unified_exec: false, view_image: false, shell_snapshot: false,
    apps: false, plugins: false, hooks: false, memories: false,
    browser_use: false, browser_use_external: false, browser_use_full_cdp_access: false,
    computer_use: false, image_generation: false, workspace_dependencies: false,
    code_mode: false, code_mode_host: false, multi_agent: false, multi_agent_v2: false,
    skill_search: false, tool_suggest: false, request_permissions_tool: false
  })
});

/** Research changes exactly one capability. The analysis tool fence remains
 * otherwise identical: no shell, browser control, local files or computer use. */
export const CODEX_RESEARCH_CONFIG = Object.freeze({
  ...CODEX_ANALYSIS_CONFIG,
  web_search: "live"
});

function parseThreadStart(value: unknown, modelId: string): CodexThreadLease | undefined {
  if (!isRecord(value) || !isRecord(value.thread) || !isExternalRuntimeId(value.thread.id)) return undefined;
  if ((value.model !== undefined && value.model !== modelId) || (value.thread.model !== undefined && value.thread.model !== modelId)) return undefined;
  return Object.freeze({ threadId: value.thread.id, modelId });
}

function collectAgentMessages(value: unknown): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return Object.freeze([]);
  const bodies = value.items.flatMap((item) =>
    isRecord(item) && item.type === "agentMessage" && nonEmpty(item.text) ? [item.text] : []
  );
  return Object.freeze(bodies);
}

function completedTurn(notification: JsonRpcNotification, threadId: string, turnId: string):
  | Readonly<{ status: "completed" | "failed" | "interrupted"; bodies: readonly string[] }>
  | undefined {
  if (notification.method !== "turn/completed" || !isRecord(notification.params)) return undefined;
  if (notification.params.threadId !== threadId || !isRecord(notification.params.turn) || notification.params.turn.id !== turnId) return undefined;
  const status = notification.params.turn.status;
  if (status !== "completed" && status !== "failed" && status !== "interrupted") return undefined;
  return Object.freeze({ status, bodies: collectAgentMessages(notification.params.turn) });
}

function completedAgentItem(notification: JsonRpcNotification, threadId: string, turnId: string): string | undefined {
  if (notification.method !== "item/completed" || !isRecord(notification.params)) return undefined;
  if (notification.params.threadId !== threadId || notification.params.turnId !== turnId || !isRecord(notification.params.item)) return undefined;
  const item = notification.params.item;
  return item.type === "agentMessage" && nonEmpty(item.text) ? item.text : undefined;
}

/**
 * Version-tolerant narrow adapter over the documented app-server thread/turn
 * protocol. It deliberately uses only `thread/start`, `turn/start`, completed
 * items and `turn/completed`; tool calls, deltas and hidden reasoning never
 * reach the consilium transcript.
 */
export class CodexAppServerThreadClient {
  readonly #rpc: JsonRpcClient;
  readonly #clientInfo: Readonly<{ name: string; title: string; version: string }>;
  readonly #workspaces = new Map<string, string>();
  readonly #activeTurns = new Map<string, string>();
  readonly #busyThreads = new Set<string>();
  readonly #released = new Set<string>();
  readonly #onUnresponsive: (() => Promise<void>) | undefined;

  constructor(input: Readonly<{
    rpc: JsonRpcClient;
    clientInfo: Readonly<{ name: string; title: string; version: string }>;
    onUnresponsive?: () => Promise<void>;
  }>) {
    this.#rpc = input.rpc;
    this.#clientInfo = input.clientInfo;
    this.#onUnresponsive = input.onUnresponsive;
  }

  /** The preflight path shares this initialized managed-OAuth connection. */
  get transport(): CodexAppServerTransport {
    return Object.freeze({
      request: async (method: string, params: unknown): Promise<unknown> => {
        await this.#rpc.initialize(this.#clientInfo);
        return this.#rpc.request(method, params);
      }
    });
  }

  async startIsolatedThread(input: Readonly<{ modelId: string; cwd?: string; webSearch?: boolean }>): Promise<CodexThreadResult> {
    if (!nonEmpty(input.modelId, 512)) return { ok: false, code: "invalid_thread_response" };
    let ownedWorkspace: string | undefined;
    try {
      const cwd = input.cwd ?? (ownedWorkspace = await mkdtemp(join(tmpdir(), "personal-consilium-")));
      if (ownedWorkspace !== undefined) await chmod(ownedWorkspace, 0o700);
      await this.#rpc.initialize(this.#clientInfo);
      const result = await this.#rpc.request("thread/start", {
        model: input.modelId,
        ephemeral: true,
        cwd,
        sandbox: "read-only",
        approvalPolicy: "never",
        environments: [],
        config: input.webSearch === true ? CODEX_RESEARCH_CONFIG : CODEX_ANALYSIS_CONFIG
      });
      const thread = parseThreadStart(result, input.modelId);
      if (thread === undefined) {
        if (isRecord(result) && isRecord(result.thread) && isExternalRuntimeId(result.thread.id)) {
          await this.#rpc.request("thread/unsubscribe", { threadId: result.thread.id }).catch(() => undefined);
        }
        if (ownedWorkspace !== undefined) await rm(ownedWorkspace, { recursive: true, force: true });
        return { ok: false, code: "invalid_thread_response" };
      }
      if (ownedWorkspace !== undefined) this.#workspaces.set(thread.threadId, ownedWorkspace);
      return { ok: true, value: Object.freeze({ ...thread, cwd, webSearch: input.webSearch === true }) };
    } catch {
      await this.#onUnresponsive?.().catch(() => undefined);
      if (ownedWorkspace !== undefined) await rm(ownedWorkspace, { recursive: true, force: true });
      return { ok: false, code: "transport_error" };
    }
  }

  async releaseThread(lease: CodexThreadLease): Promise<void> {
    if (this.#released.has(lease.threadId)) return;
    this.#released.add(lease.threadId);
    const turnId = this.#activeTurns.get(lease.threadId);
    try {
      if (turnId !== undefined) await this.#rpc.request("turn/interrupt", { threadId: lease.threadId, turnId }).catch(async () => this.#onUnresponsive?.());
      await this.#rpc.request("thread/unsubscribe", { threadId: lease.threadId });
    } catch {
      // The managed process may already be stopped. Workspace ownership is
      // local and still must be released; never delete an externally supplied cwd.
    } finally {
      const workspace = this.#workspaces.get(lease.threadId);
      this.#workspaces.delete(lease.threadId);
      this.#activeTurns.delete(lease.threadId);
      if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
    }
  }

  async runTextTurn(input: Readonly<{
    lease: CodexThreadLease;
    body: string;
    reasoningEffort: ProviderReasoningEffort | null;
    outputSchema?: unknown;
    images?: readonly CodexTurnImage[];
    audios?: readonly CodexTurnAudio[];
    timeoutMilliseconds?: number;
    signal?: AbortSignal;
  }>): Promise<CodexTurnResult> {
    const threadId = input.lease.threadId;
    if (!nonEmptyPrompt(input.body) || this.#released.has(threadId) || this.#busyThreads.has(threadId)) return { ok: false, code: "invalid_turn_response" };
    const images = input.images ?? [];
    const audios = input.audios ?? [];
    const ownedWorkspace = this.#workspaces.get(threadId);
    if (!validImages(images) || !validAudios(audios)
      || ((images.length > 0 || audios.length > 0) && (ownedWorkspace === undefined || ownedWorkspace !== input.lease.cwd))) return { ok: false, code: "invalid_turn_response" };
    if (input.signal?.aborted) return { ok: false, code: "turn_cancelled" };
    this.#busyThreads.add(threadId);
    const timeoutMilliseconds = input.timeoutMilliseconds ?? 10 * 60_000;
    let releaseListener: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancellation: "turn_cancelled" | "turn_timeout" | undefined;
    let turnId: string | undefined;
    let interruptRequest: Promise<void> | undefined;
    let settlePending: ((result: CodexTurnResult) => void) | undefined;
    const stagedInputs: string[] = [];
    const interrupt = async (code: "turn_cancelled" | "turn_timeout"): Promise<void> => {
      cancellation ??= code;
      if (turnId === undefined) return;
      interruptRequest ??= this.#rpc.request("turn/interrupt", { threadId, turnId })
        .then(() => undefined)
        .catch(async () => { await this.#onUnresponsive?.().catch(() => undefined); });
      await interruptRequest;
      settlePending?.({ ok: false, code: cancellation });
    };
    const onAbort = (): void => { void interrupt("turn_cancelled"); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => { void interrupt("turn_timeout"); }, timeoutMilliseconds);
    try {
      await this.#rpc.initialize(this.#clientInfo);
      if (input.signal?.aborted || this.#released.has(threadId)) cancellation ??= "turn_cancelled";
      if (cancellation !== undefined) return { ok: false, code: cancellation };
      // Only the client-owned private lease directory is writable. Filenames
      // and paths never come from message content, Matrix URLs or the caller.
      for (const image of images) {
        const path = join(ownedWorkspace!, `input-image-${randomUUID()}.${image.mime === "image/png" ? "png" : "jpg"}`);
        const bytes = Buffer.from(image.bytes);
        try {
          if (!validImages([{ mime: image.mime, bytes }])) return { ok: false, code: "invalid_turn_response" };
          const file = await open(path, "wx", 0o600);
          stagedInputs.push(path);
          try { await file.writeFile(bytes); } finally { await file.close(); }
        } finally { bytes.fill(0); }
        if (input.signal?.aborted || this.#released.has(threadId)) return { ok: false, code: "turn_cancelled" };
      }
      for (const audio of audios) {
        const path = join(ownedWorkspace!, `input-audio-${randomUUID()}.ogg`);
        const bytes = Buffer.from(audio.bytes);
        try {
          if (!validAudios([{ mime: audio.mime, bytes }])) return { ok: false, code: "invalid_turn_response" };
          const file = await open(path, "wx", 0o600);
          stagedInputs.push(path);
          try { await file.writeFile(bytes); } finally { await file.close(); }
        } finally { bytes.fill(0); }
        if (input.signal?.aborted || this.#released.has(threadId)) return { ok: false, code: "turn_cancelled" };
      }
      const bufferedNotifications: JsonRpcNotification[] = [];
      let bufferedBytes = 0;
      let bufferOverflow = false;
      let notificationHandler: ((notification: JsonRpcNotification) => void) | undefined;
      releaseListener = this.#rpc.onNotification((notification) => {
        // Parallel specialist traffic and auth/tool notifications are not ours.
        if (!isRecord(notification.params) || notification.params.threadId !== threadId ||
          (notification.method !== "item/completed" && notification.method !== "turn/completed")) return;
        if (notificationHandler !== undefined) {
          notificationHandler(notification);
          return;
        }
        if (bufferOverflow) return;
        bufferedBytes += new TextEncoder().encode(JSON.stringify(notification)).byteLength;
        if (bufferedNotifications.length >= 256 || bufferedBytes > 262_144) {
          bufferOverflow = true;
          bufferedNotifications.length = 0;
          return;
        }
        bufferedNotifications.push(notification);
      });
      const response = await this.#rpc.request("turn/start", {
        threadId,
        input: [
          { type: "text", text: input.body, text_elements: [] },
          ...stagedInputs.filter(path => path.endsWith(".jpg") || path.endsWith(".png")).map(path => ({ type: "localImage", path })),
          ...stagedInputs.filter(path => path.endsWith(".ogg")).map(path => ({ type: "localAudio", path }))
        ],
        model: input.lease.modelId,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: input.lease.webSearch === true },
        environments: [],
        ...(input.reasoningEffort === null ? {} : { effort: input.reasoningEffort }),
        ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema })
      });
      if (!isRecord(response) || !isRecord(response.turn) || !isExternalRuntimeId(response.turn.id)) {
        // An unknown started turn cannot be cancelled by ID; production closes
        // its managed connection instead of leaving unknown work in flight.
        await this.#onUnresponsive?.().catch(() => undefined);
        return { ok: false, code: cancellation ?? "invalid_turn_response" };
      }
      turnId = response.turn.id;
      this.#activeTurns.set(threadId, turnId);
      if (input.signal?.aborted || this.#released.has(threadId)) cancellation ??= "turn_cancelled";
      if (cancellation !== undefined || bufferOverflow) {
        await interrupt(cancellation ?? "turn_cancelled");
        if (this.#released.has(threadId)) await this.#rpc.request("thread/unsubscribe", { threadId }).catch(() => undefined);
        return { ok: false, code: bufferOverflow ? "invalid_turn_response" : cancellation! };
      }
      const initialBodies = collectAgentMessages(response.turn);
      if (response.turn.status === "failed" || response.turn.status === "interrupted") return { ok: false, code: "turn_failed" };
      if (response.turn.status === "completed") {
        return initialBodies.length === 0
          ? { ok: false, code: "missing_agent_message" }
          : { ok: true, turnId, body: initialBodies.at(-1)! };
      }

      return await new Promise<CodexTurnResult>((resolve) => {
        const bodies = [...initialBodies];
        let settled = false;
        settlePending = (result): void => {
          if (settled) return;
          settled = true;
          if (timeout !== undefined) clearTimeout(timeout);
          releaseListener?.();
          resolve(cancellation === undefined ? result : { ok: false, code: cancellation });
        };
        notificationHandler = (notification) => {
          const body = completedAgentItem(notification, threadId, turnId!);
          if (body !== undefined) bodies.push(body);
          const completion = completedTurn(notification, threadId, turnId!);
          if (completion === undefined) return;
          bodies.push(...completion.bodies);
          if (completion.status !== "completed") {
            settlePending!({ ok: false, code: "turn_failed" });
            return;
          }
          const lastBody = bodies.at(-1);
          settlePending!(lastBody === undefined ? { ok: false, code: "missing_agent_message" } : { ok: true, turnId: turnId!, body: lastBody });
        };
        for (const notification of bufferedNotifications) notificationHandler(notification);
      });
    } catch {
      // Covers a timed-out turn/start whose ID never arrived, not a model fallback.
      await this.#onUnresponsive?.().catch(() => undefined);
      return { ok: false, code: cancellation ?? "transport_error" };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      releaseListener?.();
      await interruptRequest;
      this.#activeTurns.delete(threadId);
      this.#busyThreads.delete(threadId);
      await Promise.all(stagedInputs.map(path => rm(path, { force: true })));
    }
  }
}
