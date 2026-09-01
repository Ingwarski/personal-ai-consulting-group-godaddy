import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(repositoryRoot, "dist", "godaddy");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await copyFile(resolve(repositoryRoot, "src/godaddy/server.mjs"), resolve(outputRoot, "server.mjs"));
await copyFile(resolve(repositoryRoot, "src/godaddy/forbidden-environment.mjs"), resolve(outputRoot, "forbidden-environment.mjs"));
