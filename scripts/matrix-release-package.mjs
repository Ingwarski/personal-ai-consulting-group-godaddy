import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateBuilder(builder) {
  if (builder.schemaVersion !== 1
    || !/^docker\.io\/library\/rust:1\.93\.0-alpine3\.23@sha256:[a-f0-9]{64}$/.test(builder.image)
    || !/^sha256:[a-f0-9]{64}$/.test(builder.imageConfigDigest)
    || builder.platform !== "linux/amd64"
    || builder.rustToolchain !== "1.93.0-x86_64-unknown-linux-musl"
    || builder.target !== "x86_64-unknown-linux-musl"
    || builder.nodeVersion !== "22.23.2"
    || builder.binaryName !== "personal-consultant-matrix-sidecar"
    || builder.setupBinaryName !== "personal-consultant-matrix-setup"
    || builder.sidecarVersion !== "0.1.0"
    || builder.protocolVersion !== 1
    || builder.systemHeaders?.url !== "https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/linux-headers-6.16.12-r0.apk"
    || !/^[a-f0-9]{64}$/.test(builder.systemHeaders.sha256)
    || builder.systemHeaders.sizeBytes !== 1706807
    || builder.systemHeaders.regularHeaderFiles !== 987) throw new Error("Invalid immutable release builder definition.");
  return builder;
}

export function extractPinnedHeaders(archive, headers) {
  if (archive.length !== headers.sizeBytes || sha256(archive) !== headers.sha256) throw new Error("Linux header archive digest/size mismatch.");
  const tar = gunzipSync(archive, { maxOutputLength: 16 * 1024 * 1024 });
  const files = [];
  const seen = new Set();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start, length) => header.toString("utf8", start, start + length).split("\0")[0];
    const name = field(0, 100);
    const octal = field(124, 12).trim();
    if (octal && !/^[0-7]+$/.test(octal)) throw new Error("Invalid header archive size.");
    const size = Number.parseInt(octal || "0", 8);
    if (offset + 512 + size > tar.length) throw new Error("Truncated header archive.");
    const type = String.fromCharCode(header[156] || 48);
    const bytes = tar.subarray(offset + 512, offset + 512 + size);
    if (type === "x") {
      // The pinned Alpine archive uses these metadata-only PAX keys. Never honor path/link overrides.
      const records = bytes.toString("utf8").split("\n").filter(Boolean);
      if (records.some((record) => !/^[0-9]+ (ctime|atime|APK-TOOLS\.checksum\.SHA1)=/.test(record))) throw new Error("Unexpected header archive path metadata.");
    } else if (name.startsWith("usr/include/") && type !== "5") {
      if (type !== "0" || field(345, 155) || !/^usr\/include\/[A-Za-z0-9_./+-]+$/.test(name)
        || name.split("/").some((part) => part === ".." || part === "." || part === "") || seen.has(name)) throw new Error("Unsafe Linux header archive entry.");
      seen.add(name);
      files.push({ path: name, bytes });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (files.length !== headers.regularHeaderFiles) throw new Error("Incomplete Linux header archive.");
  return files;
}

