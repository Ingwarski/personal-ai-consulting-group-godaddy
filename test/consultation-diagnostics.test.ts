import assert from "node:assert/strict";
import test from "node:test";
import { classifyConsultationFailure, classifyConsultationResult, safeConsultationFailure } from "../src/godaddy/consultation-diagnostics.ts";

test("consultation diagnostics classify known errors without exposing SQL, message, values or credentials", () => {
  const value = classifyConsultationFailure("ingress_lease", { code: "ER_TRUNCATED_WRONG_VALUE", sql: "private SQL", message: "private timestamp and owner data" });
  assert.deepEqual(value, { stage: "ingress_lease", code: "mysql_datetime_rejected" });
  assert.deepEqual(safeConsultationFailure({ ...value, password: "private" }), value);
  assert.equal(safeConsultationFailure({ stage: "private-stage", code: "unknown" }), undefined);
  assert.equal(safeConsultationFailure({ stage: "ingress_lease", code: "private-value" }), undefined);
  assert.deepEqual(classifyConsultationFailure("private-stage", new Error("secret")), { stage: "execution", code: "unknown" });
});

test("readiness failures retain only allowlisted cause, never raw context", () => {
  for (const reason of ["database_unavailable", "schema_unavailable", "outbox_blocked", "ingress_blocked", "sidecar_not_ready", "lock_contended", "circuit_open", "retry_exhausted", "stopping", "stopped"]) {
    const failure = classifyConsultationFailure("readiness", { code: "not_ready", readinessReason: reason, message: "private details" });
    assert.deepEqual(failure, { stage: "readiness", code: "matrix_" + reason });
    assert.deepEqual(safeConsultationFailure(failure), failure);
  }
  assert.deepEqual(classifyConsultationFailure("readiness", { code: "not_ready", readinessReason: "private details" }), { stage: "readiness", code: "unknown" });
  assert.deepEqual(classifyConsultationFailure("readiness", { code: "not_ready", readinessReason: "__proto__" }), { stage: "readiness", code: "unknown" });
  assert.deepEqual(classifyConsultationFailure("media_maintenance", { code: "ER_LOCK_WAIT_TIMEOUT" }), { stage: "media_maintenance", code: "mysql_lock_timeout" });
});

test("provider execution results expose only closed result and detail codes", () => {
  assert.deepEqual(classifyConsultationResult("execution", {
    ok: false, code: "prepare_failed", detail: "codex_effort_unavailable", raw: "PRIVATE"
  }), { stage: "execution", code: "prepare_failed", detail: "codex_effort_unavailable" });
  assert.deepEqual(classifyConsultationResult("execution", {
    ok: false, code: "consilium_route_failed", cause: "codex_turn_failed", raw: "PRIVATE"
  }), { stage: "execution", code: "consilium_route_failed", detail: "codex_turn_failed" });
  assert.deepEqual(classifyConsultationResult("private", {
    ok: false, code: "PRIVATE", detail: "PRIVATE"
  }), { stage: "execution", code: "unknown" });
  assert.equal(safeConsultationFailure({ stage: "execution", code: "prepare_failed", detail: "PRIVATE" }), undefined);
});
