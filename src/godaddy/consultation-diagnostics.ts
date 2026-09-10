const STAGES = new Set(["media_maintenance", "readiness", "leadership", "recovery", "ingress_lease", "input_state", "input_notice", "input_ack", "worker_state", "execution"]);
const READINESS_CODES: Readonly<Record<string, string>> = Object.freeze({
  database_unavailable: "matrix_database_unavailable", schema_unavailable: "matrix_schema_unavailable",
  outbox_blocked: "matrix_outbox_blocked", ingress_blocked: "matrix_ingress_blocked",
  media_consumer_unavailable: "matrix_media_unavailable", sidecar_not_ready: "matrix_sidecar_not_ready",
  lock_contended: "matrix_lock_contended", circuit_open: "matrix_circuit_open",
  retry_exhausted: "matrix_retry_exhausted", stopping: "matrix_stopping", stopped: "matrix_stopped"
});
const CODES = new Set([
  "mysql_datetime_rejected", "mysql_lock_timeout", "mysql_deadlock", "mysql_data_too_long", "mysql_schema_error", "mysql_duplicate",
  "invalid_worker_state", "notice_rejected", "unknown", ...Object.values(READINESS_CODES),
  "runtime_unavailable", "session_unavailable", "session_busy", "invalid_task", "catalog_unavailable", "prepare_failed",
  "speed_policy_unresolved", "consilium_route_failed", "head_synthesis_failed", "finalization_failed",
  "publication_lock_unavailable", "publication_lock_release_failed", "publication_state_invalid", "publication_unresolved"
]);
const DETAILS = new Set([
  "invalid_roles", "preflight_failed", "codex_thread_start_failed", "cancelled",
  "forbidden_environment", "settings_incompatible", "codex_auth_required", "claude_auth_required", "codex_quota_blocked",
  "claude_quota_blocked", "codex_unavailable", "claude_unavailable", "private_boundary_failed", "codex_auth_mode_invalid",
  "claude_auth_mode_invalid", "claude_paid_acceleration_forbidden", "codex_model_not_available", "claude_model_not_available",
  "catalog_version_mismatch", "codex_effort_unavailable", "claude_effort_unavailable", "claude_status_unavailable",
  "head_transport_error", "head_invalid_thread_response", "specialist_transport_error", "specialist_invalid_thread_response",
  "critic_transport_error", "critic_invalid_thread_response",
  "invalid_message_id", "invalid_sender_id", "invalid_recipient_id", "empty_body", "sender_not_registered", "recipient_not_registered",
  "active_session_exists", "no_active_session", "obsolete_generation", "session_not_active", "invalid_session_id", "invalid_event",
  "idempotency_conflict", "confirmed_delivery_rejected", "runtime_missing", "runtime_identity_mismatch", "invalid_runtime_emission",
  "duplicate_runtime_emission", "runtime_no_output", "runtime_failed", "speed_policy_invariant_failed", "speed_policy_unsupported",
  "codex_transport_error", "codex_invalid_thread_response", "codex_invalid_turn_response", "codex_turn_failed",
  "codex_missing_agent_message", "codex_turn_timeout", "codex_turn_cancelled", "claude_invalid_completion"
]);
export type ConsultationFailure = Readonly<{ stage: string; code: string; detail?: string }>;
export function safeConsultationFailure(value: unknown): ConsultationFailure | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.stage !== "string" || !STAGES.has(v.stage) || typeof v.code !== "string" || !CODES.has(v.code) ||
    (v.detail !== undefined && (typeof v.detail !== "string" || !DETAILS.has(v.detail)))) return undefined;
  return { stage: v.stage, code: v.code, ...(v.detail === undefined ? {} : { detail: v.detail }) };
}
export function classifyConsultationFailure(stage: string, error: unknown): ConsultationFailure {
  const e = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  const codes: Record<string, string> = {
    ER_TRUNCATED_WRONG_VALUE: "mysql_datetime_rejected", ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: "mysql_datetime_rejected",
    ER_LOCK_WAIT_TIMEOUT: "mysql_lock_timeout", ER_LOCK_DEADLOCK: "mysql_deadlock", ER_DATA_TOO_LONG: "mysql_data_too_long",
    ER_BAD_FIELD_ERROR: "mysql_schema_error", ER_PARSE_ERROR: "mysql_schema_error", ER_DUP_ENTRY: "mysql_duplicate"
  };
  const code = e.code === "not_ready" && typeof e.readinessReason === "string" && Object.hasOwn(READINESS_CODES, e.readinessReason)
    ? READINESS_CODES[e.readinessReason]!
    : typeof e.code === "string" && CODES.has(e.code) ? e.code
    : typeof e.code === "string" && Object.hasOwn(codes, e.code) ? codes[e.code]!
    : e.message === "Consultation state is invalid." ? "invalid_worker_state"
    : e.message === "Consultation notice was not committed." ? "notice_rejected" : "unknown";
  return { stage: STAGES.has(stage) ? stage : "execution", code };
}

/** Converts only closed, non-provider-text result codes into owner diagnostics. */
export function classifyConsultationResult(stage: string, value: unknown): ConsultationFailure {
  if (value === null || typeof value !== "object") return { stage: STAGES.has(stage) ? stage : "execution", code: "unknown" };
  const result = value as Record<string, unknown>;
  const code = typeof result.code === "string" && CODES.has(result.code) ? result.code : "unknown";
  const candidate = typeof result.detail === "string" ? result.detail : typeof result.cause === "string" ? result.cause : undefined;
  return {
    stage: STAGES.has(stage) ? stage : "execution",
    code,
    ...(candidate !== undefined && DETAILS.has(candidate) ? { detail: candidate } : {})
  };
}
