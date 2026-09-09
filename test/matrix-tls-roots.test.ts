import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";

import { writeNodeDefaultCaBundle } from "../src/godaddy/matrix-tls-roots.ts";

test("writes the active Node CA roots only into one private owned temporary bundle", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "matrix-ca-test-"));
  try {
    const path = await writeNodeDefaultCaBundle(directory, rootCertificates.slice(0, 2));
    const contents = await readFile(path, "utf8");
    assert.equal(path, join(directory, "node-default-ca.pem"));
    assert.equal(contents, rootCertificates.slice(0, 2).map(value => `${value.trimEnd()}\n`).join(""));
    await assert.rejects(writeNodeDefaultCaBundle(directory, rootCertificates.slice(0, 1)), {
      message: "matrix_setup_tls_roots_unavailable"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects empty, malformed or non-private CA bundle targets", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "matrix-ca-test-"));
  try {
    await assert.rejects(writeNodeDefaultCaBundle(directory, []), {
      message: "matrix_setup_tls_roots_unavailable"
    });
    await assert.rejects(writeNodeDefaultCaBundle(directory, ["not a certificate"]), {
      message: "matrix_setup_tls_roots_unavailable"
    });
    await assert.rejects(writeNodeDefaultCaBundle("relative-directory", rootCertificates.slice(0, 1)), {
      message: "matrix_setup_tls_roots_unavailable"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
