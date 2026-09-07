import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APPLICATION_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PATHS = [
  ["application", []],
  ["public", ["public"]],
  ["assets", ["public", "assets"]],
  ["privateRoot", ["public", "assets", ".personal-consultant-matrix-v1"]],
  ["cryptoStore", ["public", "assets", ".personal-consultant-matrix-v1", "crypto-store"]],
  ["deviceBinding", ["public", "assets", ".personal-consultant-matrix-v1", "crypto-store", "device-binding.json"]]
] as const;
export type MatrixStoragePathState = "directory" | "file" | "symlink" | "other" | "missing" | "denied" | "unavailable" | "not_checked";
export type MatrixStoragePaths = Readonly<Record<typeof PATHS[number][0], MatrixStoragePathState>>;
type PathStat = Readonly<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;

/** Owner-only diagnostic caller. Fixed paths, metadata only, no directory listing,
 * content reads, writes, symlink traversal, provisioning or readiness changes. */
export async function inspectMatrixStoragePaths(dependencies: Readonly<{
  stat?: (path: string) => Promise<PathStat>;
}> = {}): Promise<MatrixStoragePaths> {
  const stat = dependencies.stat ?? lstat;
  const result = {} as Record<typeof PATHS[number][0], MatrixStoragePathState>;
  let parentIsDirectory = true;
  for (const [label, parts] of PATHS) {
    if (!parentIsDirectory) { result[label] = "not_checked"; continue; }
    try {
      const value = await stat(resolve(APPLICATION_ROOT, ...parts));
      result[label] = value.isSymbolicLink() ? "symlink" : value.isDirectory() ? "directory" : value.isFile() ? "file" : "other";
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      result[label] = code === "ENOENT" || code === "ENOTDIR" ? "missing"
        : code === "EACCES" || code === "EPERM" ? "denied" : "unavailable";
    }
    parentIsDirectory = result[label] === "directory";
  }
  return Object.freeze(result);
}
