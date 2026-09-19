import type { RegistrarResult } from "../session/registrar-do.ts";
import type { CodexTurnResult } from "../runtime/codex-thread-client.ts";

export type RegistrarFailureCode = Extract<RegistrarResult<unknown>, { ok: false }>["code"];
export type CodexTurnFailureCode = Extract<CodexTurnResult, { ok: false }>["code"];

export type ConsiliumFailureCause =
  | "invalid_message_id"
  | "invalid_sender_id"
  | "invalid_recipient_id"
  | "empty_body"
  | "sender_not_registered"
  | "recipient_not_registered"
  | RegistrarFailureCode
  | "confirmed_delivery_rejected"
  | "archive_rejected"
  | "runtime_missing"
  | "runtime_identity_mismatch"
  | "invalid_runtime_emission"
  | "duplicate_runtime_emission"
  | "runtime_no_output"
  | "runtime_failed"
  | "speed_policy_unresolved"
  | "speed_policy_invariant_failed"
  | "speed_policy_unsupported"
  | `codex_${CodexTurnFailureCode}`
  | "claude_status_unavailable"
  | "claude_auth_required"
  | "claude_quota_blocked"
  | "claude_unavailable"
  | "claude_auth_mode_invalid"
  | "claude_paid_acceleration_forbidden"
  | "private_boundary_failed"
  | "claude_model_not_available"
  | "claude_effort_unavailable"
  | "claude_invalid_completion";

/** Error used only inside the router frame; only its closed safe code crosses out. */
export class SafeConsiliumFailure extends Error {
  readonly code: ConsiliumFailureCause;
  readonly retryAt: string | undefined;

  constructor(code: ConsiliumFailureCause, retryAt?: string) {
    super(code);
    this.name = "SafeConsiliumFailure";
    this.code = code;
    this.retryAt = retryAt !== undefined && retryAt.length <= 64 && Number.isFinite(Date.parse(retryAt))
      ? retryAt
      : undefined;
  }
}

export const safeFailureDetails = (error: unknown): Readonly<{
  cause: ConsiliumFailureCause;
  retryAt?: string;
}> => error instanceof SafeConsiliumFailure
  ? Object.freeze({ cause: error.code, ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }) })
  : Object.freeze({ cause: "runtime_failed" });
