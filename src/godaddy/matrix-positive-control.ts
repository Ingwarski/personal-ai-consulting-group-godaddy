import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { securityHeaders } from "../http/security-headers.ts";

const applicationRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const same = (a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;

/** Serves only a fresh, harmless test marker. This is NOT a static-file server. */
export async function matrixPositiveControlResponse(request: Request, root = applicationRoot): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!/^\/assets\/matrix-isolation-positive-[a-f0-9]{32}\.txt$/u.test(url.pathname)) return undefined;
  const reply = (body: string, status: number): Response => new Response(body,
    { status, headers: securityHeaders({ "content-type": "text/plain; charset=utf-8" }) });
  if (request.method !== "GET" || url.search) return reply("Invalid control request.", 400);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const uid = process.getuid?.();
    if (uid === undefined || !root.startsWith("/") || resolve(root) !== root || root === "/") return reply("Not found.", 404);
    const parent = join(root, "public", "assets");
    const ancestors = [root, join(root, "public"), parent];
    const snapshots = await Promise.all(ancestors.map(async path => {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7022) !== 0
        || await realpath(path) !== path) throw Error("unsafe_control_directory");
      return stat;
    }));
    const path = join(parent, url.pathname.slice("/assets/".length));
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || ![0o600, 0o644].includes(before.mode & 0o7777)
      || before.size < 1 || before.size > 128 || before.mtimeMs > Date.now() || Date.now() - before.mtimeMs > 180_000) {
      return reply("Not found.", 404);
    }
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const after = await handle.stat();
    const current = await lstat(path);
    if (!same(before, after) || !same(before, current) || before.size !== after.size || before.size !== current.size
      || before.mtimeMs !== after.mtimeMs || before.mtimeMs !== current.mtimeMs
      || before.ctimeMs !== after.ctimeMs || before.ctimeMs !== current.ctimeMs
      || bytesRead !== before.size || !/^matrix-isolation-positive:[a-f0-9]{32}$/u.test(text)) return reply("Not found.", 404);
    for (const [index, ancestor] of ancestors.entries()) {
      if (!same(snapshots[index]!, await lstat(ancestor)) || await realpath(ancestor) !== ancestor) return reply("Not found.", 404);
    }
    return reply(text, 200);
  } catch { return reply("Not found.", 404); }
  finally { await handle?.close(); }
}
