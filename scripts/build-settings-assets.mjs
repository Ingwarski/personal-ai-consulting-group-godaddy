import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(repositoryRoot, "dist", "assets");
const assets = [
  ["src/settings/ui/styles.css", "settings.css"],
  ["src/settings/ui/client.js", "settings.js"]
];

await mkdir(outputDirectory, { recursive: true });
for (const [source, target] of assets) {
  await copyFile(resolve(repositoryRoot, source), resolve(outputDirectory, target));
}
