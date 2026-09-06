import { createHash } from "node:crypto";

/**
 * Deliberately a same-origin external script: CSP never needs unsafe-inline.
 * Fetch Standard §3.2 preserves Origin for mode=cors under no-referrer, unlike
 * native form navigation. The server still verifies Origin, metadata and CSRF.
 */
export const ownerAuthClientJavaScript = String.raw`(() => {
  const actions = new Set([
    "/auth/google/start", "/auth/sign-out", "/auth/sessions/revoke",
    "/operations/runtime/codex", "/operations/runtime/codex/reconnect",
    "/operations/runtime/catalog", "/operations/matrix/action"
  ]);
  const localDestinations = new Set(["/auth/sign-in", "/settings", "/operations/runtime"]);
  const showError = (message) => {
    const output = document.querySelector("[data-owner-action-status]");
    if (output) { output.textContent = message; output.focus(); }
  };
  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-owner-action")) return;
    event.preventDefault();
    if (form.dataset.pending === "true") return;
    // Named controls can shadow form.action (Matrix has an input named action).
    const action = new URL(form.getAttribute("action") || "", location.href);
    const parameters = Array.from(action.searchParams.entries());
    const catalogProviderQuery = action.pathname === "/operations/runtime/catalog"
      && parameters.length === 1 && parameters[0][0] === "provider"
      && ["codex", "claude_code"].includes(parameters[0][1]);
    if (action.origin !== location.origin || action.username || action.password
      || !actions.has(action.pathname) || (action.search && !catalogProviderQuery) || action.hash) {
      showError("Дію не виконано: адреса запиту недійсна. Оновіть сторінку й повторіть дію.");
      return;
    }
    const data = new FormData(form);
    const token = data.get("formToken");
    if (typeof token !== "string" || !token) return;
    const body = new URLSearchParams({ formToken: token });
    if (action.pathname === "/operations/matrix/action") {
      for (const name of ["action", "deviceId", "flowId", "comparisonToken"]) {
        const value = data.get(name);
        if (typeof value === "string") body.set(name, value);
      }
    }
    form.dataset.pending = "true";
    form.setAttribute("aria-busy", "true");
    const buttons = Array.from(form.querySelectorAll("button"));
    for (const button of buttons) button.disabled = true;
    try {
      const response = await fetch(action.pathname + action.search, {
        method: "POST", mode: "cors", credentials: "same-origin",
        redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body
      });
      const type = response.headers.get("content-type") || "";
      if (type.startsWith("text/html") && (action.pathname.startsWith("/operations/runtime/") || action.pathname === "/operations/matrix/action")) {
        const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
        const next = parsed.querySelector("main");
        const current = document.querySelector("main");
        if (!next || !current) throw new Error("invalid_response");
        current.replaceWith(next);
        const heading = next.querySelector("h1");
        if (heading) { heading.setAttribute("tabindex", "-1"); heading.focus(); }
        return;
      }
      if (type.startsWith("application/json")) {
        const result = await response.json();
        if (response.ok && typeof result.location === "string") {
          const destination = new URL(result.location, location.href);
          const local = destination.origin === location.origin && localDestinations.has(destination.pathname) && !destination.search && !destination.hash;
          const google = action.pathname === "/auth/google/start" && destination.origin === "https://accounts.google.com" && destination.pathname === "/o/oauth2/v2/auth" && !destination.hash && !destination.username && !destination.password;
          if (!local && !google) throw new Error("invalid_destination");
          location.assign(destination.href);
          return;
        }
      }
      showError(response.status === 429
        ? "Забагато спроб. Зачекайте хвилину та повторіть дію."
        : "Дію не виконано. Оновіть сторінку й повторіть вхід, якщо сесія завершилася.");
    } catch {
      showError("Не вдалося виконати дію. Перевірте з’єднання та оновіть сторінку перед повторною спробою.");
    } finally {
      delete form.dataset.pending;
      form.removeAttribute("aria-busy");
      for (const button of buttons) button.disabled = false;
    }
  });
})();`;

// Bind HTML to its exact handler bytes. A cached legacy script must not control
// a newer Matrix form (whose named action control shadows form.action).
export const OWNER_AUTH_SCRIPT_PATH = `/assets/owner-auth.${createHash("sha256").update(ownerAuthClientJavaScript).digest("hex")}.js`;
export const isOwnerAuthScriptPath = (path: string): boolean => path === OWNER_AUTH_SCRIPT_PATH || path === "/assets/owner-auth.js";
