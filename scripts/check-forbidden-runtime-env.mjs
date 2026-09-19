import { existsSync, readFileSync } from "node:fs";
import { FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES } from "../src/runtime/environment.ts";

const environmentFiles = [".env", ".env.local", ".dev.vars", ".dev.vars.local"];
const findings = [];

for (const file of environmentFiles) {
  if (!existsSync(file)) continue;

  const content = readFileSync(file, "utf8");
  for (const name of FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES) {
    if (new RegExp(`^\\s*${name}\\s*=`, "m").test(content)) {
      findings.push(`${file}: ${name}`);
    }
  }
}

if (findings.length > 0) {
  throw new Error(`Forbidden provider credential/configuration detected: ${findings.join(", ")}`);
}

console.log("environment policy: passed");
