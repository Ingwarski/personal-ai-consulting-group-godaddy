import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReproducible, createDependencyEvidence, extractPinnedHeaders, matrixReleaseSourceMounts, sha256, validateBuilder, validateRun } from "./matrix-release-package.mjs";

// This is an offline binary builder, never a GoDaddy runtime installer.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builder = validateBuilder(JSON.parse(readFileSync(join(root, "scripts/matrix-release-builder.json"), "utf8")));
if (process.versions.node !== builder.nodeVersion) throw new Error("Use the exact Node version pinned for release packaging.");

function execute(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return capture ? result.stdout.trimEnd() : undefined;
}
const git = (...args) => execute("git", args, true);
const run = validateRun(process.env, git("rev-parse", "HEAD"));
const assertUnchanged = () => {
  if (git("status", "--porcelain", "--untracked-files=no")) throw new Error("Release source has tracked working-tree changes.");
  if (git("rev-parse", "HEAD") !== run.commit) throw new Error("Source commit changed during the release build.");
};
assertUnchanged();
for (const mount of matrixReleaseSourceMounts) {
  const source = lstatSync(join(root, mount.source));
  if (source.isSymbolicLink() || (!source.isFile() && !source.isDirectory())) throw new Error("Release source mount is missing or unsafe.");
}
const outputDirectory = join(root, "dist/matrix-release");
if (existsSync(outputDirectory)) throw new Error("Release output directory already exists; use a fresh checkout.");
const scratch = mkdtempSync(join(tmpdir(), "matrix-release-build-"));
const cache = join(scratch, "cargo-cache");
const headersDirectory = join(scratch, "system-headers");
const builds = [join(scratch, "first"), join(scratch, "second")];
for (const directory of [cache, headersDirectory, ...builds]) mkdirSync(directory, { mode: 0o700 });
const sourceEpoch = git("show", "-s", "--format=%ct", "HEAD");
if (!/^[0-9]+$/.test(sourceEpoch)) throw new Error("Invalid source commit timestamp.");
const startedAt = new Date().toISOString();

const headerResponse = await fetch(builder.systemHeaders.url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
if (!headerResponse.ok) throw new Error("Cannot fetch the pinned Linux UAPI header input.");
const headerArchive = Buffer.from(await headerResponse.arrayBuffer());
for (const header of extractPinnedHeaders(headerArchive, builder.systemHeaders)) {
  const destination = join(headersDirectory, header.path);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, header.bytes, { mode: 0o400, flag: "wx" });
}

execute("docker", ["pull", "--platform", builder.platform, builder.image]);
const image = JSON.parse(execute("docker", ["image", "inspect", builder.image], true))[0];
if (image.Id !== builder.imageConfigDigest || image.Os !== "linux" || image.Architecture !== "amd64") {
  throw new Error("Pulled release image identity/platform does not match the approved immutable builder.");
}

// SQLx's compatibility TLS backend is statically linked from vendored OpenSSL.
// Prepare one run-local image from the digest-pinned Rust base with only the
// exact build tools OpenSSL requires, then run both clean builds offline in the
// same immutable image identity.
const releaseImageTag = `matrix-native-tls-builder:${run.commit.slice(0, 12)}-${run.runId}-${run.runAttempt}`;
const releaseDockerfile = join(scratch, "Dockerfile.native-tls");
const buildPackages = builder.nativeTlsBuildPackages.map(({ name, version }) => `${name}=${version}`);
const releaseDockerfileBytes = `FROM ${builder.image}\nRUN apk add --no-cache ${buildPackages.join(" ")}\n`;
writeFileSync(releaseDockerfile, releaseDockerfileBytes, { mode: 0o400, flag: "wx" });
execute("docker", ["build", "--platform", builder.platform, "--pull=false", "--network=bridge", "--no-cache",
  "--tag", releaseImageTag, "--file", releaseDockerfile, scratch]);
