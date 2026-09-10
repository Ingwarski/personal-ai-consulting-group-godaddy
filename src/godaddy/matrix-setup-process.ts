import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { withMatrixPrivateUmask } from "./matrix-private-spawn.ts";

export type MatrixSetupDevice = Readonly<{ device_id: string; ed25519: string | null; verified: boolean; blacklisted: boolean; cross_signed_by_owner: boolean; deleted: boolean }>;
export type MatrixSetupStatus = Readonly<{
  own_bot_device_id: string;
  own_bot_ed25519: string | null;
  self_identity_verified: boolean;
  owner_identity_verified: boolean;
  private_cross_signing_ready: boolean;
  devices: Readonly<{ self: readonly MatrixSetupDevice[]; owner: readonly MatrixSetupDevice[] }>;
  verification: null | Readonly<{
    phase: string; target: "self" | "owner"; other_device_id: string; other_user_id: string; flow_id: string; generation: string;
    comparison_token: string | null; emojis: readonly Readonly<{ symbol: string; description: string }>[] | null;
    decimals: readonly number[] | null; confirmed: boolean;
  }>;
}>;
export type MatrixSetupCommand =
  | Readonly<{ type: "status" | "finish" | "shutdown" }>
  | Readonly<{ type: "start_self_verification" | "start_owner_verification"; device_id: string }>
  | Readonly<{ type: "confirm_sas"; flow_id: string; comparison_token: string }>
  | Readonly<{ type: "cancel_sas"; flow_id: string }>;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const string = (value: unknown, maximum = 255): value is string => typeof value === "string" && value.length > 0
  && Buffer.byteLength(value) <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
const key = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9+/]{43}=?$/u.test(value);
const device = (value: unknown): value is MatrixSetupDevice => object(value)
  && exact(value, ["device_id", "ed25519", "verified", "blacklisted", "cross_signed_by_owner", "deleted"]) && string(value.device_id) && (value.ed25519 === null || key(value.ed25519))
  && typeof value.verified === "boolean" && typeof value.blacklisted === "boolean"
  && typeof value.cross_signed_by_owner === "boolean" && typeof value.deleted === "boolean";

/** Never reflect arbitrary child stdout, error text, or credentials into owner HTML. */
export function parseMatrixSetupStatus(value: unknown): MatrixSetupStatus | undefined {
  if (!object(value) || !exact(value, ["own_bot_device_id", "own_bot_ed25519", "self_identity_verified",
    "owner_identity_verified", "private_cross_signing_ready", "devices", "verification"])
    || !string(value.own_bot_device_id) || (value.own_bot_ed25519 !== null && !key(value.own_bot_ed25519))
    || typeof value.self_identity_verified !== "boolean" || typeof value.owner_identity_verified !== "boolean"
    || typeof value.private_cross_signing_ready !== "boolean" || !object(value.devices)
    || !exact(value.devices, ["self", "owner"])) return undefined;
  for (const group of [value.devices.self, value.devices.owner]) {
    if (!Array.isArray(group) || group.length > 100 || !group.every(device)
      || new Set(group.map(d => d.device_id)).size !== group.length) return undefined;
  }
  const flow = value.verification;
  if (flow !== null) {
    if (!object(flow) || !exact(flow, ["phase", "target", "other_device_id", "other_user_id", "generation", "flow_id", "comparison_token", "emojis", "decimals", "confirmed"])
      || !string(flow.phase, 64) || !/^[a-z_]+$/u.test(flow.phase) || !["self", "owner"].includes(flow.target as string)
      || !string(flow.other_device_id) || !string(flow.other_user_id) || !string(flow.flow_id) || typeof flow.confirmed !== "boolean"
      || typeof flow.generation !== "string" || !/^[a-f0-9]{32}$/u.test(flow.generation)
      || (flow.comparison_token !== null && (typeof flow.comparison_token !== "string" || !/^[a-f0-9]{32,64}$/u.test(flow.comparison_token)))) return undefined;
    if (flow.emojis !== null && (!Array.isArray(flow.emojis) || flow.emojis.length !== 7 || !flow.emojis.every(e => object(e)
      && exact(e, ["symbol", "description"]) && string(e.symbol, 32) && string(e.description, 128)))) return undefined;
    if (flow.decimals !== null && (!Array.isArray(flow.decimals) || flow.decimals.length !== 3
      || !flow.decimals.every(n => Number.isSafeInteger(n) && n >= 1_000 && n <= 9_191))) return undefined;
    if (flow.comparison_token !== null && flow.emojis === null && flow.decimals === null) return undefined;
  }
  return value as MatrixSetupStatus;
}

export type MatrixSetupProcess = Readonly<{
  expiresAt?: number;
  request: (command: MatrixSetupCommand) => Promise<MatrixSetupStatus>;
  close: () => Promise<void>;
}>;

