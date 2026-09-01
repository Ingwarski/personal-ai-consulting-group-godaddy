import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(repositoryRoot, "dist", "godaddy");

await mkdir(outputRoot, { recursive: true });
await copyFile(resolve(repositoryRoot, "src/godaddy/database-probe.mjs"), resolve(outputRoot, "database-probe.mjs"));
await copyFile(resolve(repositoryRoot, "src/godaddy/server.mjs"), resolve(outputRoot, "server.mjs"));
await copyFile(resolve(repositoryRoot, "src/godaddy/forbidden-environment.mjs"), resolve(outputRoot, "forbidden-environment.mjs"));
