import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const root = resolve(
  "forge/design/candidates/candidate-b/v1"
);
const fixturePath = resolve(
  "forge/design/candidate-sets/whatsapp-consultant/v1/shared/scenario-fixture.js"
);
const expectedFixtureHash =
  "96732f738a41bf1f838736de77a748ef65704d68010553bbf43638f83ddd1af6";
const expectedBodyHash =
  "ddf71722bcb4d5a2e0a56a64a4f6f0160d99d276f75590afd263e10371e76cfa";
const requiredStates = [
  "active",
  "permission",
  "failure",
  "final",
  "costs",
  "stopped"
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const fixtureSource = readFileSync(fixturePath);
const fixtureHash = sha256(fixtureSource);
assert(fixtureHash === expectedFixtureHash, "shared fixture hash mismatch");

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fixtureSource.toString("utf8"), sandbox);
const scenario = sandbox.window.PC_SCENARIO_V1;
assert(scenario, "scenario fixture did not initialize");
assert(Object.isFrozen(scenario), "scenario root is not frozen");

const bodySource = scenario.agentMessages
  .map((message) => {
    assert(Object.isFrozen(message), "agent message is not frozen");
    assert(message.bodyContract.verbatim === true, "verbatim contract missing");
    assert(message.bodyContract.immutable === true, "immutable contract missing");
    assert(
      message.bodyContract.normalization === "none",
      "body normalization must remain none"
    );
    return message.body;
  })
  .join(scenario.agentBodyContract.concatenationSeparator);
const bodyHash = sha256(Buffer.from(bodySource, "utf8"));
assert(bodyHash === expectedBodyHash, "frozen agent body hash mismatch");

assert(
  JSON.stringify(Object.keys(scenario.expectedViews)) ===
    JSON.stringify(requiredStates),
  "query-state contract mismatch"
);

const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const styleSource = readFileSync(resolve(root, "styles.css"), "utf8");
const appSource = readFileSync(resolve(root, "app.js"), "utf8");
assert(
  indexSource.includes(
    "../../../candidate-sets/whatsapp-consultant/v1/shared/scenario-fixture.js"
  ),
  "prototype does not load the frozen shared fixture"
);
requiredStates.forEach((state) => {
  assert(indexSource.includes("?state=" + state), "missing route state " + state);
});
assert(indexSource.includes("Evidence controls · поза продуктом"), "switcher boundary missing");
assert(
  !indexSource.includes("pc-whatsapp-consultant-v1") &&
    !indexSource.includes(expectedFixtureHash) &&
    !indexSource.includes(expectedBodyHash),
  "visible evidence markup exposes a raw technical identifier or hash"
);
assert(appSource.includes("window.PC_SCENARIO_V1"), "fixture is not consumed");
assert(appSource.includes("prefers-reduced-motion") === false, "motion policy belongs in CSS");
assert(styleSource.includes("prefers-reduced-motion: reduce"), "reduced motion support missing");
assert(styleSource.includes(":focus-visible"), "focus visibility missing");
scenario.agentMessages.forEach((message) => {
  assert(
    !indexSource.includes(message.body) && !appSource.includes(message.body),
    "agent body was duplicated into candidate source"
  );
});

process.stdout.write(
  JSON.stringify(
    {
      result: "passed",
      candidate: "candidate-b/v1",
      fixtureHash,
      frozenBodyHash: bodyHash,
      states: requiredStates,
      files: ["index.html", "styles.css", "app.js", "validate.mjs"]
    },
    null,
    2
  ) + "\n"
);
