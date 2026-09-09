import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { getCACertificates } from "node:tls";

const CA_BUNDLE_NAME = "node-default-ca.pem";
const MAX_CERTIFICATES = 512;
const MAX_CERTIFICATE_BYTES = 64 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

function normalizedCertificate(value: string): string | undefined {
  const normalized = value.replaceAll("\r\n", "\n").trimEnd();
  if (
    normalized.length === 0
    || normalized.includes("\0")
    || Buffer.byteLength(normalized, "utf8") > MAX_CERTIFICATE_BYTES
    || !normalized.startsWith("-----BEGIN CERTIFICATE-----\n")
    || !normalized.endsWith("\n-----END CERTIFICATE-----")
  ) return undefined;
  return `${normalized}\n`;
}

/**
 * Give the static Rust/OpenSSL child the same public CA trust roots already
 * used by Node's successful verified MySQL connection. The bundle is private,
 * process-local and deleted with its owning temporary directory.
 */
export async function writeNodeDefaultCaBundle(
  directory: string,
  certificates: readonly string[] = getCACertificates("default")
): Promise<string> {
  if (!isAbsolute(directory) || resolve(directory) !== directory || directory === "/") {
    throw new Error("matrix_setup_tls_roots_unavailable");
  }
  const directoryStat = await lstat(directory);
  const uid = typeof process.geteuid === "function" ? process.geteuid() : directoryStat.uid;
  if (
    !directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || directoryStat.uid !== uid
    || (directoryStat.mode & 0o7777) !== 0o700
    || await realpath(directory) !== directory
    || certificates.length === 0
    || certificates.length > MAX_CERTIFICATES
  ) throw new Error("matrix_setup_tls_roots_unavailable");

  const normalized = certificates.map(normalizedCertificate);
  if (normalized.some((certificate) => certificate === undefined)) {
    throw new Error("matrix_setup_tls_roots_unavailable");
  }
  const bundle = [...new Set(normalized as string[])].join("");
  if (Buffer.byteLength(bundle, "utf8") > MAX_BUNDLE_BYTES) {
    throw new Error("matrix_setup_tls_roots_unavailable");
  }

  const path = join(directory, CA_BUNDLE_NAME);
  let created = false;
  try {
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    created = true;
    try {
      await handle.writeFile(bundle, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const stat = await lstat(path);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.uid !== uid
      || stat.nlink !== 1
      || (stat.mode & 0o7777) !== 0o600
      || stat.size !== Buffer.byteLength(bundle, "utf8")
      || await realpath(path) !== path
    ) throw new Error("matrix_setup_tls_roots_unavailable");
    return path;
  } catch {
    if (created) await unlink(path).catch(() => undefined);
    throw new Error("matrix_setup_tls_roots_unavailable");
  }
}

