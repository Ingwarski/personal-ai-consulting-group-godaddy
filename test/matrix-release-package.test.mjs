import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { assertReproducible, assertStaticStrippedElf, createDependencyEvidence, extractPinnedHeaders, matrixReleaseSourceMounts, sha256, validateBuilder, validateRun } from "../scripts/matrix-release-package.mjs";

const builder = JSON.parse(readFileSync(new URL("../scripts/matrix-release-builder.json", import.meta.url), "utf8"));
const commit = "a".repeat(40);
const run = {
  GITHUB_ACTIONS: "true", GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "Ingwarski/personal-ai-consulting-group-godaddy", GITHUB_SHA: commit,
  GITHUB_WORKFLOW_SHA: commit,
  GITHUB_WORKFLOW_REF: "Ingwarski/personal-ai-consulting-group-godaddy/.github/workflows/matrix-sidecar-release.yml@refs/heads/codex/test",
  GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1"
};
function elf({ interpreter = false, needed = false, symbols = false } = {}) {
  const bytes = Buffer.alloc(256);
  Buffer.from([0x7f, 69, 76, 70, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(interpreter ? 3 : needed ? 2 : 1, 64);
  if (needed) {
    bytes.writeBigUInt64LE(128n, 72);
    bytes.writeBigUInt64LE(32n, 96);
    bytes.writeBigInt64LE(1n, 128);
  }
  if (symbols) {
    bytes.writeBigUInt64LE(192n, 40);
    bytes.writeUInt16LE(64, 58);
    bytes.writeUInt16LE(1, 60);
    bytes.writeUInt32LE(2, 196);
  }
  return bytes;
}
const crate = (name, version, license = "MIT OR Apache-2.0") => ({
  id: `${name}@${version}`, name, version, license,
  source: name === builder.binaryName ? null : "registry+https://github.com/rust-lang/crates.io-index"
});
function metadata() {
  const packages = [crate(builder.binaryName, "0.1.0", "LicenseRef-Proprietary"), crate("runtime", "1.0.0"), crate("build-helper", "2.0.0"), crate("test-helper", "3.0.0"), crate("transitive", "4.0.0", null)];
  const dependency = (index, kind) => ({ pkg: packages[index].id, dep_kinds: [{ kind }] });
  return { version: 1, packages, resolve: { root: packages[0].id, nodes: [
    { id: packages[0].id, deps: [dependency(1, null), dependency(2, "build"), dependency(3, "dev")] },
    { id: packages[1].id, deps: [dependency(4, null)] },
    ...packages.slice(2).map(({ id }) => ({ id, deps: [] }))
  ] } };
}

test("release builder pins the platform manifest and exact toolchain", () => {
  assert.equal(validateBuilder(builder), builder);
  for (const changed of [
    { image: "rust:1.93.0-alpine3.23" }, { imageConfigDigest: "sha256:latest" },
    { target: "x86_64-unknown-linux-gnu" }, { rustToolchain: "stable" },
    { platform: "linux/arm64" }, { protocolVersion: 2 }, { setupBinaryName: "other" }
  ]) assert.throws(() => validateBuilder({ ...builder, ...changed }));
});

test("release provenance binds the authenticated workflow run to its exact checkout", () => {
  assert.equal(validateRun(run, commit).commit, commit);
  for (const changed of [
    { GITHUB_ACTIONS: "false" }, { GITHUB_WORKFLOW_SHA: "b".repeat(40) },
    { GITHUB_REPOSITORY: "another/repository" }, { GITHUB_RUN_ATTEMPT: "0" },
    { GITHUB_WORKFLOW_REF: run.GITHUB_WORKFLOW_REF.replace("-release", "") },
    { GITHUB_SERVER_URL: "https://example.invalid" }
  ]) assert.throws(() => validateRun({ ...run, ...changed }, commit));
  assert.throws(() => validateRun(run, "b".repeat(40)));
});

test("ELF verification accepts static stripped x86_64 including static PIE", () => {
  assert.doesNotThrow(() => assertStaticStrippedElf(elf()));
  const staticExecutable = elf();
  staticExecutable.writeUInt16LE(2, 16);
  assert.doesNotThrow(() => assertStaticStrippedElf(staticExecutable));
});

test("ELF verification rejects dynamic interpreter, DT_NEEDED and symbol tables", () => {
  for (const variant of [{ interpreter: true }, { needed: true }, { symbols: true }]) {
    assert.throws(() => assertStaticStrippedElf(elf(variant)));
  }
});

test("ELF verification rejects wrong architecture, malformed bounds and verification text artifacts", () => {
  const architecture = elf(); architecture.writeUInt16LE(183, 18);
  const bounds = elf(); bounds.writeBigUInt64LE(2n ** 63n, 32);
  const tables = elf(); tables.writeUInt16LE(0, 56);
  for (const bytes of [architecture, bounds, tables, Buffer.from("NON-DEPLOYABLE VERIFICATION EVIDENCE")]) {
    assert.throws(() => assertStaticStrippedElf(bytes));
  }
});

test("two independently built binaries must be byte-identical, not merely valid ELF files", () => {
  assert.equal(assertReproducible(elf(), elf()), sha256(elf()));
  const changed = elf(); changed[250] = 1;
  assert.throws(() => assertReproducible(elf(), changed), /differ/);
});

test("SBOM and license inventory cover production/build closure without development-only crates", () => {
  const { sbom, licenses } = createDependencyEvidence(metadata(), builder);
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.metadata.component.name, builder.binaryName);
  assert.deepEqual(sbom.components.map(({ name }) => name).sort(), ["build-helper", "runtime", "transitive"]);
  assert.equal(licenses.packages.length, 4);
  assert.equal(licenses.packages.find(({ name }) => name === "transitive").licenseExpression, null);
  assert.equal(sbom.dependencies.find(({ ref }) => ref.includes(builder.binaryName)).dependsOn.length, 2);
  assert.equal(JSON.stringify(sbom).includes("test-helper"), false);
  assert.equal(JSON.stringify(sbom).includes("/source/"), false);
});

test("release dependency evidence fails closed on incomplete graph and unpinned path/git dependencies", () => {
  const missing = metadata(); missing.resolve.nodes.splice(1, 1);
  assert.throws(() => createDependencyEvidence(missing, builder));
  const wrongRoot = metadata(); wrongRoot.packages[0].version = "0.2.0";
  assert.throws(() => createDependencyEvidence(wrongRoot, builder));
  for (const source of [null, "git+https://example.invalid/repository#abc"]) {
    const unpinned = metadata(); unpinned.packages[1].source = source;
    assert.throws(() => createDependencyEvidence(unpinned, builder));
  }
});

test("release workflow remains separate from non-deployable verification and cannot deploy", () => {
  const release = readFileSync(new URL("../.github/workflows/matrix-sidecar-release.yml", import.meta.url), "utf8");
  const verification = readFileSync(new URL("../.github/workflows/matrix-sidecar.yml", import.meta.url), "utf8");
  assert.match(verification, /NONDEPLOYABLE-matrix-sidecar/);
  assert.match(release, /matrix-production-release-\$\{\{ github.sha \}\}/);
  assert.match(release, /overwrite: false/);
  assert.doesNotMatch(release, /secrets\.|contents: write|packages: write|deployments: write/);
  const build = readFileSync(new URL("../scripts/build-matrix-release.mjs", import.meta.url), "utf8");
  assert.match(build, /phase === "fetch" \? "bridge" : "none"/);
  assert.match(build, /container\("build", builds\[0\]\)/);
  assert.match(build, /container\("build", builds\[1\]\)/);
  assert.doesNotMatch(build, /apt-get|apk add|rustup toolchain install/);
});

test("the actual shared Rust test includes resolve inside read-only provenance-bound release mounts", () => {
  const source = readFileSync(new URL("../native/matrix-sidecar/src/client.rs", import.meta.url), "utf8");
  const includes = [...source.matchAll(/include_str!\(\s*"([^"]+)"\s*\)/g)].map(match => match[1]);
  assert.equal(includes.length, 2, "keep the regression bound to the actual native test includes");
  for (const relative of includes) {
    const target = posix.resolve("/source/src", relative);
    const mount = matrixReleaseSourceMounts.find(entry => entry.target === target);
    assert.ok(mount, `missing container source mount for ${target}`);
    const hostRelative = posix.normalize(posix.join("native/matrix-sidecar/src", relative));
    assert.equal(mount.source, hostRelative);
    assert.deepEqual(JSON.parse(readFileSync(new URL(`../${mount.source}`, import.meta.url), "utf8")),
      JSON.parse(readFileSync(new URL(`../${hostRelative}`, import.meta.url), "utf8")));
    const workflow = readFileSync(new URL("../.github/workflows/matrix-sidecar-release.yml", import.meta.url), "utf8");
    assert.ok(workflow.includes(`- "${mount.source}"`));
  }
  const build = readFileSync(new URL("../scripts/build-matrix-release.mjs", import.meta.url), "utf8");
  assert.match(build, /matrixReleaseSourceMounts\.flatMap\([\s\S]*?target=\$\{target\},readonly/);
  assert.match(build, /const sourceInputs = git\([^\n]*matrixReleaseSourceMounts\.map/);
  assert.ok(build.indexOf('container("test", builds[0])') < build.indexOf('container("build", builds[0])'));
});

test("header overlay verifies exact archive bytes and refuses path escapes, symlinks and missing entries", () => {
  function archive(name = "usr/include/linux/example.h", type = "0") {
    const tar = Buffer.alloc(1536);
    tar.write(name, 0);
    tar.write("00000000004", 124);
    tar.write(type, 156);
    tar.write("test", 512);
    return gzipSync(tar);
  }
  const bytes = archive();
  const input = (bytes) => ({ sizeBytes: bytes.length, sha256: sha256(bytes), regularHeaderFiles: 1 });
  assert.equal(extractPinnedHeaders(bytes, input(bytes))[0].bytes.toString(), "test");
  assert.throws(() => extractPinnedHeaders(bytes, { ...input(bytes), sha256: "0".repeat(64) }));
  assert.throws(() => extractPinnedHeaders(bytes, { ...input(bytes), regularHeaderFiles: 2 }));
  for (const invalid of [archive("usr/include/../../escape"), archive("usr/include/linux/example.h", "2")]) {
    assert.throws(() => extractPinnedHeaders(invalid, input(invalid)));
  }
});