const releaseImage = JSON.parse(execute("docker", ["image", "inspect", releaseImageTag], true))[0];
if (!/^sha256:[a-f0-9]{64}$/.test(releaseImage.Id) || releaseImage.Os !== "linux" || releaseImage.Architecture !== "amd64") {
  throw new Error("Prepared native TLS release image has the wrong identity/platform.");
}

function container(phase, buildDirectory) {
  execute("docker", [
    "run", "--rm", "--platform", builder.platform, "--pull", "never",
    "--network", phase === "fetch" ? "bridge" : "none",
    "--user", `${process.getuid()}:${process.getgid()}`, "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g",
    ...matrixReleaseSourceMounts.flatMap(({ source, target }) => ["--mount", `type=bind,source=${join(root, source)},target=${target},readonly`]),
    "--mount", `type=bind,source=${join(root, "scripts/matrix-release-container.sh")},target=/release-build.sh,readonly`,
    "--mount", `type=bind,source=${cache},target=/cache`,
    "--mount", `type=bind,source=${buildDirectory},target=/build`,
    "--mount", `type=bind,source=${headersDirectory},target=/headers,readonly`,
    "--workdir", "/source",
    "--env", "CARGO_HOME=/cache", "--env", "CARGO_TARGET_DIR=/build/target",
    "--env", `RUSTUP_TOOLCHAIN=${builder.rustToolchain}`, "--env", "CARGO_INCREMENTAL=0",
    "--env", "CARGO_BUILD_JOBS=2", "--env", "CARGO_PROFILE_TEST_DEBUG=0", "--env", "CARGO_PROFILE_DEV_DEBUG=0",
    "--env", "CFLAGS=-I/headers/usr/include", "--env", "CXXFLAGS=-I/headers/usr/include",
    "--env", `SOURCE_DATE_EPOCH=${sourceEpoch}`, "--env", "TZ=UTC", "--env", "LC_ALL=C",
    "--env", "RUSTFLAGS=-C target-feature=+crt-static --remap-path-prefix=/source=/workspace/native/matrix-sidecar --remap-path-prefix=/build=/workspace/build --remap-path-prefix=/cache=/workspace/cargo",
    releaseImage.Id, "/bin/sh", "/release-build.sh", phase
  ]);
}
container("fetch", builds[0]);
// Fail on test/source problems before spending time on two optimized builds.
container("test", builds[0]);
container("build", builds[0]);
container("build", builds[1]);
const subjects = [
  { path: builder.binaryName, role: "sidecar" },
  { path: builder.setupBinaryName, role: "setup" }
].map(({ path, role }) => {
  const artifactPath = (directory) => join(directory, "target", builder.target, "release", path);
  const first = readFileSync(artifactPath(builds[0]));
  const second = readFileSync(artifactPath(builds[1]));
  return { path, role, sha256: assertReproducible(first, second), sizeBytes: first.length, originalPath: artifactPath(builds[0]) };
});
assertUnchanged();

const metadata = JSON.parse(readFileSync(join(builds[0], "cargo-metadata.json"), "utf8"));
const { sbom, licenses } = createDependencyEvidence(metadata, builder);
licenses.buildSystemInputs = [
  { name: "linux-headers", version: "6.16.12-r0", ...builder.systemHeaders },
  ...builder.nativeTlsBuildPackages
];
const sourceInputs = git("ls-files", "-z", "--", ...matrixReleaseSourceMounts.map(({ source }) => source), ".github/workflows/matrix-sidecar-release.yml", "scripts/matrix-release-builder.json", "scripts/matrix-release-container.sh", "scripts/matrix-release-package.mjs", "scripts/build-matrix-release.mjs", "test/matrix-release-package.test.mjs")
  .split("\0").filter(Boolean).sort().map((path) => ({ path, sha256: sha256(readFileSync(join(root, path))) }));
