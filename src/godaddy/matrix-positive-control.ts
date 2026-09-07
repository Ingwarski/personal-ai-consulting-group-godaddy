import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { securityHeaders } from "../http/security-headers.ts";

const applicationRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const same = (a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
type ControlResult = "invalid_request" | "invalid_root" | "missing_directory" | "unsafe_directory"
  | "missing_file" | "unsafe_file" | "expired_file" | "changed_file" | "invalid_marker" | "unavailable" | "ok";
class ControlFailure extends Error {
  readonly result: ControlResult;
  constructor(result: ControlResult) { super(result); this.result = result; }
}

/** Serves only a fresh, harmless test marker. This is NOT a static-file server. */
export async function matrixPositiveControlResponse(request: Request, root = applicationRoot): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!/^\/assets\/matrix-isolation-positive-[a-f0-9]{32}\.txt$/u.test(url.pathname)) return undefined;
  const reply = (body: string, status: number, result: ControlResult): Response => new Response(body,
    { status, headers: securityHeaders({ "content-type": "text/plain; charset=utf-8", "x-matrix-control-result": result }) });
  const denied = (result: ControlResult): Response => reply("Not found.", 404, result);
  if (request.method !== "GET" || url.search) return reply("Invalid control request.", 400, "invalid_request");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const uid = process.getuid?.();
    if (uid === undefined || !root.startsWith("/") || resolve(root) !== root || root === "/") return denied("invalid_root");
    const parent = join(root, "public", "assets");
    const ancestors = [root, join(root, "public"), parent];
    const snapshots = await Promise.all(ancestors.map(async path => {
      const stat = await lstat(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ControlFailure("missing_directory");
        throw error;
      });
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7022) !== 0
        || await realpath(path) !== path) throw new ControlFailure("unsafe_directory");
      return stat;
    }));
    const revalidateAncestors = async (): Promise<void> => {
      for (const [index, ancestor] of ancestors.entries()) {
        if (!same(snapshots[index]!, await lstat(ancestor)) || await realpath(ancestor) !== ancestor) {
          throw new ControlFailure("unsafe_directory");
        }
      }
    };
    const path = join(parent, url.pathname.slice("/assets/".length));
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(async error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // ENOENT can also mean a parent disappeared or was replaced mid-check.
        await revalidateAncestors();
        throw new ControlFailure("missing_file");
      }
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new ControlFailure("unsafe_file");
      throw error;
    });
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || ![0o600, 0o644].includes(before.mode & 0o7777)
      || before.size < 1 || before.size > 128) return denied("unsafe_file");
    if (before.mtimeMs > Date.now() || Date.now() - before.mtimeMs > 180_000) return denied("expired_file");
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const after = await handle.stat();
    const current = await lstat(path);
    if (!same(before, after) || !same(before, current) || before.size !== after.size || before.size !== current.size
      || before.mtimeMs !== after.mtimeMs || before.mtimeMs !== current.mtimeMs
      || before.ctimeMs !== after.ctimeMs || before.ctimeMs !== current.ctimeMs
      || bytesRead !== before.size) return denied("changed_file");
    if (!/^matrix-isolation-positive:[a-f0-9]{32}$/u.test(text)) return denied("invalid_marker");
    await revalidateAncestors();
    return reply(text, 200, "ok");
  } catch (error) { return denied(error instanceof ControlFailure ? error.result : "unavailable"); }
  finally { await handle?.close(); }
}
