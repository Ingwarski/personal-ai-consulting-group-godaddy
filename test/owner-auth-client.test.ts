import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { ownerAuthClientJavaScript } from "../src/godaddy/owner-auth-client.ts";

class Form {
  action: string;
  token = "local-purpose-token";
  dataset: Record<string, string> = {};
  button = { disabled: false };
  attributes = new Map<string, string>();
  constructor(action: string) { this.action = action; }
  hasAttribute(name: string) { return name === "data-owner-action"; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelectorAll() { return [this.button]; }
}

function browser(fetcher: (path: string, init: RequestInit) => Promise<Response>) {
  let submit!: (event: { target: Form; preventDefault: () => void }) => Promise<void>;
  let destination: string | undefined;
  let statusFocused = false;
  let headingFocused = false;
  let replaced = false;
  const output = { textContent: "", focus: () => { statusFocused = true; } };
  const main = { replaceWith: () => { replaced = true; } };
  const next = { querySelector: () => ({ setAttribute: () => {}, focus: () => { headingFocused = true; } }) };
  runInNewContext(ownerAuthClientJavaScript, {
    URL, URLSearchParams, HTMLFormElement: Form,
    FormData: class { form: Form; constructor(form: Form) { this.form = form; } get() { return this.form.token; } },
    DOMParser: class { parseFromString() { return { querySelector: () => next }; } },
    document: {
      addEventListener: (_name: string, listener: typeof submit) => { submit = listener; },
      querySelector: (selector: string) => selector === "main" ? main : output
    },
    location: { href: "https://settings.example.test/auth/sign-in", origin: "https://settings.example.test", assign: (url: string) => { destination = url; } },
    fetch: fetcher
  });
  return {
    submit: (form: Form) => submit({ target: form, preventDefault: () => {} }),
    state: () => ({ destination, message: output.textContent, statusFocused, headingFocused, replaced })
  };
}

test("explicit Google action uses cors with no-referrer, credentials and no automatic redirects, then navigates this tab", async () => {
  const seen: { path: string; init: RequestInit }[] = [];
  const app = browser(async (path, init) => {
    seen.push({ path, init });
    return Response.json({ location: "https://accounts.google.com/o/oauth2/v2/auth?state=transient-state" });
  });
  await app.submit(new Form("/auth/google/start"));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.path, "/auth/google/start");
  assert.equal(seen[0]?.init.mode, "cors");
  assert.equal(seen[0]?.init.referrerPolicy, "no-referrer");
  assert.equal(seen[0]?.init.credentials, "same-origin");
  assert.equal(seen[0]?.init.redirect, "error");
  assert.equal(String(seen[0]?.init.body), "formToken=local-purpose-token");
  assert.equal(app.state().destination, "https://accounts.google.com/o/oauth2/v2/auth?state=transient-state");
});

test("the client rejects action origin/path changes and redirect destinations outside its explicit allowlist", async () => {
  let calls = 0;
  const app = browser(async () => { calls++; return Response.json({ location: "https://attacker.test/collect" }); });
  for (const action of ["https://attacker.test/auth/google/start", "/auth/google/start?next=elsewhere", "/unexpected"]) {
    await app.submit(new Form(action));
  }
  assert.equal(calls, 0);
  await app.submit(new Form("/auth/google/start"));
  assert.equal(calls, 1);
  assert.equal(app.state().destination, undefined);
  assert.equal(app.state().statusFocused, true);
  assert.doesNotMatch(app.state().message, /attacker|invalid_destination/u);
});

test("logout may navigate only to a clean local destination, never to Google or a query-bearing destination", async () => {
  for (const destination of ["https://accounts.google.com/o/oauth2/v2/auth", "/auth/sign-in?code=secret", "javascript:alert(1)"]) {
    const app = browser(async () => Response.json({ location: destination }));
    await app.submit(new Form("/auth/sign-out"));
    assert.equal(app.state().destination, undefined);
  }
  const app = browser(async () => Response.json({ location: "/auth/sign-in" }));
  await app.submit(new Form("/auth/sign-out"));
  assert.equal(app.state().destination, "https://settings.example.test/auth/sign-in");
});

test("an operations HTML result keeps its one-time code in the current document and moves focus to its heading", async () => {
  const app = browser(async () => new Response("<main><h1>Result</h1></main>", { headers: { "content-type": "text/html; charset=utf-8" } }));
  await app.submit(new Form("/operations/runtime/codex"));
  assert.equal(app.state().replaced, true);
  assert.equal(app.state().headingFocused, true);
  assert.equal(app.state().destination, undefined);
});

test("failed and throttled actions show bounded messages, reenable their buttons and never disclose server errors", async () => {
  for (const status of [403, 429, 503]) {
    const app = browser(async () => Response.json({ error: "RAW_SECRET_EXCEPTION" }, { status }));
    const form = new Form("/auth/google/start");
    await app.submit(form);
    assert.equal(form.button.disabled, false);
    assert.equal(form.dataset.pending, undefined);
    assert.equal(app.state().statusFocused, true);
    assert.doesNotMatch(app.state().message, /RAW_SECRET_EXCEPTION/u);
    if (status === 429) assert.match(app.state().message, /Забагато спроб/u);
  }
});

test("a second submit while one action is pending does not start another OAuth transaction", async () => {
  let finish!: (response: Response) => void;
  let calls = 0;
  const app = browser(async () => { calls++; return new Promise<Response>((resolve) => { finish = resolve; }); });
  const form = new Form("/auth/google/start");
  const first = app.submit(form);
  assert.equal(form.button.disabled, true);
  await app.submit(form);
  assert.equal(calls, 1);
  finish(Response.json({ error: "access_denied" }, { status: 403 }));
  await first;
  assert.equal(form.button.disabled, false);
});
