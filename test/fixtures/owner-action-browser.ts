import { runInNewContext } from "node:vm";
import { ownerAuthClientJavaScript } from "../../src/godaddy/owner-auth-client.ts";

/** Minimal DOM contract harness; not a real-browser or live-auth proof. */
export class Form {
  readonly actionAttribute: string;
  token = "local-purpose-token";
  fields: Record<string, string> = {};
  dataset: Record<string, string> = {};
  button = { disabled: false };
  attributes = new Map<string, string>();
  constructor(action: string) { this.actionAttribute = action; }
  // Match browser named-control shadowing, not a misleading plain property.
  get action() { return this.fields.action === undefined ? this.actionAttribute : { value: this.fields.action }; }
  getAttribute(name: string) { return name === "action" ? this.actionAttribute : this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return name === "data-owner-action"; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelectorAll() { return [this.button]; }
}

export function browser(fetcher: (path: string, init: RequestInit) => Promise<Response>, script = ownerAuthClientJavaScript) {
  let submit!: (event: { target: Form; preventDefault: () => void }) => Promise<void>;
  let destination: string | undefined;
  let statusFocused = false;
  let headingFocused = false;
  let replaced = false;
  const output = { textContent: "", focus: () => { statusFocused = true; } };
  const main = { replaceWith: () => { replaced = true; } };
  const next = { querySelector: () => ({ setAttribute: () => {}, focus: () => { headingFocused = true; } }) };
  runInNewContext(script, {
    URL, URLSearchParams, HTMLFormElement: Form,
    window: { addEventListener: () => {} },
    FormData: class { form: Form; constructor(form: Form) { this.form = form; } get(name: string) { return name === "formToken" ? this.form.token : this.form.fields[name] ?? null; } },
    DOMParser: class { parseFromString() { return { querySelector: () => next }; } },
    document: {
      addEventListener: (name: string, listener: typeof submit) => { if (name === "submit") submit = listener; },
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