export function validateRun(environment, actualCommit) {
  const { GITHUB_ACTIONS, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT, GITHUB_WORKFLOW_SHA, GITHUB_WORKFLOW_REF, GITHUB_SERVER_URL } = environment;
  if (GITHUB_ACTIONS !== "true" || GITHUB_SERVER_URL !== "https://github.com"
    || GITHUB_REPOSITORY !== "Ingwarski/personal-ai-consulting-group-godaddy"
    || !/^[a-f0-9]{40}$/.test(GITHUB_SHA ?? "") || GITHUB_SHA !== actualCommit
    || GITHUB_WORKFLOW_SHA !== GITHUB_SHA
    || !/^[1-9][0-9]*$/.test(GITHUB_RUN_ID ?? "") || !/^[1-9][0-9]*$/.test(GITHUB_RUN_ATTEMPT ?? "")
    || !GITHUB_WORKFLOW_REF?.startsWith(`${GITHUB_REPOSITORY}/.github/workflows/matrix-sidecar-release.yml@refs/`)) {
    throw new Error("Release packaging requires an exact-source GitHub Actions run of its own workflow.");
  }
  return {
    repository: GITHUB_REPOSITORY,
    commit: GITHUB_SHA,
    workflowCommit: GITHUB_WORKFLOW_SHA,
    workflowRef: GITHUB_WORKFLOW_REF,
    runId: GITHUB_RUN_ID,
    runAttempt: GITHUB_RUN_ATTEMPT,
    runUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}`
  };
}

export function assertStaticStrippedElf(bytes) {
  const reject = () => { throw new Error("Expected a stripped, static Linux x86_64 ELF with no interpreter or dynamic library dependency."); };
  if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70]))
    || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1
    || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== 62) reject();
  const boundedOffset = (offset, length) => {
    if (offset > BigInt(Number.MAX_SAFE_INTEGER) || offset < 0 || offset + BigInt(length) > BigInt(bytes.length)) reject();
    return Number(offset);
  };
  const phSize = bytes.readUInt16LE(54);
  const phCount = bytes.readUInt16LE(56);
  if (phSize !== 56 || phCount === 0 || phCount === 0xffff) reject();
  const phOffset = boundedOffset(bytes.readBigUInt64LE(32), phSize * phCount);
  for (let index = 0; index < phCount; index++) {
    const start = phOffset + index * phSize;
    const type = bytes.readUInt32LE(start);
    if (type === 3) reject(); // PT_INTERP
    if (type === 2) { // PT_DYNAMIC is allowed for static PIE, but DT_NEEDED is not.
      const size = bytes.readBigUInt64LE(start + 32);
      if (size > BigInt(bytes.length) || size % 16n !== 0n) reject();
      const offset = boundedOffset(bytes.readBigUInt64LE(start + 8), Number(size));
      for (let entry = offset; entry < offset + Number(size); entry += 16) {
        const tag = bytes.readBigInt64LE(entry);
        if (tag === 0n) break;
        if (tag === 1n) reject();
      }
    }
  }
  const shCount = bytes.readUInt16LE(60);
  if (shCount > 0) {
    const shSize = bytes.readUInt16LE(58);
    if (shSize !== 64 || shCount === 0xffff) reject();
    const shOffset = boundedOffset(bytes.readBigUInt64LE(40), shSize * shCount);
    for (let index = 0; index < shCount; index++) {
      if (bytes.readUInt32LE(shOffset + index * shSize + 4) === 2) reject(); // SHT_SYMTAB
    }
  }
}

export function assertReproducible(first, second) {
  assertStaticStrippedElf(first);
  assertStaticStrippedElf(second);
  if (!first.equals(second)) throw new Error("Independent clean release builds differ; promotion is blocked.");
  return sha256(first);
}

export function createDependencyEvidence(metadata, builder) {
  if (metadata.version !== 1 || !metadata.resolve?.root) throw new Error("Missing resolved Cargo metadata.");
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const rootId = metadata.resolve.root;
  const root = packages.get(rootId);
  if (root?.name !== builder.binaryName || root.version !== builder.sidecarVersion || root.source != null) {
    throw new Error("Cargo metadata does not describe the exact sidecar application.");
  }
  const included = new Set();
  const dependencies = new Map();
  function visit(id) {
    if (included.has(id)) return;
    const pkg = packages.get(id);
    const node = nodes.get(id);
    if (!pkg || !node) throw new Error("Incomplete Cargo dependency graph.");
    if (id !== rootId && !pkg.source?.startsWith("registry+https://github.com/rust-lang/crates.io-index")) {
      throw new Error("Unpinned non-registry production dependency.");
    }
    included.add(id);
    const production = node.deps.filter((dependency) => dependency.dep_kinds.some(({ kind }) => kind == null || kind === "build"));
    dependencies.set(id, production.map((dependency) => dependency.pkg));
    for (const dependency of production) visit(dependency.pkg);
  }
  visit(rootId);
  const purl = (pkg) => `pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`;
  const sorted = [...included].map((id) => packages.get(id)).sort((a, b) => purl(a).localeCompare(purl(b), "en"));
  const component = (pkg) => ({
    type: pkg.id === rootId ? "application" : "library", "bom-ref": purl(pkg), name: pkg.name,
    version: pkg.version, purl: purl(pkg), scope: "required",
    ...(pkg.license ? { licenses: [{ expression: pkg.license }] } : {}),
    properties: [{ name: "cargo:scope", value: "production-or-build" }]
  });
  return {
    sbom: {
      bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
      metadata: { component: component(root) },
      components: sorted.filter((pkg) => pkg.id !== rootId).map(component),
      dependencies: sorted.map((pkg) => ({ ref: purl(pkg), dependsOn: [...new Set(dependencies.get(pkg.id).map((id) => purl(packages.get(id))))].sort() }))
    },
    licenses: {
      schemaVersion: 1, target: builder.target,
      scope: "Resolved production and build dependency closure; development-only dependencies are excluded. License expressions are package declarations, not a legal compliance certification.",
      packages: sorted.map((pkg) => ({ name: pkg.name, version: pkg.version, purl: purl(pkg),
        licenseExpression: pkg.license ?? null,
        licenseFileDeclared: Boolean(pkg.license_file),
        source: pkg.id === rootId ? "application-source" : pkg.source }))
    }
  };
}
