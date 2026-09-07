import assert from "node:assert/strict";
import test from "node:test";
import { inspectMatrixStoragePaths } from "../src/godaddy/matrix-storage-diagnostics.ts";

const directory = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
const file = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
const symlink = { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true };

test("storage existence diagnostics check only the fixed six paths and never read contents", async () => {
  const paths: string[] = [];
  const result = await inspectMatrixStoragePaths({ stat: async path => {
    paths.push(path); return path.endsWith("device-binding.json") ? file : directory;
  } });
  assert.equal(paths.length, 6);
  assert.deepEqual(result, { application: "directory", public: "directory", assets: "directory",
    privateRoot: "directory", cryptoStore: "directory", deviceBinding: "file" });
  assert.deepEqual(paths.slice(1), ["public", "public/assets", "public/assets/.personal-consultant-matrix-v1",
    "public/assets/.personal-consultant-matrix-v1/crypto-store", "public/assets/.personal-consultant-matrix-v1/crypto-store/device-binding.json"]
    .map(path => `${paths[0]}/${path}`));
});

for (const [code, expected] of [["ENOENT", "missing"], ["ENOTDIR", "missing"], ["EACCES", "denied"],
  ["EPERM", "denied"], ["EIO", "unavailable"], ["private-provider-error", "unavailable"]] as const) {
  test(`storage metadata failure ${code} is sanitized and prevents descendant access`, async () => {
    let reads = 0;
    const result = await inspectMatrixStoragePaths({ stat: async () => {
      if (++reads === 4) throw Object.assign(new Error("secret detail"), { code });
      return directory;
    } });
    assert.equal(reads, 4);
    assert.equal(result.privateRoot, expected);
    assert.equal(result.cryptoStore, "not_checked"); assert.equal(result.deviceBinding, "not_checked");
    assert.ok(!JSON.stringify(result).includes("secret"));
  });
}

for (const [kind, value] of [["symlink", symlink], ["file", file]] as const) {
  test(`storage diagnostics do not traverse a ${kind} ancestor`, async () => {
    let reads = 0;
    const result = await inspectMatrixStoragePaths({ stat: async () => ++reads === 3 ? value : directory });
    assert.equal(reads, 3); assert.equal(result.assets, kind); assert.equal(result.deviceBinding, "not_checked");
  });
}
