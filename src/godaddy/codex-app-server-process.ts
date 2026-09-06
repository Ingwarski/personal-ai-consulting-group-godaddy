import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { JsonRpcClient, type JsonRpcLineChannel } from "../runtime/json-rpc-client.ts";
import { CodexAppServerThreadClient } from "../runtime/codex-thread-client.ts";
import { probeCodexAppServer, type CodexAppServerProbe } from "../runtime/codex-app-server.ts";
import type { RuntimeCredentialVault } from "./runtime-credential-vault.ts";

const CODEX_AUTH_STORAGE_KEY = "codex_auth_state";
const MAX_AUTH_STATE_BYTES = 64 * 1024;

export type CodexAppServerConnection = Readonly<{
  channel: JsonRpcLineChannel;
  readAuthState: () => Promise<Uint8Array | undefined>;
  close: () => Promise<void>;
}>;

export type CodexAppServerLauncher = (authState: Uint8Array | undefined) => Promise<CodexAppServerConnection>;

export type CodexDeviceAuthorization = Readonly<{
  verificationUrl: string;
  userCode: string;
}>;

export type GoDaddyCodexAppServer = Readonly<{
  inspectSubscription: () => Promise<CodexAppServerProbe>;
  getThreadClient?: () => Promise<CodexAppServerThreadClient>;
  verifyModelSelection?: (modelId: string, effort: string) => Promise<boolean>;
  startDeviceAuthorization: () => Promise<CodexDeviceAuthorization | undefined>;
  resetAuthorization: () => Promise<boolean>;
  close: () => Promise<void>;
}>;

export type GoDaddyCodexAppServerOptions = Readonly<{
  environment: Record<string, unknown>;
  vault: RuntimeCredentialVault;
  executable?: string;
  launch?: CodexAppServerLauncher;
}>;

type ActiveConnection = Readonly<{
  client: JsonRpcClient;
  connection: CodexAppServerConnection;
  authEpoch: number;
}>;

const asPath = (value: unknown): string =>
  typeof value === "string" && value.length > 0 ? value : "/usr/local/bin:/usr/bin:/bin";

function executablePath(value: string | undefined): string {
  return value ?? resolve(process.cwd(), "node_modules", ".bin", "codex");
}

function parseDeviceAuthorization(value: unknown): CodexDeviceAuthorization | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  if (result.type !== "chatgptDeviceCode" || typeof result.verificationUrl !== "string" || typeof result.userCode !== "string") return undefined;
  try {
    const url = new URL(result.verificationUrl);
    if (url.protocol !== "https:" || url.hostname !== "auth.openai.com" || !/^[A-Za-z0-9-]{4,64}$/u.test(result.userCode)) return undefined;
    return Object.freeze({ verificationUrl: url.toString(), userCode: result.userCode });
  } catch {
    return undefined;
  }
}

type CodexProcessLineWriter = Readonly<{
  write: (line: string, callback: (error?: Error | null) => void) => unknown;
}>;

/** @internal Exported so the child-process success contract stays regression-tested. */
export async function writeCodexAppServerLine(writer: CodexProcessLineWriter, line: string): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    writer.write(`${line}\n`, (error) => error == null ? resolveWrite() : rejectWrite(error));
  });
}

/**
 * Starts app-server in a per-process private directory.  GoDaddy only
 * promises deployment-persistent files beneath public assets, which is never
 * suitable for `auth.json`; this launcher restores and writes that state via
 * the encrypted MySQL vault instead.
 */
export function createSubprocessCodexAppServerLauncher(input: Readonly<{
  environment: Record<string, unknown>;
  executable?: string;
}>): CodexAppServerLauncher {
  const executable = executablePath(input.executable);
  return async (authState) => {
    const directory = await mkdtemp(join(tmpdir(), "personal-consultant-codex-"));
    const codexHome = join(directory, ".codex");
    const authPath = join(codexHome, "auth.json");
    await mkdir(codexHome, { mode: 0o700 });
    if (authState !== undefined && authState.byteLength <= MAX_AUTH_STATE_BYTES) {
      await writeFile(authPath, authState, { mode: 0o600, flag: "w" });
    }
    const child = spawn(executable, ["app-server", "--stdio"], {
      cwd: directory,
      env: {
        PATH: asPath(input.environment.PATH),
        HOME: directory,
        TMPDIR: directory,
        CODEX_HOME: codexHome,
        NO_COLOR: "1"
      },
      stdio: ["pipe", "pipe", "ignore"]
    });
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let closed = false;
    const markClosed = (): void => {
      closed = true;
      reader.close();
    };
    child.once("error", markClosed);
    const channel: JsonRpcLineChannel = Object.freeze({
      async send(line: string): Promise<void> {
        if (closed || !child.stdin.writable) throw new Error("Codex app-server is closed.");
        await writeCodexAppServerLine(child.stdin, line);
      },
      onLine(listener: (line: string) => void): () => void {
        reader.on("line", listener);
        return () => reader.off("line", listener);
      }
    });
    const readAuthState = async (): Promise<Uint8Array | undefined> => {
      try {
        const state = await readFile(authPath);
        return state.byteLength > 0 && state.byteLength <= MAX_AUTH_STATE_BYTES ? new Uint8Array(state) : undefined;
      } catch {
        return undefined;
      }
    };
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => closePromise ??= (async () => {
      closed = true;
      reader.close();
      const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
      if (!exited()) child.kill("SIGTERM");
      if (!exited()) await new Promise<void>((resolveClose) => {
        const timer = setTimeout(() => {
          if (!exited()) child.kill("SIGKILL");
        }, 1_000);
        child.once("close", () => {
          clearTimeout(timer);
          resolveClose();
        });
      });
      await rm(directory, { recursive: true, force: true });
    })();
    return Object.freeze({ channel, readAuthState, close });
  };
}

