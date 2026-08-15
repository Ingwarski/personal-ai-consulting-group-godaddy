import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const candidateRoot = resolve("forge/design/candidates/candidate-b/v2");
const legacyFixturePath = resolve(
  "forge/design/candidate-sets/whatsapp-consultant/v1/shared/scenario-fixture.js"
);
const matrixFixturePath = resolve(
  "forge/design/candidate-sets/matrix-consultant/v2/shared/scenario-fixture.js"
);

const expectedLegacyFixtureHash =
  "96732f738a41bf1f838736de77a748ef65704d68010553bbf43638f83ddd1af6";
const expectedAgentBodyHash =
  "ddf71722bcb4d5a2e0a56a64a4f6f0160d99d276f75590afd263e10371e76cfa";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const indexSource = readFileSync(resolve(candidateRoot, "index.html"), "utf8");
const appSource = readFileSync(resolve(candidateRoot, "app.js"), "utf8");
const styleSource = readFileSync(resolve(candidateRoot, "styles.css"), "utf8");
const legacyFixtureSource = readFileSync(legacyFixturePath);
const matrixFixtureSource = readFileSync(matrixFixturePath);

assert(
  sha256(legacyFixtureSource) === expectedLegacyFixtureHash,
  "superseded frozen fixture changed"
);

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(legacyFixtureSource.toString("utf8"), sandbox);
const legacy = sandbox.window.PC_SCENARIO_V1;
vm.runInContext(matrixFixtureSource.toString("utf8"), sandbox);
const matrix = sandbox.window.PC_MATRIX_SCENARIO_V2;

assert(legacy && matrix, "scenario fixtures did not initialize");
assert(Object.isFrozen(matrix), "Matrix scenario root is not frozen");
assert(matrix.status === "proposed", "candidate must not claim approval");
assert(matrix.surface === "SUR-01", "Matrix scenario surface mismatch");
assert(
  matrix.agentMessages === legacy.agentMessages,
  "Matrix fixture must reuse frozen agent message references"
);

const agentBodies = matrix.agentMessages.map((message) => message.body).join("");
assert(sha256(Buffer.from(agentBodies, "utf8")) === expectedAgentBodyHash, "agent bodies changed");
matrix.agentMessages.forEach((message) => {
  assert(Object.isFrozen(message), "agent message is mutable");
  assert(message.bodyContract.verbatim === true, "verbatim contract missing");
  assert(message.bodyContract.immutable === true, "immutable contract missing");
  assert(message.bodyContract.normalization === "none", "body normalization changed");
  assert(!indexSource.includes(message.body), "agent body duplicated into markup");
  assert(!appSource.includes(message.body), "agent body duplicated into app source");
  assert(!matrixFixtureSource.toString("utf8").includes(message.body), "agent body duplicated into derived fixture");
});

const combinedCoverage = `${matrixFixtureSource}\n${appSource}`;
const coveredStates = [...new Set(combinedCoverage.match(/SS-\d{2}/g) || [])].sort();
const expectedStates = Array.from({ length: 46 }, (_, index) =>
  `SS-${String(index + 1).padStart(2, "0")}`
);
assert(
  JSON.stringify(coveredStates) === JSON.stringify(expectedStates),
  `state coverage mismatch: ${coveredStates.join(", ")}`
);

assert(indexSource.includes("Element-чат"), "Element review route missing");
assert(indexSource.includes("Налаштування"), "settings review route missing");
assert(indexSource.includes("не production"), "prototype boundary missing");
assert(indexSource.includes("aria-live=\"polite\""), "live region missing");
assert(indexSource.includes("<dialog"), "reset confirmation dialog missing");

const settingsGroups = ["Моделі", "Глибина міркування", "Швидкість"];
settingsGroups.forEach((label) => assert(appSource.includes(label), `settings group missing: ${label}`));
assert(appSource.includes("Зберегти весь набір"), "atomic save label missing");
assert(appSource.includes("Активна сесія використовує незмінний snapshot"), "snapshot notice missing");
assert(appSource.includes("Іншого способу входу у V1 немає"), "Google-only denied boundary missing");
assert(appSource.includes("не Fast Mode, priority tier, PAYG або credits"), "speed boundary missing");

assert(styleSource.includes(":focus-visible"), "visible focus styles missing");
assert(styleSource.includes("prefers-reduced-motion: reduce"), "reduced-motion handling missing");
assert(styleSource.includes("max-width: 520px"), "narrow responsive layout missing");
assert(styleSource.includes("grid-template-columns: 1fr"), "single-column responsive rule missing");

const visibleSources = `${indexSource}\n${appSource}\n${styleSource}`;
assert(!/native WhatsApp context|whatsapp-surface/i.test(visibleSources), "stale platform UI remains");
assert(!/вшшш|шшшш|sound|audio/i.test(visibleSources), "custom sound control remains");
assert(!/OPENAI_API_KEY|ANTHROPIC_API_KEY/.test(visibleSources), "API credential UI leaked");

assert(
  matrix.content.costsResponse.text.includes("входить у підписки") &&
    matrix.content.costsResponse.text.includes("невідомо") &&
    !matrix.content.costsResponse.text.includes("4,82"),
  "cost semantics are stale"
);

process.stdout.write(
  JSON.stringify(
    {
      result: "passed",
      candidate: "candidate-b/v2",
      status: matrix.status,
      surfaces: ["SUR-01", "SUR-02"],
      states: `${coveredStates.length}/46`,
      legacyFixtureHash: sha256(legacyFixtureSource),
      matrixFixtureHash: sha256(matrixFixtureSource),
      frozenAgentBodyHash: sha256(Buffer.from(agentBodies, "utf8")),
      files: ["index.html", "styles.css", "app.js", "validate.mjs"]
    },
    null,
    2
  ) + "\n"
);
