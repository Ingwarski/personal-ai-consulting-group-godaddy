import assert from "node:assert/strict";
import test from "node:test";

import {
  readExistingMatrixStoreBinding,
  type MatrixBindingFileSystem,
  type MatrixBindingStat
} from "../src/godaddy/matrix-store-binding.ts";

const storeDir = "/srv/personal-consultant/state/matrix-store";
const bindingPath = `${storeDir}/device-binding.json`;
const deviceId = "BOT_DEVICE_1";
const fingerprint = "a".repeat(64);
const canonical = Buffer.from(JSON.stringify({
  device_id: deviceId,
  store_fingerprint: fingerprint
}), "utf8");

function directoryStat(overrides: Partial<MatrixBindingStat> = {}): MatrixBindingStat {
  return {
    mode: 0o040700,
    uid: 501,
    dev: 1,
    ino: 10,
    size: 96,
    mtimeMs: 10,
    ctimeMs: 10,
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    ...overrides
  };
}

function fileStat(overrides: Partial<MatrixBindingStat> = {}): MatrixBindingStat {
  return {
    mode: 0o100600,
    uid: 501,
    dev: 1,
    ino: 11,
    size: canonical.byteLength,
    mtimeMs: 20,
    ctimeMs: 20,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    ...overrides
  };
}

function fileSystem(input: Readonly<{
  bytes?: Buffer;
  directoryBefore?: MatrixBindingStat;
  directoryAfter?: MatrixBindingStat;
  fileBefore?: MatrixBindingStat;
  openedBefore?: MatrixBindingStat;
  openedAfter?: MatrixBindingStat;
  fileAfter?: MatrixBindingStat;
  realStoreDir?: string;
}> = {}): MatrixBindingFileSystem {
  const bytes = input.bytes ?? canonical;
  const directories = [input.directoryBefore ?? directoryStat(), input.directoryAfter ?? input.directoryBefore ?? directoryStat()];
  const files = [input.fileBefore ?? fileStat({ size: bytes.byteLength }), input.fileAfter ?? input.fileBefore ?? fileStat({ size: bytes.byteLength })];
  const opened = [input.openedBefore ?? input.fileBefore ?? fileStat({ size: bytes.byteLength }), input.openedAfter ?? input.openedBefore ?? input.fileBefore ?? fileStat({ size: bytes.byteLength })];
  return {
    async lstat(path): Promise<MatrixBindingStat> {
      if (path === storeDir) return directories.shift() ?? directoryStat();
      if (path === bindingPath) return files.shift() ?? fileStat({ size: bytes.byteLength });
      throw new Error("unexpected path");
    },
    async realpath(): Promise<string> {
      return input.realStoreDir ?? storeDir;
    },
    async openNoFollow(path) {
      assert.equal(path, bindingPath);
      return {
        async stat(): Promise<MatrixBindingStat> {
          return opened.shift() ?? fileStat({ size: bytes.byteLength });
        },
        async read(buffer, offset, length, position) {
          const available = Math.max(0, bytes.byteLength - position);
          const bytesRead = Math.min(length, available);
          bytes.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead };
        },
        async close() {}
      };
    }
  };
}

test("loads one canonical private existing-store binding through the verified descriptor", async () => {
  const result = await readExistingMatrixStoreBinding({
    storeDir,
    expectedDeviceId: deviceId,
    expectedOwnerUid: 501,
    fileSystem: fileSystem()
  });
  assert.deepEqual(result, {
    ok: true,
    value: { deviceId, storeFingerprint: fingerprint }
  });
});

test("rejects unsafe store or binding metadata before use", async (context) => {
  const cases: readonly [string, MatrixBindingFileSystem][] = [
    ["root symlink", fileSystem({ directoryBefore: directoryStat({ isSymbolicLink: () => true }) })],
    ["ancestor resolution", fileSystem({ realStoreDir: "/other/matrix-store" })],
    ["wrong owner", fileSystem({ fileBefore: fileStat({ uid: 777 }) })],
    ["group-readable binding", fileSystem({ fileBefore: fileStat({ mode: 0o100640 }) })],
    ["binding symlink", fileSystem({ fileBefore: fileStat({ isSymbolicLink: () => true }) })],
    ["special mode bit", fileSystem({ fileBefore: fileStat({ mode: 0o104600 }) })],
    ["oversized binding", fileSystem({ fileBefore: fileStat({ size: 4_097 }) })]
  ];
  for (const [name, fake] of cases) {
    await context.test(name, async () => {
      assert.deepEqual(await readExistingMatrixStoreBinding({
        storeDir,
        expectedDeviceId: deviceId,
        expectedOwnerUid: 501,
        fileSystem: fake
      }), { ok: false, code: "store_binding_invalid" });
    });
  }
});

