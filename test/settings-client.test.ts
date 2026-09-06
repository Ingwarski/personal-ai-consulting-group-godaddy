import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { CapabilityReceipt, OwnerSettings } from "../src/settings/types.ts";
import { activeNow, createCapabilityReceipt } from "./fixtures/capability-receipt.ts";

const clientPath = fileURLToPath(new URL("../src/settings/ui/client.js", import.meta.url));

// A bounded DOM double exercises the shipped event handlers, not a second
// implementation of draft switching. Real layout/focus is verified in-browser.
function browserClient(current: OwnerSettings, receipt = createCapabilityReceipt()) {
  class Element {
    textContent = "";
    hidden = false;
    disabled = false;
    dataset: Record<string, string> = {};
    listeners = new Map<string, Array<(event: { target?: Element; preventDefault(): void }) => void>>();
    queries = new Map<string, Element>();
    classes = new Set<string>();
    classList = { toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    addEventListener(name: string, handler: (event: { target?: Element; preventDefault(): void }) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
    }
    querySelector(selector: string) { return this.queries.get(selector); }
  }
  class Option {
    text: string;
    value: string;
    disabled = false;
    selected: boolean;
    constructor(text: string, value: string, _defaultSelected = false, selected = false) {
      this.text = text; this.value = value; this.selected = selected;
    }
  }
  class Select extends Element {
    value = "";
    options: Option[] = [];
    replaceChildren(...options: Option[]) { this.options = options; }
  }
  class Button extends Element {}
  class Script extends Element {}
  const controls = Object.fromEntries(["codexModelId", "codexReasoningEffort", "criticProvider", "criticModelId", "criticReasoningEffort", "speedPreset"].map(name => [name, new Select()]));
  class Form extends Element { elements = { namedItem: (name: string) => controls[name] }; }
  const form = new Form();
  form.dataset = { current: JSON.stringify(current), etag: '"revision-1"' };
  controls.codexModelId!.value = current.codex.modelId;
  controls.codexReasoningEffort!.value = current.codex.reasoningEffort ?? "";
  controls.criticProvider!.value = current.critic.provider;
  controls.speedPreset!.value = current.speedPreset;
  const save = new Button();
  const status = new Element();
  status.queries.set("strong", new Element());
  status.queries.set("p", new Element());
  form.queries.set('button[type="submit"]', save);
  form.queries.set('input[name="speedPreset"]:checked', controls.speedPreset!);
  const catalog = new Script();
  const models = (items: CapabilityReceipt["codexModels"]) => items.map(model => ({ id: model.productId, displayName: model.displayName, availability: model.availability, efforts: model.supportedReasoningEfforts.filter(effort => Boolean(model.reasoningMappings[effort])) }));
  catalog.textContent = JSON.stringify({ ...receipt, codexModels: models(receipt.codexModels), claudeModels: models(receipt.claudeModels) });
  const elements = new Map<string, Element>([["settings-form", form], ["settings-status", status], ["settings-catalog", catalog], ["reset-button", new Button()], ["cancel-button", new Button()]]);
  for (const id of ["critic-feedback", "critic-feedback-text", "critic-recovery-link", "critic-model-help", "critic-saved"]) elements.set(id, new Element());
  const requests: Array<{ url: string; options: { method?: string; body?: string } }> = [];
  let reloads = 0;
  runInNewContext(readFileSync(clientPath, "utf8"), {
    document: { getElementById: (id: string) => elements.get(id), querySelector: () => ({ getAttribute: () => "test-csrf" }) },
    HTMLFormElement: Form, HTMLElement: Element, HTMLScriptElement: Script, HTMLSelectElement: Select, HTMLButtonElement: Button,
    Option, structuredClone, Date: class extends Date { static now() { return activeNow.getTime(); } },
    crypto: { randomUUID: () => "test-mutation-id" },
    window: { location: { reload: () => { reloads += 1; } }, confirm: () => true },
    fetch: async (url: string, options: { method?: string; body?: string }) => { requests.push({ url, options }); return { ok: true, status: 200 }; }
  });
  const dispatch = (name: string, target?: Element) => {
    for (const handler of form.listeners.get(name) ?? []) handler({ ...(target ? { target } : {}), preventDefault() {} });
  };
  return { controls, save, status, elements, requests, reloads: () => reloads,
    change(name: string, value: string) { controls[name]!.value = value; dispatch("change", controls[name]); },
    async submit() { dispatch("submit"); await new Promise(resolve => setImmediate(resolve)); }
  };
}

test("settings browser client is valid JavaScript and carries only the full-object protected mutation flow", () => {
  execFileSync(process.execPath, ["--check", clientPath], { stdio: "pipe" });
  const source = readFileSync(clientPath, "utf8");

  assert.match(source, /fetch\(url, \{ method: url\.endsWith\("\/reset"\) \? "POST" : "PUT"/);
  assert.match(source, /"if-match": form\.dataset\.etag/);
  assert.match(source, /pendingMutation = \{ signature, key: idempotencyKey\(\) \}/);
  assert.match(source, /"idempotency-key": key/);
  assert.match(source, /"x-csrf-token": csrfToken/);
  assert.match(source, /credentials: "same-origin"/);
  assert.match(source, /response\.status === 409/);
  assert.match(source, /fetch\("\/api\/settings", \{ credentials: "same-origin" \}\)/);
  assert.match(source, /fetch\("\/api\/settings\/csrf"/);
  assert.match(source, /"x-owner-action-token": actionToken/);
  assert.match(source, /mode: "cors"/);
  assert.match(source, /setStatus\("success", "Набір сумісний\. Змін для збереження немає\.", "Набір сумісний"\)/);
  assert.doesNotMatch(source, /response\.status === 403[^}]+submit\(/s);
  assert.doesNotMatch(source, /oauth|password|api[_-]?key|fast mode|payg|credits/i);
});

test("switching Critic providers retains both drafts, leaves head untouched, and performs no autosave", async () => {
  const base = createCapabilityReceipt().defaults;
  const current: OwnerSettings = { ...base, critic: { ...base.critic, codex: { modelId: base.codex.modelId, reasoningEffort: "low" } } };
  const browser = browserClient(current);
  browser.change("criticProvider", "codex");
  assert.equal(browser.controls.criticReasoningEffort!.value, "low");
  browser.change("criticReasoningEffort", "xhigh");
  browser.change("criticProvider", "claude_code");
  assert.equal(browser.controls.criticReasoningEffort!.value, "high");
  browser.change("criticReasoningEffort", "medium");
  browser.change("criticProvider", "codex");
  assert.equal(browser.controls.criticReasoningEffort!.value, "xhigh");
  assert.equal(browser.controls.codexReasoningEffort!.value, "high");
  assert.equal(browser.controls.codexModelId!.value, current.codex.modelId);
  assert.equal(browser.requests.length, 0);
  assert.equal(browser.save.disabled, false);
  await browser.submit();
  assert.equal(browser.requests.length, 1);
  assert.equal(browser.requests[0]!.options.method, "PUT");
  assert.deepEqual(JSON.parse(browser.requests[0]!.options.body!), { ...current,
    critic: { provider: "codex", claude: { ...current.critic.claude, reasoningEffort: "medium" }, codex: { ...current.critic.codex, reasoningEffort: "xhigh" } }
  });
  assert.equal(browser.reloads(), 1);
});

test("a null Critic branch is not silently populated from head or the first catalog model", async () => {
  const browser = browserClient(createCapabilityReceipt().defaults);
  browser.change("criticProvider", "codex");
  assert.equal(browser.controls.criticModelId!.value, "");
  assert.equal(browser.save.disabled, true);
  await browser.submit();
  assert.equal(browser.requests.length, 0);
  browser.change("criticModelId", "codex-current-primary");
  browser.change("criticReasoningEffort", "xhigh");
  assert.equal(browser.save.disabled, false);
  assert.ok(browser.controls.criticReasoningEffort!.options.some(option => option.value === "xhigh" && option.text === "Extra High"));
});

test("missing Claude retains its unavailable choices while Codex Critic remains usable", async () => {
  const base = createCapabilityReceipt().defaults;
  const current: OwnerSettings = { ...base, critic: { ...base.critic, provider: "codex", codex: { ...base.codex, reasoningEffort: "xhigh" } } };
  const browser = browserClient(current, createCapabilityReceipt({ claudeModels: [] }));
  browser.change("speedPreset", "ретельно");
  assert.equal(browser.save.disabled, false);
  browser.change("criticProvider", "claude_code");
  assert.equal(browser.save.disabled, true);
  assert.equal(browser.controls.criticModelId!.value, base.critic.claude!.modelId);
  assert.ok(browser.controls.criticModelId!.options.some(option => option.disabled && option.value === base.critic.claude!.modelId));
  assert.equal(browser.elements.get("critic-recovery-link")!.hidden, false);
  browser.change("criticProvider", "codex");
  assert.equal(browser.save.disabled, false);
  await browser.submit();
  assert.deepEqual(JSON.parse(browser.requests[0]!.options.body!).critic.claude, base.critic.claude);
});

test("a fresh provider receipt cannot hide an expired overall catalog", () => {
  const base = createCapabilityReceipt();
  const ready = { schemaVersion: "1" as const, status: "ready" as const, catalogVersion: "ready", issuedAt: base.issuedAt, expiresAt: base.expiresAt, trusted: true };
  const browser = browserClient(base.defaults, createCapabilityReceipt({ expiresAt: "2026-08-16T01:00:00Z", providerReceipts: { codex: ready, claude_code: ready } }));
  browser.change("speedPreset", "ретельно");
  assert.equal(browser.save.disabled, true);
  assert.ok(browser.status.classes.has("error"));
});

test("switching models retains an unsupported effort visibly and blocks saving until explicit correction", () => {
  const base = createCapabilityReceipt();
  const receipt = createCapabilityReceipt({ codexModels: [...base.codexModels, { ...base.codexModels[0]!, productId: "codex-low-only", supportedReasoningEfforts: ["low"], reasoningMappings: { low: "low" } }] });
  const current: OwnerSettings = { ...base.defaults, critic: { ...base.defaults.critic, provider: "codex", codex: { ...base.defaults.codex, reasoningEffort: "xhigh" } } };
  const browser = browserClient(current, receipt);
  browser.change("criticModelId", "codex-low-only");
  assert.equal(browser.controls.criticReasoningEffort!.value, "xhigh");
  assert.ok(browser.controls.criticReasoningEffort!.options.some(option => option.value === "xhigh" && option.disabled));
  assert.equal(browser.save.disabled, true);
  browser.change("criticReasoningEffort", "low");
  assert.equal(browser.save.disabled, false);
});
