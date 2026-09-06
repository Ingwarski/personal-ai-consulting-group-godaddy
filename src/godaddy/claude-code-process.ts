import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { SafeConsiliumFailure } from "../consilium/failures.ts";
import type { ProviderModelCapability, ProviderReasoningEffort } from "../settings/types.ts";
import type { ClaudeCodeSubscriptionProcess, ClaudeCodeSubscriptionStatus } from "../runtime/claude-code-critic.ts";

const MAX_OUTPUT_BYTES = 96 * 1024;
const MAX_PROMPT_BYTES = 32_000;
const DEFAULT_TIMEOUT_MILLISECONDS = 9 * 60_000;
const DEFAULT_CLAUDE_CODE_MODEL_CANDIDATES = Object.freeze([
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001"
]);
const CLAUDE_MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-5": "Claude Opus 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  fable: "Claude Fable",
  opus: "Claude Opus",
  sonnet: "Claude Sonnet",
  haiku: "Claude Haiku"
});

export type CommandResult = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  termination?: "spawn_failed" | "timeout" | "output_limit" | "signal";
}>;

export type ClaudeDiscoveryFailureCode = "claude_auth_rejected" | "claude_access_denied" | "claude_quota_blocked" |
  "claude_cli_incompatible" | "claude_process_failed" | "claude_invalid_response" | "claude_models_unavailable";

// Only these fixed categories may cross the provider boundary. Never retain a
// raw CLI error as message/cause: it can contain credentials or response data.
export class ClaudeDiscoveryFailure extends Error {
  readonly code: ClaudeDiscoveryFailureCode;
  readonly diagnostic: ReturnType<typeof commandDiagnostic> | undefined;
  constructor(code: ClaudeDiscoveryFailureCode, result?: CommandResult) {
    super(code); this.name = "ClaudeDiscoveryFailure"; this.code = code;
    this.diagnostic = result === undefined ? undefined : commandDiagnostic(result);
  }
}

// Numeric fields and a closed vocabulary only. No provider text, identity,
// session IDs, paths, prompts, headers or credentials can enter the server log.
function commandDiagnostic(result: CommandResult) {
  let record: Record<string, unknown> = {};
  let jsonObject = false;
  try {
    const value: unknown = JSON.parse(result.stdout.length <= MAX_OUTPUT_BYTES ? result.stdout : "null");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) { record = value as Record<string, unknown>; jsonObject = true; }
  } catch { /* Non-JSON CLI failures are represented by booleans only. */ }
  const errorMessages = Array.isArray(record.errors) ? record.errors.filter((value): value is string => typeof value === "string").slice(0, 10).join("\n") : "";
  const message = jsonObject ? `${typeof record.result === "string" ? record.result : ""}\n${errorMessages}` : result.stdout;
  const text = `${message}\n${result.stderr}`.slice(0, MAX_OUTPUT_BYTES * 2);
  const hints = [
    ["oauth_scope", /(?:oauth|token).{0,100}(?:scope|permission)|insufficient_scope/iu],
    ["organization", /organization|workspace|membership|account.{0,60}(?:disabled|suspended)/iu],
    ["billing", /credit balance|billing|payment required|extra usage|spending limit/iu],
    ["region", /unsupported country|country.{0,60}not supported|region.{0,60}not supported/iu],
    ["tls", /certificate|CERT_|TLS|SSL/iu],
    ["network", /ENOTFOUND|ECONN|ETIMEDOUT|network error|connection error|fetch failed/iu],
    ["filesystem", /EACCES|EPERM|EROFS|read-only file system|permission denied/iu],
    ["model", /model/iu],
    ["access_denied", /forbidden|access denied|not authorized|not allowed/iu]
  ] as const;
  const apiStatus = record.api_error_status;
  const terminalReason = ["api_error", "completed", "max_turns", "max_budget_usd", "stop_sequence"].find(value => value === record.terminal_reason) ?? "other_or_absent";
  return Object.freeze({
    exit_code: Number.isInteger(result.exitCode) && result.exitCode! >= 0 && result.exitCode! <= 255 ? result.exitCode : null,
    termination: ["spawn_failed", "timeout", "output_limit", "signal"].find(value => value === result.termination) ?? "exited",
    api_status: typeof apiStatus === "number" && Number.isInteger(apiStatus) && apiStatus >= 100 && apiStatus <= 599 ? apiStatus : null,
    json_object: jsonObject,
    stdout_present: result.stdout.length > 0,
    stderr_present: result.stderr.length > 0,
    terminal_reason: terminalReason,
    failure_hint: hints.find(([, pattern]) => pattern.test(text))?.[0] ?? "unclassified"
  });
}

