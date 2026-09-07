import assert from "node:assert/strict";
import test from "node:test";
import { classifyConsultationFailure, safeConsultationFailure } from "../src/godaddy/consultation-diagnostics.ts";

test("consultation diagnostics classify known errors without exposing SQL, message, values or credentials", () => {
  const value = classifyConsultationFailure("ingress_lease", { code: "ER_TRUNCATED_WRONG_VALUE", sql: "private SQL", message: "private timestamp and owner data" });
  assert.deepEqual(value, { stage: "ingress_lease", code: "mysql_datetime_rejected" });
  assert.deepEqual(safeConsultationFailure({ ...value, password: "private" }), value);
  assert.equal(safeConsultationFailure({ stage: "private-stage", code: "unknown" }), undefined);
  assert.equal(safeConsultationFailure({ stage: "ingress_lease", code: "private-value" }), undefined);
  assert.deepEqual(classifyConsultationFailure("private-stage", new Error("secret")), { stage: "execution", code: "unknown" });
});
