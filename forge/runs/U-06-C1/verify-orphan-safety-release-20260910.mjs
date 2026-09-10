// Operator verification for this exact release; never executes downloaded programs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertStaticStrippedElf, matrixReleaseSourceMounts, sha256 } from "../../../scripts/matrix-release-package.mjs";

const repository = "Ingwarski/personal-ai-consulting-group-godaddy";
const commit = "9d362d0c990893ce0ef7f84b468bc73d150bba6d";
const runId = 34521582640;
const artifactId = 10173795555;
const archiveDigest = "251cee197a83817b478a991d57e3f6424cc95c0634d1787b02d905bbecec7501";
const root = process.cwd();
const execute = (command, args, limit = 64 * 1024 * 1024) => {
  const result = spawnSync(command, args, { cwd: root, maxBuffer: limit, timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} verification command failed`);
  return result.stdout;
};
const api = (path) => JSON.parse(execute("gh", ["api", `repos/${repository}/${path}`]));
const git = (...args) => execute("git", args);

const run = api(`actions/runs/${runId}`);
assert.equal(run.status, "completed");
assert.equal(run.conclusion, "success");
assert.equal(run.head_sha, commit);
assert.equal(run.run_attempt, 1);
assert.equal(run.repository.full_name, repository);
assert.equal(run.head_repository.full_name, repository);
assert.equal(run.path, ".github/workflows/matrix-sidecar-release.yml");

const artifacts = api(`actions/runs/${runId}/artifacts`).artifacts;
assert.equal(artifacts.length, 1);
const artifact = artifacts[0];
assert.equal(artifact.id, artifactId);
assert.equal(artifact.expired, false);
assert.equal(artifact.name, `matrix-production-release-${commit}-${runId}-1`);
assert.equal(artifact.digest, `sha256:${archiveDigest}`);
assert.equal(artifact.workflow_run.id, runId);
assert.equal(artifact.workflow_run.head_sha, commit);

const archive = execute("gh", ["api", `repos/${repository}/actions/artifacts/${artifactId}/zip`]);
assert.equal(archive.length, artifact.size_in_bytes);
assert.equal(sha256(archive), archiveDigest);
const scratch = mkdtempSync(join(tmpdir(), "matrix-orphan-safety-release-verified-"));
const zip = join(scratch, "release.zip");
writeFileSync(zip, archive, { flag: "wx", mode: 0o600 });

const names = execute("unzip", ["-Z1", zip]).toString("utf8").trim().split("\n");
const expectedNames = ["personal-consultant-matrix-sidecar", "personal-consultant-matrix-setup",
  "personal-consultant-matrix-sidecar.cdx.json", "licenses.json", "rustc.txt", "cc.txt",
  "build-provenance.json", "RELEASE_CANDIDATE.txt", "release-manifest.json", "SHA256SUMS"].sort();
assert.deepEqual(names.toSorted(), expectedNames);
const files = new Map(names.map((name) => [name, execute("unzip", ["-p", zip, name])]));
const manifestBytes = files.get("release-manifest.json");
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.kind, "matrix-production-release");
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.sourceCommit, commit);
assert.equal(manifest.protocolVersion, 1);
assert.equal(manifest.sidecarVersion, "0.1.0");
assert.deepEqual(manifest.artifacts.map(({ path }) => path).sort(),
  expectedNames.filter((name) => !["release-manifest.json", "SHA256SUMS"].includes(name)));
for (const entry of manifest.artifacts) {
  const bytes = files.get(entry.path);
  assert.equal(bytes.length, entry.sizeBytes);
  assert.equal(sha256(bytes), entry.sha256);
  if (["sidecar", "setup"].includes(entry.role)) {
    assertStaticStrippedElf(bytes);
    assert(bytes.length < 100 * 1024 * 1024, "Binary exceeds GitHub regular Git file limit");
  } else {
    assert.equal(entry.role, "evidence");
  }
}

const sums = files.get("SHA256SUMS").toString("utf8").trim().split("\n");
assert.equal(sums.length, files.size - 1);
assert.deepEqual(sums.toSorted(), [...files].filter(([name]) => name !== "SHA256SUMS")
  .map(([name, bytes]) => `${sha256(bytes)}  ${name}`).sort());

const provenance = JSON.parse(files.get("build-provenance.json"));
const builder = JSON.parse(git("show", `${commit}:scripts/matrix-release-builder.json`));
assert.deepEqual(provenance.builder.observedImageConfigDigest, builder.imageConfigDigest);
for (const [key, value] of Object.entries(builder)) assert.deepEqual(provenance.builder[key], value);
assert.match(provenance.builder.preparedImageConfigDigest, /^sha256:[a-f0-9]{64}$/u);
const dockerfileBytes = `FROM ${builder.image}\nRUN apk add --no-cache ${builder.nativeTlsBuildPackages
  .map(({ name, version }) => `${name}=${version}`).join(" ")}\n`;
assert.equal(provenance.builder.nativeTlsDockerfileSha256, sha256(dockerfileBytes));
assert.equal(manifest.builder.preparedImageConfigDigest, provenance.builder.preparedImageConfigDigest);
assert.equal(manifest.builder.nativeTlsDockerfileSha256, provenance.builder.nativeTlsDockerfileSha256);
for (const key of ["image", "imageConfigDigest", "platform", "rustToolchain", "target", "systemHeaders"]) {
  assert.deepEqual(manifest.builder[key], builder[key]);
}
assert.equal(provenance.source.repository, repository);
assert.equal(provenance.source.commit, commit);
assert.equal(provenance.source.workflowCommit, commit);
assert.equal(provenance.source.workflowRef, `${repository}/${run.path}@refs/heads/${run.head_branch}`);
assert.equal(provenance.source.runId, String(runId));
assert.equal(provenance.source.runAttempt, "1");
assert.equal(provenance.source.nativeTree, git("rev-parse", `${commit}:native/matrix-sidecar`).toString().trim());
assert.equal(provenance.build.cleanBuildCount, 2);
for (const key of ["binaryByteEquality", "staticStrippedElfCheck", "credentialFreeMuslTests"]) {
  assert.equal(provenance.build[key], "passed");
}
assert.equal(provenance.build.networkDuringCompilation, "none");
assert.equal(provenance.build.sharedCompiledObjectCache, false);

const sourcePaths = git("ls-tree", "-r", "--name-only", commit, "--", ...matrixReleaseSourceMounts.map(({ source }) => source),
  ".github/workflows/matrix-sidecar-release.yml", "scripts/matrix-release-builder.json", "scripts/matrix-release-container.sh",
  "scripts/matrix-release-package.mjs", "scripts/build-matrix-release.mjs", "test/matrix-release-package.test.mjs")
  .toString().trim().split("\n").sort();
assert.deepEqual(provenance.source.inputs.map(({ path }) => path).sort(), sourcePaths);
for (const entry of provenance.source.inputs) {
  assert.equal(sha256(git("show", `${commit}:${entry.path}`)), entry.sha256);
  assert.equal(sha256(readFileSync(join(root, entry.path))), entry.sha256, `Current source differs: ${entry.path}`);
}
const byRole = (a, b) => a.role.localeCompare(b.role);
assert.deepEqual(provenance.subjects.toSorted(byRole),
  manifest.artifacts.filter(({ role }) => ["sidecar", "setup"].includes(role)).sort(byRole));

const stage = join(scratch, "matrix");
mkdirSync(stage, { mode: 0o700 });
for (const [name, bytes] of files) writeFileSync(join(stage, name), bytes, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({
  verifiedAt: new Date().toISOString(), runId, runAttempt: 1, sourceCommit: commit,
  artifactId, archiveSha256: archiveDigest, archiveSizeBytes: archive.length,
  fileCount: files.size, manifestSha256: sha256(manifestBytes), verifiedSourceInputCount: sourcePaths.length,
  binaries: provenance.subjects, preparedBuilderImage: provenance.builder.preparedImageConfigDigest,
  result: "passed", stagedBundle: stage,
  limitation: "Source-bound GitHub build evidence; not real-host execution or Matrix authentication proof."
}, null, 2));