const completedAt = new Date().toISOString();
const provenance = {
  schemaVersion: 1,
  kind: "matrix-production-build-provenance",
  source: { ...run, nativeTree: git("rev-parse", "HEAD:native/matrix-sidecar"), inputs: sourceInputs },
  builder: {
    ...builder,
    observedImageConfigDigest: image.Id,
    preparedImageConfigDigest: releaseImage.Id,
    nativeTlsDockerfileSha256: sha256(releaseDockerfileBytes)
  },
  build: {
    startedAt, completedAt, sourceDateEpoch: sourceEpoch, command: "cargo build --release --locked --frozen --target x86_64-unknown-linux-musl",
    networkDuringCompilation: "none", cleanBuildCount: 2, binaryByteEquality: "passed",
    staticStrippedElfCheck: "passed", credentialFreeMuslTests: "passed",
    sourceMountedReadOnly: true, sharedCompiledObjectCache: false,
    dependencyAcquisition: "cargo fetch --locked in the same pinned image and exact-hash UAPI archive acquisition before network-disabled builds"
  },
  subjects: subjects.map(({ originalPath, ...subject }) => subject),
  trust: {
    kind: "GitHub Actions source-bound provenance record; not a signed attestation",
    verifyAgainst: "Authenticate to GitHub, verify this exact repository/workflow/commit/run attempt succeeded, compare the immutable artifact digest from that run, then independently pin release-manifest.json SHA-256 before installation.",
    publication: "This workflow performs no deployment. Real-host path/permissions/readiness and explicit promotion authority remain separate gates."
  }
};

mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const artifacts = [];
function emit(path, data, role = "evidence") {
  const bytes = typeof data === "string" || Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(join(outputDirectory, path), bytes, { mode: role === "evidence" ? 0o600 : 0o755, flag: "wx" });
  artifacts.push({ path, role, sha256: sha256(bytes), sizeBytes: Buffer.byteLength(bytes) });
}
for (const subject of subjects) {
  copyFileSync(subject.originalPath, join(outputDirectory, subject.path));
  chmodSync(join(outputDirectory, subject.path), 0o755);
  const { originalPath, ...record } = subject;
  artifacts.push(record);
}
emit("personal-consultant-matrix-sidecar.cdx.json", sbom);
emit("licenses.json", licenses);
emit("rustc.txt", readFileSync(join(builds[0], "rustc.txt")));
emit("cc.txt", readFileSync(join(builds[0], "cc.txt")));
emit("build-provenance.json", provenance);
emit("RELEASE_CANDIDATE.txt", "Production-build candidate from two independent locked offline builds. Not deployment or product acceptance proof. Preserve the manifest, source/run provenance and GitHub artifact digest; verify final paths before credentials.\n");
const manifest = {
  schemaVersion: 1, kind: "matrix-production-release", sourceCommit: run.commit,
  sidecarVersion: builder.sidecarVersion, protocolVersion: builder.protocolVersion,
  builder: { image: builder.image, imageConfigDigest: builder.imageConfigDigest, platform: builder.platform,
    rustToolchain: builder.rustToolchain, target: builder.target, systemHeaders: builder.systemHeaders,
    nativeTlsBuildPackages: builder.nativeTlsBuildPackages, preparedImageConfigDigest: releaseImage.Id,
    nativeTlsDockerfileSha256: sha256(releaseDockerfileBytes) },
  artifacts: [...artifacts].sort((a, b) => a.path.localeCompare(b.path, "en"))
};
emit("release-manifest.json", manifest);
writeFileSync(join(outputDirectory, "SHA256SUMS"), artifacts.map(({ path, sha256: hash }) => `${hash}  ${path}\n`).sort().join(""), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ output: "dist/matrix-release", sourceCommit: run.commit,
  manifestSHA256: artifacts.find(({ path }) => path === "release-manifest.json").sha256,
  binaries: subjects.map(({ originalPath, ...subject }) => subject) }, null, 2));