function subscriptionAuthenticated(status: CommandResult): boolean {
  if (status.exitCode !== 0 || Buffer.byteLength(status.stdout, "utf8") > MAX_OUTPUT_BYTES) return false;
  try {
    const value: unknown = JSON.parse(status.stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    // This launcher injects only CLAUDE_CODE_OAUTH_TOKEN, not an API key or
    // another provider's credentials. Presence is not a successful model call.
    return record.loggedIn === true && record.authMethod === "oauth_token" && record.apiProvider === "firstParty";
  } catch { return false; }
}

function discoveryFailure(result: CommandResult): ClaudeDiscoveryFailureCode {
  const text = `${result.stdout}\n${result.stderr}`.slice(0, MAX_OUTPUT_BYTES * 2);
  if (commandDiagnostic(result).api_status === 403 || /\b403\b/iu.test(text)) return "claude_access_denied";
  if (/unknown (?:option|argument)|unrecognized (?:option|argument)/iu.test(text)) return "claude_cli_incompatible";
  if (/\b401\b|authentication_error|invalid.{0,30}(?:token|credential)|(?:token|credential).{0,30}(?:expired|invalid)|not logged in|please (?:run \/login|log in)/iu.test(text)) return "claude_auth_rejected";
  if (/\b429\b|rate_limit|rate limit|usage limit|quota|hit your limit/iu.test(text)) return "claude_quota_blocked";
  if (/model.{0,80}(?:not found|not available|unavailable|not supported)|(?:invalid|unknown|unsupported) model|does not exist/iu.test(text)) return "claude_models_unavailable";
  return result.exitCode === 0 ? "claude_invalid_response" : "claude_process_failed";
}

export type CommandRunner = (input: Readonly<{
  executable: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  cwd: string;
  timeoutMilliseconds: number;
  signal?: AbortSignal;
}>) => Promise<CommandResult>;

export type GoDaddyClaudeCodeProcess = ClaudeCodeSubscriptionProcess & Readonly<{
  processRef: string;
  discoverModels: () => Promise<readonly ProviderModelCapability[]>;
}>;

export type GoDaddyClaudeCodeProcessOptions = Readonly<{
  environment: Record<string, unknown>;
  /**
   * A trusted capability receipt supplies this list after the provider-specific
   * discovery operation.  This launcher never invents a model catalogue.
   */
  getModels: () => readonly ProviderModelCapability[];
  executable?: string;
  processRef?: string;
  run?: CommandRunner;
  timeoutMilliseconds?: number;
}>;

type CritiqueInput = Readonly<{
  modelId: string;
  runtimeModelId: string;
  reasoningEffort: ProviderReasoningEffort | null;
  prompt: string;
  signal?: AbortSignal;
}>;

const asToken = (value: unknown): string | undefined =>
  typeof value === "string" && value.length >= 16 && value.length <= 4096 && value.trim() === value
    ? value
    : undefined;

const safeText = (value: unknown, maximum = MAX_PROMPT_BYTES): value is string =>
  typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maximum;

function processReference(value: string | undefined): string {
  if (value !== undefined && /^[A-Za-z0-9_-]{1,256}$/u.test(value)) return value;
  return `claude-${randomUUID().replaceAll("-", "")}`;
}

function executablePath(value: string | undefined): string {
  return value ?? resolve(process.cwd(), "node_modules", ".bin", "claude");
}

function candidateModels(environment: Record<string, unknown>): readonly string[] {
  const configured = typeof environment.CLAUDE_CODE_MODEL_CANDIDATES === "string"
    ? environment.CLAUDE_CODE_MODEL_CANDIDATES.split(",").map((value) => value.trim()).filter((value) => value.length > 0)
    : DEFAULT_CLAUDE_CODE_MODEL_CANDIDATES;
  const unique = [...new Set(configured)];
  return unique.length > 0 && unique.length <= DEFAULT_CLAUDE_CODE_MODEL_CANDIDATES.length && unique.every((value) => /^[A-Za-z0-9._-]{1,128}$/u.test(value))
    ? Object.freeze(unique)
    : Object.freeze([]);
}

function displayName(candidate: string): string {
  return CLAUDE_MODEL_DISPLAY_NAMES[candidate] ?? `Claude ${candidate}`;
}

function productId(candidate: string): string {
  const normalized = candidate.replaceAll(/[^A-Za-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized.startsWith("claude-") ? normalized : `claude-${normalized}`;
}

function commandEnvironment(environment: Record<string, unknown>, token: string, directory: string): Readonly<Record<string, string>> {
  const path = typeof environment.PATH === "string" && environment.PATH.length > 0
    ? environment.PATH
    : "/usr/local/bin:/usr/bin:/bin";
  return Object.freeze({
    PATH: path,
    HOME: directory,
    TMPDIR: directory,
    CLAUDE_CONFIG_DIR: join(directory, "config"),
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_DISABLE_FAST_MODE: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
    CLAUDE_CODE_DISABLE_CRON: "1",
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: "1",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    NO_COLOR: "1"
  });
}

/**
 * Runs Claude Code in an empty, disposable directory.  It deliberately
 * passes a tiny environment allowlist: the subscription token is the only
 * credential the child receives, and neither MySQL nor owner-access secrets
 * can be observed by a generated response or a tool.
 */
export const runClaudeCommand: CommandRunner = async (input) => new Promise((resolveCommand) => {
  if (input.signal?.aborted) { resolveCommand({ exitCode: null, stdout: "", stderr: "", termination: "signal" }); return; }
  let stdout = "";
  let stderr = "";
  let settled = false;
  let exceededOutputLimit = false;
  let timedOut = false;
  const child = spawn(input.executable, [...input.arguments], {
    cwd: input.cwd,
    env: input.environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let killTimeout: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => { child.kill("SIGTERM"); killTimeout ??= setTimeout(() => child.kill("SIGKILL"), 1_000); killTimeout.unref(); };
  input.signal?.addEventListener("abort", terminate, { once: true });
  if (input.signal?.aborted) terminate();
  const settle = (result: CommandResult): void => {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
    if (killTimeout !== undefined) clearTimeout(killTimeout);
    input.signal?.removeEventListener("abort", terminate);
    resolveCommand(result);
  };
  const append = (current: string, next: Buffer): string => {
    if (Buffer.byteLength(current, "utf8") + next.byteLength > MAX_OUTPUT_BYTES) {
      exceededOutputLimit = true;
      terminate();
      return current;
    }
    return current + new TextDecoder().decode(next);
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  child.once("error", () => settle({ exitCode: null, stdout: "", stderr: "", termination: "spawn_failed" }));
  child.once("close", (exitCode, signal) => settle({
    exitCode: exceededOutputLimit ? null : exitCode,
    stdout,
    stderr,
    ...(exceededOutputLimit ? { termination: "output_limit" as const } : timedOut ? { termination: "timeout" as const } : signal !== null ? { termination: "signal" as const } : {})
  }));
  timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, input.timeoutMilliseconds);
});

function parseCompletion(value: string): Readonly<{ turnRef: string; body: string }> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const result = (parsed as Record<string, unknown>).result;
    const sessionId = (parsed as Record<string, unknown>).session_id;
    const isError = (parsed as Record<string, unknown>).is_error;
    const subtype = (parsed as Record<string, unknown>).subtype;
    if ((isError !== undefined && isError !== false) || (subtype !== undefined && subtype !== "success")) return undefined;
    if (!safeText(result) || typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(sessionId)) return undefined;
    return Object.freeze({ turnRef: sessionId, body: result });
  } catch {
    return undefined;
  }
}

/**
 * Creates the production Claude Code boundary.  `claude setup-token` stores
 * no token locally; GoDaddy injects it only into this isolated child process.
 * The process uses subscription OAuth, disables Fast Mode defensively, and
 * executes with no Claude tools, plugins, hooks, files, or session cache.
 */
export function createGoDaddyClaudeCodeProcess(options: GoDaddyClaudeCodeProcessOptions): GoDaddyClaudeCodeProcess | undefined {
  const token = asToken(options.environment.CLAUDE_CODE_OAUTH_TOKEN);
  if (token === undefined) return undefined;
  const executable = executablePath(options.executable);
  const processRef = processReference(options.processRef);
  const run = options.run ?? runClaudeCommand;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  const candidates = candidateModels(options.environment);

  const execute = async (argumentsList: readonly string[], signal?: AbortSignal): Promise<CommandResult> => {
    const directory = await mkdtemp(join(tmpdir(), "personal-consultant-claude-"));
    try {
      return await run({
        executable,
        arguments: argumentsList,
        environment: commandEnvironment(options.environment, token, directory),
        cwd: directory,
        timeoutMilliseconds,
        ...(signal === undefined ? {} : { signal })
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  return Object.freeze({
    processRef,
    async inspectSubscription(): Promise<ClaudeCodeSubscriptionStatus> {
      const status = await execute(["auth", "status", "--json"]);
      const ready = subscriptionAuthenticated(status);
      return Object.freeze({
        processRef,
        authMode: ready ? "claude_code_oauth" : "other",
        readiness: ready ? "ready" : "auth_required",
        privateSingleOwner: true,
        bareMode: false,
        fastModeEnabled: false,
        extraUsageEnabled: false,
        models: Object.freeze([...options.getModels()])
      });
    },
    async runCritique(input: CritiqueInput): Promise<Readonly<{ turnRef: string; body: string }>> {
      if (!safeText(input.prompt) || !/^[A-Za-z0-9._-]{1,256}$/u.test(input.runtimeModelId)) {
        throw new SafeConsiliumFailure("claude_unavailable");
      }
      const result = await execute([
        "--print",
        "--output-format", "json",
        "--no-session-persistence",
        "--safe-mode",
        "--restricted",
        "--tools", "",
        "--strict-mcp-config",
        "--permission-mode", "dontAsk",
        "--model", input.runtimeModelId,
        ...(input.reasoningEffort === null ? [] : ["--effort", input.reasoningEffort]),
        input.prompt
      ], input.signal);
      if (result.exitCode !== 0) throw new SafeConsiliumFailure("claude_unavailable");
      const completion = parseCompletion(result.stdout);
      if (completion === undefined) throw new SafeConsiliumFailure("claude_invalid_completion");
      return completion;
    },
    async discoverModels(): Promise<readonly ProviderModelCapability[]> {
      const status = await execute(["auth", "status", "--json"]);
      if (!subscriptionAuthenticated(status)) throw new ClaudeDiscoveryFailure("claude_auth_rejected", status);
      const models: ProviderModelCapability[] = [];
      let failure: ClaudeDiscoveryFailureCode = "claude_models_unavailable";
      let failedResult: CommandResult | undefined;
      for (const candidate of candidates) {
        const baseline = await execute([
          "--print",
          "--output-format", "json",
          "--no-session-persistence",
          "--safe-mode",
          "--restricted",
          "--tools", "",
          "--strict-mcp-config",
          "--permission-mode", "dontAsk",
          "--model", candidate,
          "Reply with the single word READY."
        ]);
        if (baseline.exitCode !== 0 || parseCompletion(baseline.stdout) === undefined) {
          failure = discoveryFailure(baseline);
          failedResult = baseline;
          if (failure === "claude_auth_rejected" || failure === "claude_quota_blocked" || failure === "claude_cli_incompatible") {
            throw new ClaudeDiscoveryFailure(failure, baseline);
          }
          continue;
        }
        const supportedReasoningEfforts: ProviderReasoningEffort[] = [];
        for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
          const probe = await execute([
            "--print",
            "--output-format", "json",
            "--no-session-persistence",
            "--safe-mode",
            "--restricted",
            "--tools", "",
            "--strict-mcp-config",
            "--permission-mode", "dontAsk",
            "--model", candidate,
            "--effort", effort,
            "Reply with the single word READY."
          ]);
          if (probe.exitCode === 0 && parseCompletion(probe.stdout) !== undefined) supportedReasoningEfforts.push(effort);
          else {
            const code = discoveryFailure(probe);
            if (code === "claude_auth_rejected" || code === "claude_quota_blocked" || code === "claude_cli_incompatible") throw new ClaudeDiscoveryFailure(code, probe);
          }
        }
        const reasoningMappings: Record<ProviderReasoningEffort, string> = {};
        for (const effort of supportedReasoningEfforts) reasoningMappings[effort] = effort;
        models.push(Object.freeze({
          productId: productId(candidate),
          displayName: displayName(candidate),
          runtimeModelId: candidate,
          availability: "available",
          supportedReasoningEfforts: Object.freeze(supportedReasoningEfforts),
          reasoningMappings: Object.freeze(reasoningMappings)
        }));
      }
      if (models.length === 0) throw new ClaudeDiscoveryFailure(failure, failedResult);
      return Object.freeze(models);
    }
  });
}
