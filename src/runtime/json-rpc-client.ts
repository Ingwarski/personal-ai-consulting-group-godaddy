export interface JsonRpcLineChannel {
  send(line: string): Promise<void>;
  onLine(listener: (line: string) => void): () => void;
}

export type JsonRpcNotification = Readonly<{
  method: string;
  params: unknown;
}>;

export type JsonRpcClientErrorCode = "not_initialized" | "closed" | "timeout" | "server_error";

type PendingRequest = Readonly<{
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clientError = (code: JsonRpcClientErrorCode): Error => {
  const error = new Error(code);
  error.name = "JsonRpcClientError";
  return error;
};

/**
 * Minimal JSON-RPC 2.0 connection wrapper for the Codex app-server process.
 * It implements the documented initialize/initialized handshake and has no
 * logging hook, so OAuth URLs, auth results and arbitrary model output cannot
 * escape into the product transcript by accident.
 */
export class JsonRpcClient {
  readonly #channel: JsonRpcLineChannel;
  readonly #timeoutMilliseconds: number;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notificationListeners = new Set<(notification: JsonRpcNotification) => void>();
  readonly #unsubscribe: () => void;
  #nextId = 1;
  #initialized = false;
  #closed = false;

  constructor(input: Readonly<{ channel: JsonRpcLineChannel; timeoutMilliseconds?: number }>) {
    this.#channel = input.channel;
    this.#timeoutMilliseconds = input.timeoutMilliseconds ?? 15_000;
    this.#unsubscribe = this.#channel.onLine((line) => this.#receive(line));
  }

  async initialize(clientInfo: Readonly<{ name: string; title: string; version: string }>): Promise<unknown> {
    if (this.#initialized) return {};
    const result = await this.#sendRequest("initialize", {
      clientInfo,
      capabilities: { experimentalApi: false }
    });
    await this.#sendNotification("initialized", {});
    this.#initialized = true;
    return result;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.#initialized) throw clientError("not_initialized");
    return this.#sendRequest(method, params);
  }

  /**
   * Observes app-server notifications locally. Callers must deliberately turn
   * a completed agent item into a visible consilium message; raw deltas and
   * tool events never become transcript entries.
   */
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(clientError("closed"));
    }
    this.#pending.clear();
  }

  async #sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) throw clientError("closed");
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(clientError("timeout"));
      }, this.#timeoutMilliseconds);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    try {
      await this.#channel.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    } catch {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        pending.reject(clientError("closed"));
      }
    }
    return response;
  }

  async #sendNotification(method: string, params: unknown): Promise<void> {
    if (this.#closed) throw clientError("closed");
    await this.#channel.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  #receive(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.method === "string" && typeof value.id !== "number") {
      for (const listener of this.#notificationListeners) {
        listener(Object.freeze({ method: value.method, params: value.params }));
      }
      return;
    }
    if (typeof value.id !== "number") return;
    const pending = this.#pending.get(value.id);
    if (pending === undefined) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(value.id);
    if (Object.prototype.hasOwnProperty.call(value, "result")) {
      pending.resolve(value.result);
      return;
    }
    pending.reject(clientError("server_error"));
  }
}