test("rejects inode replacement and same-inode mutation during the read", async (context) => {
  await context.test("replacement", async () => {
    const result = await readExistingMatrixStoreBinding({
      storeDir,
      expectedDeviceId: deviceId,
      expectedOwnerUid: 501,
      fileSystem: fileSystem({ fileAfter: fileStat({ ino: 99 }) })
    });
    assert.deepEqual(result, { ok: false, code: "store_binding_invalid" });
  });
  await context.test("mutation", async () => {
    const result = await readExistingMatrixStoreBinding({
      storeDir,
      expectedDeviceId: deviceId,
      expectedOwnerUid: 501,
      fileSystem: fileSystem({ openedAfter: fileStat({ mtimeMs: 21, ctimeMs: 21 }) })
    });
    assert.deepEqual(result, { ok: false, code: "store_binding_invalid" });
  });
});

test("rejects wrong device, ambiguous JSON and a file that grows beyond its verified size", async (context) => {
  const values = [
    Buffer.from(JSON.stringify({ device_id: "OTHER_DEVICE", store_fingerprint: fingerprint })),
    Buffer.from(`{\"device_id\":\"${deviceId}\",\"device_id\":\"${deviceId}\",\"store_fingerprint\":\"${fingerprint}\"}`),
    Buffer.from(`${canonical.toString("utf8")}\n`)
  ];
  for (const bytes of values) {
    assert.deepEqual(await readExistingMatrixStoreBinding({
      storeDir,
      expectedDeviceId: deviceId,
      expectedOwnerUid: 501,
      fileSystem: fileSystem({ bytes })
    }), { ok: false, code: "store_binding_invalid" });
  }

  await context.test("growth", async () => {
    const grown = Buffer.concat([canonical, Buffer.from("x")]);
    const stableOriginal = fileStat({ size: canonical.byteLength });
    assert.deepEqual(await readExistingMatrixStoreBinding({
      storeDir,
      expectedDeviceId: deviceId,
      expectedOwnerUid: 501,
      fileSystem: fileSystem({
        bytes: grown,
        fileBefore: stableOriginal,
        openedBefore: stableOriginal,
        openedAfter: stableOriginal,
        fileAfter: stableOriginal
      })
    }), { ok: false, code: "store_binding_invalid" });
  });
});

test("reports an unavailable binding without exposing filesystem detail", async () => {
  const unavailable: MatrixBindingFileSystem = {
    async lstat() { throw new Error("sensitive filesystem detail"); },
    async realpath() { throw new Error("sensitive filesystem detail"); },
    async openNoFollow() { throw new Error("sensitive filesystem detail"); }
  };
  const result = await readExistingMatrixStoreBinding({
    storeDir,
    expectedDeviceId: deviceId,
    expectedOwnerUid: 501,
    fileSystem: unavailable
  });
  assert.deepEqual(result, { ok: false, code: "store_binding_unavailable" });
  assert.doesNotMatch(JSON.stringify(result), /sensitive|filesystem/i);
});

test("classifies temporary, missing and access-denied storage without exposing paths or resetting identity", async () => {
  for (const [code, expected] of [
    ["EIO", "store_binding_transient"], ["EAGAIN", "store_binding_transient"],
    ["ESTALE", "store_binding_transient"], ["ETIMEDOUT", "store_binding_transient"],
    ["ENOENT", "store_binding_missing"], ["ENOTDIR", "store_binding_missing"],
    ["EACCES", "store_binding_access_denied"], ["EPERM", "store_binding_access_denied"],
    ["ELOOP", "store_binding_unavailable"]
  ]) {
    const result = await readExistingMatrixStoreBinding({ storeDir, expectedDeviceId: deviceId, expectedOwnerUid: 501,
      fileSystem: { ...fileSystem(), lstat: async () => { throw Object.assign(new Error("private path and token"), { code }); } } });
    assert.deepEqual(result, { ok: false, code: expected });
    assert.doesNotMatch(JSON.stringify(result), /private|token|srv/u);
  }
});
