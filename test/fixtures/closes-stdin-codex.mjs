#!/usr/bin/env node
// Regression fixture: close the read end while staying alive so the parent
// receives EPIPE instead of a normal child exit before its next write.
import { closeSync } from "node:fs";
process.on("SIGTERM", () => process.exit(0));
process.stdout.write('{"fixture":"ready"}\n', () => closeSync(0));
setInterval(() => {}, 1_000);
