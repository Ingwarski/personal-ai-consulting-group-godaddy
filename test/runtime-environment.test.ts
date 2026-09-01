import assert from "node:assert/strict";
import test from "node:test";

import { FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES, parseRuntimeEnvironment } from "../src/runtime/environment.ts";

test("accepts only an explicit supported runtime mode", () => {
  const result = parseRuntimeEnvironment({ RUNTIME_MODE: "test" });

  assert.deepEqual(result, { ok: true, value: { runtimeMode: "test" } });
});

test("fails closed for an unknown runtime mode", () => {
  assert.deepEqual(parseRuntimeEnvironment({ RUNTIME_MODE: "preview" }), {
    ok: false,
    code: "invalid_runtime_mode"
  });
});

test("fails closed whenever a forbidden provider credential/configuration is present", () => {
  for (const name of FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES) {
    assert.deepEqual(
      parseRuntimeEnvironment({ RUNTIME_MODE: "test", [name]: "present" }),
      { ok: false, code: "forbidden_environment" },
      name
    );
  }
});
