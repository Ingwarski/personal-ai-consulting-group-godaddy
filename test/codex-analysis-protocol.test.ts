import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { JsonRpcClient } from "../src/runtime/json-rpc-client.ts";
import { CodexAppServerThreadClient } from "../src/runtime/codex-thread-client.ts";

/** Content-free protocol validation. Fresh empty auth home; NEVER turn/start. */
test("pinned native CLI accepts analysis-only empty environments and its generated schema confirms the exact policy", { timeout: 20_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "critic-native-protocol-"));
  const authHome = join(scratch, "empty-auth");
  await mkdir(authHome, { mode: 0o700 });
  const executable = resolve("node_modules/@openai/codex/bin/codex.js");
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: authHome, CODEX_HOME: authHome };
  const schemaDirectory = join(scratch, "schema");
  let child: ReturnType<typeof spawn> | undefined;
  let rpc: JsonRpcClient | undefined;
  let client: CodexAppServerThreadClient | undefined;
  let lease: Awaited<ReturnType<CodexAppServerThreadClient["startIsolatedThread"]>> | undefined;
  try {
    const version = JSON.parse(await readFile(resolve("node_modules/@openai/codex/package.json"), "utf8")).version;
    assert.equal(version, "0.153.1", "Revalidate isolation against the new pinned protocol when upgrading.");
    await promisify(execFile)(process.execPath, [executable, "app-server", "generate-json-schema", "--experimental", "--out", schemaDirectory], { env: environment, timeout: 10_000 });
    const threadSchema = JSON.parse(await readFile(join(schemaDirectory, "v2/ThreadStartParams.json"), "utf8"));
    const turnSchema = JSON.parse(await readFile(join(schemaDirectory, "v2/TurnStartParams.json"), "utf8"));
    assert.match(threadSchema.properties.environments.description, /Empty disables environment access/);
    assert.match(turnSchema.properties.environments.description, /Empty disables environment access/);
    const readOnly = turnSchema.definitions.SandboxPolicy.oneOf.find((branch: { properties: { type: { enum: string[] } } }) => branch.properties.type.enum.includes("readOnly"));
    assert.deepEqual(Object.keys(readOnly.properties).sort(), ["networkAccess", "type"]);
    const localImage = turnSchema.definitions.UserInput.oneOf.find((branch: { properties: { type: { enum: string[] } } }) => branch.properties.type.enum.includes("localImage"));
    assert.deepEqual(localImage.required.slice().sort(), ["path", "type"]);
    assert.equal(localImage.properties.path.type, "string");
    child = spawn(process.execPath, [executable, "app-server", "--stdio"], { env: environment, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout! });
    const methods: string[] = [];
    rpc = new JsonRpcClient({ experimentalApi: true, timeoutMilliseconds: 5_000, channel: {
      send: async (line) => { methods.push(JSON.parse(line).method); child!.stdin!.write(`${line}\n`); },
      onLine: (listener) => { lines.on("line", listener); return () => { lines.off("line", listener); lines.close(); }; }
    } });
    client = new CodexAppServerThreadClient({ rpc, clientInfo: { name: "critic-protocol-test", title: "Protocol test", version: "1" } });
    lease = await client.startIsolatedThread({ modelId: "gpt-6-astra", webSearch: true });
    assert.equal(lease.ok, true, "Exact native thread/start must accept the isolated research policy, not a mock.");
    assert.equal(methods.includes("turn/start"), false, "This check must not invoke a model.");
    await assert.rejects(readFile(join(authHome, "auth.json")), { code: "ENOENT" });
  } finally {
    if (lease?.ok) await client?.releaseThread(lease.value);
    rpc?.close();
    child?.kill("SIGKILL");
    if (child !== undefined && child.exitCode === null && child.signalCode === null) await new Promise<void>((done) => child!.once("exit", () => done()));
    await rm(scratch, { recursive: true, force: true });
  }
});
