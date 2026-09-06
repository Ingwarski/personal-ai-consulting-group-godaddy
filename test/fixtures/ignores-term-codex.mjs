#!/usr/bin/env node
// Local lifecycle fixture only: no provider, credentials, or network calls.
import { createInterface } from "node:readline";
process.on("SIGTERM", () => {});
createInterface({ input: process.stdin }).on("line", line => {
  const { id } = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id, result: { pid: process.pid, cwd: process.cwd() } }) + "\n");
});
