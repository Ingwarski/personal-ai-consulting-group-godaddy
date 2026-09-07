const STAGES = new Set(["readiness", "leadership", "recovery", "ingress_lease", "input_state", "input_notice", "input_ack", "worker_state", "execution"]);
const CODES = new Set(["mysql_datetime_rejected", "mysql_lock_timeout", "mysql_deadlock", "mysql_data_too_long", "mysql_schema_error", "mysql_duplicate", "invalid_worker_state", "notice_rejected", "unknown"]);
export type ConsultationFailure = Readonly<{ stage: string; code: string }>;
export function safeConsultationFailure(value: unknown): ConsultationFailure | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  return typeof v.stage === "string" && STAGES.has(v.stage) && typeof v.code === "string" && CODES.has(v.code)
    ? { stage: v.stage, code: v.code } : undefined;
}
export function classifyConsultationFailure(stage: string, error: unknown): ConsultationFailure {
  const e = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  const codes: Record<string, string> = {
    ER_TRUNCATED_WRONG_VALUE: "mysql_datetime_rejected", ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: "mysql_datetime_rejected",
    ER_LOCK_WAIT_TIMEOUT: "mysql_lock_timeout", ER_LOCK_DEADLOCK: "mysql_deadlock", ER_DATA_TOO_LONG: "mysql_data_too_long",
    ER_BAD_FIELD_ERROR: "mysql_schema_error", ER_PARSE_ERROR: "mysql_schema_error", ER_DUP_ENTRY: "mysql_duplicate"
  };
  const code = typeof e.code === "string" && Object.hasOwn(codes, e.code) ? codes[e.code]!
    : e.message === "Consultation state is invalid." ? "invalid_worker_state"
    : e.message === "Consultation notice was not committed." ? "notice_rejected" : "unknown";
  return { stage: STAGES.has(stage) ? stage : "execution", code };
}
