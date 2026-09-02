import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { SafeConsiliumFailure } from "../consilium/failures.ts";
import type { ProviderModelCapability, ReasoningDepth } from "../settings/types.ts";
import type { ClaudeCodeSubscriptionProcess, ClaudeCodeSubscriptionStatus } from "../runtime/claude-code-critic.ts";

const MAX_OUTPUT_BYTES = 96 * 1024;
const MAX_PROMPT_BYTES = 32_000;
const DEFAULT_TIMEOUT_MILLISECONDS = 9 * 60_000;

export type CommandResult = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

export type CommandRunner = (input: Readonly<{
  executable: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  cwd: string;
  timeoutMilliseconds: number;
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
  reasoningEffort: ReasoningDepth;
  prompt: string;
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
    : ["sonnet"];
  const unique = [...new Set(configured)];
  return unique.length > 0 && unique.length <= 4 && unique.every((value) => /^[A-Za-z0-9._-]{1,128}$/u.test(value))
    ? Object.freeze(unique)
    : Object.freeze([]);
}

function displayName(candidate: string): string {
  const builtIn: Record<string, string> = { sonnet: "Claude Sonnet", opus: "Claude Opus", haiku: "Claude Haiku" };
  return builtIn[candidate] ?? `Claude ${candidate}`;
}

function productId(candidate: string): string {
  return `claude-${candidate.replaceAll(/[^A-Za-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "")}`;
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
  let stdout = "";
  let stderr = "";
  let settled = false;
  let exceededOutputLimit = false;
  const child = spawn(input.executable, [...input.arguments], {
    cwd: input.cwd,
    env: input.environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settle = (result: CommandResult): void => {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
    resolveCommand(result);
  };
  const append = (current: string, next: Buffer): string => {
    if (Buffer.byteLength(current, "utf8") + next.byteLength > MAX_OUTPUT_BYTES) {
      exceededOutputLimit = true;
      child.kill("SIGTERM");
      return current;
    }
    return current + new TextDecoder().decode(next);
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  child.once("error", () => settle({ exitCode: null, stdout: "", stderr: "" }));
  child.once("close", (exitCode) => settle({
    exitCode: exceededOutputLimit ? null : exitCode,
    stdout,
    stderr
  }));
  timeout = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
  }, input.timeoutMilliseconds);
});

function parseCompletion(value: string): Readonly<{ turnRef: string; body: string }> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const result = (parsed as Record<string, unknown>).result;
    const sessionId = (parsed as Record<string, unknown>).session_id;
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

  const execute = async (argumentsList: readonly string[]): Promise<CommandResult> => {
    const directory = await mkdtemp(join(tmpdir(), "personal-consultant-claude-"));
    try {
      return await run({
        executable,
        arguments: argumentsList,
        environment: commandEnvironment(options.environment, token, directory),
        cwd: directory,
        timeoutMilliseconds
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  return Object.freeze({
    processRef,
    async inspectSubscription(): Promise<ClaudeCodeSubscriptionStatus> {
      const status = await execute(["auth", "status", "--json"]);
      const ready = status.exitCode === 0 && Buffer.byteLength(status.stdout, "utf8") <= MAX_OUTPUT_BYTES;
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
        "--effort", input.reasoningEffort,
        input.prompt
      ]);
      if (result.exitCode !== 0) throw new SafeConsiliumFailure("claude_unavailable");
      const completion = parseCompletion(result.stdout);
      if (completion === undefined) throw new SafeConsiliumFailure("claude_invalid_completion");
      return completion;
    },
    async discoverModels(): Promise<readonly ProviderModelCapability[]> {
      const status = await execute(["auth", "status", "--json"]);
      if (status.exitCode !== 0) return Object.freeze([]);
      const models: ProviderModelCapability[] = [];
      for (const candidate of candidates) {
        const supportedReasoningDepths: ReasoningDepth[] = [];
        for (const effort of ["low", "medium", "high", "xhigh"] as const) {
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
          if (probe.exitCode === 0 && parseCompletion(probe.stdout) !== undefined) supportedReasoningDepths.push(effort);
        }
        if (supportedReasoningDepths.length === 0) continue;
        const reasoningMappings: Partial<Record<ReasoningDepth, string>> = {};
        for (const effort of supportedReasoningDepths) reasoningMappings[effort] = effort;
        models.push(Object.freeze({
          productId: productId(candidate),
          displayName: displayName(candidate),
          runtimeModelId: candidate,
          availability: "available",
          supportedReasoningDepths: Object.freeze(supportedReasoningDepths),
          reasoningMappings: Object.freeze(reasoningMappings)
        }));
      }
      return Object.freeze(models);
    }
  });
}
