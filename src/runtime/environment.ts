export const FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_API_HOST",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "OPENAI_ORGANIZATION",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
  "CLAUDE_CODE_ENABLE_EXTRA_USAGE",
  "CLAUDE_CODE_FAST_MODE"
] as const;

export const RUNTIME_MODES = ["development", "test", "production"] as const;

export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export type RuntimeEnvironment = Readonly<{
  runtimeMode: RuntimeMode;
}>;

export type EnvironmentValidationResult =
  | Readonly<{ ok: true; value: RuntimeEnvironment }>
  | Readonly<{ ok: false; code: "forbidden_environment" | "invalid_runtime_mode" }>;

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export function parseRuntimeEnvironment(
  environment: Record<string, unknown>
): EnvironmentValidationResult {
  if (FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES.some((name) => hasOwn(environment, name))) {
    return { ok: false, code: "forbidden_environment" };
  }

  const runtimeMode = environment.RUNTIME_MODE;
  if (typeof runtimeMode !== "string" || !RUNTIME_MODES.includes(runtimeMode as RuntimeMode)) {
    return { ok: false, code: "invalid_runtime_mode" };
  }

  return {
    ok: true,
    value: Object.freeze({ runtimeMode: runtimeMode as RuntimeMode })
  };
}
