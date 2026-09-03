import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseMatrixNativeImport } from "../src/godaddy/native-import-diagnostic.mjs";

test("native import diagnostic identifies a missing downloaded binary without exposing a host path", async () => {
  const receipt = await diagnoseMatrixNativeImport({
    resolvePackage: () => "/app/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/package.json",
    loadModule: async () => {
      const error = new Error("Cannot find module '/app/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/matrix-sdk-crypto.linux-x64-gnu.node'");
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    }
  });
  assert.deepEqual(receipt, {
    ok: true,
    packageInstalled: true,
    nativeBinding: "unavailable",
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    failure: {
      kind: "module_or_native_binary_missing",
      code: "ERR_MODULE_NOT_FOUND",
      message: "Cannot find module '<node_modules>/@matrix-org/matrix-sdk-crypto-nodejs/matrix-sdk-crypto.linux-x64-gnu.node'"
    }
  });
});