/**
 * A single app-server owns one managed ChatGPT OAuth state.  It can begin the
 * documented device-code flow, but it never returns a refresh token or any
 * raw app-server event.  Completed/renewed auth state is sealed before the
 * temporary runtime directory is removed.
 */
export function createGoDaddyCodexAppServer(options: GoDaddyCodexAppServerOptions): GoDaddyCodexAppServer {
  const launch = options.launch ?? createSubprocessCodexAppServerLauncher(options);
  let active: Promise<ActiveConnection> | undefined;
  let authEpoch = 0;
  let credentialOperations = Promise.resolve();

  const queueCredentialOperation = async (operation: () => Promise<void>): Promise<void> => {
    const queued = credentialOperations.then(operation, operation);
    credentialOperations = queued.catch(() => undefined);
    return queued;
  };

  const persist = async (connection: CodexAppServerConnection, epoch = authEpoch): Promise<void> => {
    await queueCredentialOperation(async () => {
      if (epoch !== authEpoch) return;
      const state = await connection.readAuthState();
      if (epoch !== authEpoch || state === undefined || state.byteLength > MAX_AUTH_STATE_BYTES) return;
      await options.vault.write(CODEX_AUTH_STORAGE_KEY, state);
    });
  };

  const closeActive = async (persistState: boolean): Promise<void> => {
    const current = active;
    active = undefined;
    if (current === undefined) return;
    try {
      const resolved = await current;
      try { if (persistState) await persist(resolved.connection, resolved.authEpoch); }
      finally {
        resolved.client.close();
        await resolved.connection.close();
      }
    } catch {
      return;
    }
  };

  const getActive = async (): Promise<ActiveConnection> => {
    if (active === undefined) {
      active = (async () => {
        const connectionEpoch = authEpoch;
        const connection = await launch(await options.vault.read(CODEX_AUTH_STORAGE_KEY));
        const client = new JsonRpcClient({ channel: connection.channel, experimentalApi: true });
        try {
          await client.initialize({ name: "personal-consultant-godaddy", title: "Personal Consultant", version: "1" });
          client.onNotification((notification) => {
            if (notification.method === "account/login/completed" || notification.method === "account/updated") void persist(connection, connectionEpoch);
          });
          return Object.freeze({ client, connection, authEpoch: connectionEpoch });
        } catch {
          client.close();
          await connection.close().catch(() => undefined);
          active = undefined;
          throw new Error("Codex app-server is unavailable.");
        }
      })();
    }
    return active;
  };

  const getThreadClient = async (): Promise<CodexAppServerThreadClient> => {
    const owner = await getActive();
    return new CodexAppServerThreadClient({
      rpc: owner.client,
      clientInfo: { name: "personal-consultant-godaddy", title: "Personal Consultant", version: "1" },
      onUnresponsive: async () => {
        // Never stop a replacement login/process on behalf of an obsolete lease.
        if (active !== undefined && await active.catch(() => undefined) === owner) await closeActive(true);
      }
    });
  };

  return Object.freeze({
    getThreadClient,
    async verifyModelSelection(modelId: string, effort: string): Promise<boolean> {
      if (modelId !== "gpt-6-astra" || effort !== "xhigh") return false;
      const client = await getThreadClient();
      const thread = await client.startIsolatedThread({ modelId });
      if (!thread.ok) return false;
      try {
        const result = await client.runTextTurn({ lease: thread.value, body: "Reply with the word OK. Do not use tools.", reasoningEffort: effort, timeoutMilliseconds: 60_000 });
        // Successful execution is the availability proof; punctuation in a
        // harmless reply must not incorrectly hide an available model.
        return result.ok;
      } finally {
        await client.releaseThread(thread.value);
        const current = await getActive();
        await persist(current.connection, current.authEpoch);
      }
    },
    async inspectSubscription(): Promise<CodexAppServerProbe> {
      try {
        const current = await getActive();
        const probe = await probeCodexAppServer(current.client, { privateSingleOwner: true });
        await persist(current.connection, current.authEpoch);
        return probe;
      } catch {
        return Object.freeze({
          runtime: Object.freeze({ authMode: "other" as const, readiness: "unavailable" as const, privateSingleOwner: true, availableModelIds: Object.freeze([]) }),
          models: Object.freeze([])
        });
      }
    },
    async startDeviceAuthorization(): Promise<CodexDeviceAuthorization | undefined> {
      try {
        const current = await getActive();
        const result = await current.client.request("account/login/start", { type: "chatgptDeviceCode" });
        await persist(current.connection, current.authEpoch);
        return parseDeviceAuthorization(result);
      } catch {
        return undefined;
      }
    },
    async resetAuthorization(): Promise<boolean> {
      authEpoch += 1;
      const current = active;
      try {
        if (current !== undefined) {
          const resolved = await current;
          await resolved.client.request("account/logout", {});
        }
      } catch {
        // The persistent credential is cleared below even when the old child
        // process cannot respond, so a restart cannot revive it.
      } finally {
        await closeActive(false);
      }
      try {
        await queueCredentialOperation(() => options.vault.clear(CODEX_AUTH_STORAGE_KEY));
        return true;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      await closeActive(true);
    }
  });
}

export const codexCredentialStorageKey = (): string => CODEX_AUTH_STORAGE_KEY;
