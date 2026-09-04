import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CHECKSUM_PATTERN = /^([a-f0-9]{64})  godaddy-rust-probe\n$/u;

export async function verifyGoDaddyRustProbeArtifact({ artifactPath, checksumPath }) {
  try {
    await access(artifactPath, constants.X_OK);
    const artifact = await readFile(artifactPath);
    const checksum = await readFile(checksumPath, "utf8");
    const match = CHECKSUM_PATTERN.exec(checksum);
    if (match === null || artifact.byteLength === 0 || !(await stat(artifactPath)).isFile()) return false;
    return createHash("sha256").update(artifact).digest("hex") === match[1];
  } catch {
    return false;
  }
}

const isDirectExecution = () => {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href;
};

if (isDirectExecution()) {
  const artifactPath = process.argv[2];
  const checksumPath = process.argv[3];
  const verified = typeof artifactPath === "string" && typeof checksumPath === "string"
    && await verifyGoDaddyRustProbeArtifact({ artifactPath, checksumPath });
  process.stdout.write(`${verified ? "verified" : "invalid"}\n`);
  process.exitCode = verified ? 0 : 1;
}
