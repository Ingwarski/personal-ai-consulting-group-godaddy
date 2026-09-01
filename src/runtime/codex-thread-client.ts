import type { ReasoningDepth } from "../settings/types.ts";
import type { CodexAppServerTransport } from "./codex-app-server.ts";
import { JsonRpcClient, type JsonRpcNotification } from "./json-rpc-client.ts";
import { isExternalRuntimeId } from "../identity/ids.ts";

export type CodexThreadLease = Readonly<{
  threadId: string;
  modelId: string;
}>;

export type CodexThreadResult =
  | Readonly<{ ok: true; value: CodexThreadLease }>
  | Readonly<{ ok: false; code: "transport_error" | "invalid_thread_response" }>;

export type CodexTurnResult =
  | Readonly<{ ok: true; turnId: string; body: string }>
  | Readonly<{
      ok: false;
      code: "transport_error" | "invalid_turn_response" | "turn_failed" | "missing_agent_message" | "turn_timeout";
    }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown, max = 32_000): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

function parseThreadStart(value: unknown, modelId: string): CodexThreadLease | undefined {
  if (!isRecord(value) || !isRecord(value.thread) || !isExternalRuntimeId(value.thread.id)) return undefined;
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

  constructor(input: Readonly<{
    rpc: JsonRpcClient;
    clientInfo: Readonly<{ name: string; title: string; version: string }>;
  }>) {
    this.#rpc = input.rpc;
    this.#clientInfo = input.clientInfo;
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

  async startIsolatedThread(input: Readonly<{ modelId: string; cwd?: string }>): Promise<CodexThreadResult> {
    if (!nonEmpty(input.modelId, 512)) return { ok: false, code: "invalid_thread_response" };
    try {
      await this.#rpc.initialize(this.#clientInfo);
      const result = await this.#rpc.request("thread/start", {
        model: input.modelId,
        ephemeral: true,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd })
      });
      const thread = parseThreadStart(result, input.modelId);
      return thread === undefined ? { ok: false, code: "invalid_thread_response" } : { ok: true, value: thread };
    } catch {
      return { ok: false, code: "transport_error" };
    }
  }

  async runTextTurn(input: Readonly<{
    lease: CodexThreadLease;
    body: string;
    reasoningEffort: ReasoningDepth;
    outputSchema?: unknown;
    timeoutMilliseconds?: number;
  }>): Promise<CodexTurnResult> {
    if (!nonEmpty(input.body)) return { ok: false, code: "invalid_turn_response" };
    const timeoutMilliseconds = input.timeoutMilliseconds ?? 10 * 60_000;
    let releaseListener: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.#rpc.initialize(this.#clientInfo);
      const bufferedNotifications: JsonRpcNotification[] = [];
      let notificationHandler: ((notification: JsonRpcNotification) => void) | undefined;
      releaseListener = this.#rpc.onNotification((notification) => {
        if (notificationHandler === undefined) {
          bufferedNotifications.push(notification);
          return;
        }
        notificationHandler(notification);
      });
      const response = await this.#rpc.request("turn/start", {
        threadId: input.lease.threadId,
        input: [{ type: "text", text: input.body, text_elements: [] }],
        model: input.lease.modelId,
        effort: input.reasoningEffort,
        ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema })
      });
      if (!isRecord(response) || !isRecord(response.turn) || !isExternalRuntimeId(response.turn.id)) {
        return { ok: false, code: "invalid_turn_response" };
      }
      const turnId = response.turn.id;
      const initialBodies = collectAgentMessages(response.turn);
      if (response.turn.status === "completed") {
        return initialBodies.length === 0
          ? { ok: false, code: "missing_agent_message" }
          : { ok: true, turnId, body: initialBodies.at(-1)! };
      }

      return await new Promise<CodexTurnResult>((resolve) => {
        const bodies = [...initialBodies];
        const settle = (result: CodexTurnResult): void => {
          if (timeout !== undefined) clearTimeout(timeout);
          releaseListener?.();
          resolve(result);
        };
        notificationHandler = (notification) => {
          const body = completedAgentItem(notification, input.lease.threadId, turnId);
          if (body !== undefined) bodies.push(body);
          const completion = completedTurn(notification, input.lease.threadId, turnId);
          if (completion === undefined) return;
          bodies.push(...completion.bodies);
          if (completion.status !== "completed") {
            settle({ ok: false, code: "turn_failed" });
            return;
          }
          const lastBody = bodies.at(-1);
          settle(lastBody === undefined ? { ok: false, code: "missing_agent_message" } : { ok: true, turnId, body: lastBody });
        };
        for (const notification of bufferedNotifications) notificationHandler(notification);
        timeout = setTimeout(() => settle({ ok: false, code: "turn_timeout" }), timeoutMilliseconds);
      });
    } catch {
      return { ok: false, code: "transport_error" };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      releaseListener?.();
    }
  }
}