/** Caller first validates the pinned executable and exclusive setup mode. No inherited secrets. */
export function spawnMatrixSetupProcess(input: Readonly<{
  binaryPath: string; applicationRoot: string; fresh: boolean; environment: Readonly<Record<string, string>>;
}>, dependencies: Readonly<{ spawn?: typeof spawn; requestTimeoutMs?: number; now?: () => number }> = {}): MatrixSetupProcess {
  const now = dependencies.now ?? Date.now;
  const expiresAt = now() + 15 * 60_000;
  const child = withMatrixPrivateUmask(() => (dependencies.spawn ?? spawn)(input.binaryPath,
    ["--application-root", input.applicationRoot, ...(input.fresh ? ["--provision-fresh"] : [])],
    { cwd: input.applicationRoot, env: { ...input.environment }, stdio: ["pipe", "pipe", "pipe"], shell: false }
  )) as ChildProcessWithoutNullStreams;
  let pending: { id: string; resolve: (value: MatrixSetupStatus) => void; reject: (error: Error) => void } | undefined;
  let bytes = Buffer.alloc(0);
  let ready = false;
  let dead = false;
  let failureCode = "matrix_setup_unavailable";
  let closing: Promise<void> | undefined;
  let exited = false;
  let onExit!: () => void;
  const exit = new Promise<void>(resolve => { onExit = resolve; });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fail = (): void => {
    dead = true;
    pending?.reject(new Error("matrix_setup_process_failed"));
    pending = undefined;
    child.kill("SIGTERM");
  };
  const startup = setTimeout(fail, 60_000);
  startup.unref();
  const lifetime = setTimeout(() => { failureCode = "matrix_setup_expired"; fail(); }, 15 * 60_000);
  lifetime.unref();
  child.on("error", fail);
  child.on("exit", () => { exited = true; onExit(); clearTimeout(startup); clearTimeout(lifetime); });
  // `exit` can precede delivery of already-flushed stdout. Wait for `close`
  // before rejecting; otherwise a successful final response can be discarded.
  child.on("close", fail);
  // A setup helper may exit while an owner command is being written. EPIPE is
  // a child failure, not a reason to crash the long-lived web application.
  child.stdin.on("error", fail);
  // Drain without printing or storing SDK/HTTP error text.
  child.stderr.on("data", () => undefined);
  child.stdout.on("data", (part: Buffer) => {
    if (dead) return;
    bytes = Buffer.concat([bytes, part]);
    if (bytes.length > 64 * 1024) { fail(); return; }
    let newline: number;
    while ((newline = bytes.indexOf(10)) !== -1) {
      const line = bytes.subarray(0, newline);
      bytes = bytes.subarray(newline + 1);
      let value: unknown;
      try { value = JSON.parse(decoder.decode(line)); } catch { fail(); return; }
      if (!object(value) || value.version !== 1) { fail(); return; }
      if (!ready) {
        // The native process can fail before its ready handshake. Preserve only
        // its static public vocabulary, never arbitrary child output.
        if (exact(value, ["version", "type", "error"]) && value.type === "setup_failed"
          && typeof value.error === "string" && ["configuration_invalid", "store_locked",
            "store_or_device_quarantined", "transport_or_store_unavailable", "mysql_connection_timeout",
            "mysql_tls_failed", "mysql_login_or_database_failed", "mysql_client_configuration_failed",
            "mysql_address_failed", "mysql_connection_refused", "mysql_connection_closed", "mysql_socket_denied",
            "mysql_io_failed", "mysql_protocol_failed", "mysql_connection_failed",
            "mysql_session_timeout", "mysql_session_configuration_failed"].includes(value.error)) {
          failureCode = value.error;
          fail(); return;
        }
        if (!exact(value, ["version", "type"]) || value.type !== "setup_ready") { fail(); return; }
        ready = true; clearTimeout(startup); continue;
      }
      if (pending === undefined || value.id !== pending.id || typeof value.ok !== "boolean") { fail(); return; }
      const response = pending; pending = undefined;
      if (value.ok === false && exact(value, ["version", "id", "ok", "error"]) && typeof value.error === "string" && /^[a-z_]{1,64}$/u.test(value.error)) {
        response.reject(new Error(value.error)); continue;
      }
      const status = value.ok === true && exact(value, ["version", "id", "ok", "status"])
        ? parseMatrixSetupStatus(value.status) : undefined;
      if (status === undefined) { response.reject(new Error("matrix_setup_protocol_error")); fail(); return; }
      response.resolve(status);
    }
  });
  const close = (): Promise<void> => closing ??= (async () => {
    dead = true; clearTimeout(startup); clearTimeout(lifetime);
    pending?.reject(new Error("matrix_setup_closed")); pending = undefined;
    if (exited) return;
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); })]);
    clearTimeout(timer);
    if (!exited) child.kill("SIGKILL");
    await Promise.race([exit, new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("matrix_setup_termination_failed")), 2_000);
    })]).finally(() => clearTimeout(timer));
  })();
  return Object.freeze({
    expiresAt,
    async request(command: MatrixSetupCommand): Promise<MatrixSetupStatus> {
      if (now() >= expiresAt) { failureCode = "matrix_setup_expired"; fail(); }
      if (dead || exited) throw new Error(failureCode);
      if (pending !== undefined) throw new Error("matrix_setup_busy");
      if (!ready) throw new Error("matrix_setup_starting");
      // A fresh SAS exchange needs its full five-minute lifetime plus handshake time.
      // Do not invite the user into a flow that the fixed native deadline will kill.
      if ((command.type === "start_self_verification" || command.type === "start_owner_verification")
        && expiresAt - now() < 6 * 60_000) throw new Error("matrix_setup_needs_resume");
      const id = randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          new Promise<MatrixSetupStatus>((resolve, reject) => {
            pending = { id, resolve, reject };
            if (!child.stdin.write(`${JSON.stringify({ version: 1, id, command })}\n`, "utf8")) fail();
          }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { fail(); reject(new Error("matrix_setup_timeout")); }, dependencies.requestTimeoutMs ?? 50_000); })
        ]);
      } finally { clearTimeout(timer); }
    }, close
  });
}
