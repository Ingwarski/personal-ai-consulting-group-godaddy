/** Shared presentation only. Callers retain authentication, escaping of dynamic
 * content, action tokens and status semantics. No new routes or browser state. */
export function ownerPanelDocument(input: Readonly<{
  title: string;
  content: string;
  scriptPath?: string;
  section?: "consultation" | "settings" | "runtime" | "instructions";
}>): string {
  const title = input.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (input.scriptPath !== undefined && !/^\/assets\/(?:owner-auth|consultation|instructions)(?:\.[a-f0-9]{64})?\.js$/u.test(input.scriptPath)) {
    throw new Error("Invalid owner action script path.");
  }
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} — Personal Consultant</title><link rel="stylesheet" href="/assets/owner-panel.css">
    ${input.scriptPath === undefined ? "" : `<script src="${input.scriptPath}" defer></script>`}</head>
    <body class="settings-shell"><a class="skip-link" href="#main-content">Перейти до вмісту</a>
    <main class="settings-page owner-panel" id="main-content" tabindex="-1">
    ${input.section === undefined ? "" : ownerPanelNavigation(input.section)}
    <div class="owner-panel-content">${input.content}</div></main></body></html>`;
}

export function ownerPanelNavigation(section: "consultation" | "settings" | "runtime" | "instructions"): string {
  return `<nav class="owner-navigation" aria-label="Налаштування власника">${([
    ["consultation", "/consultation", "Consultation"],
    ["settings", "/settings", "Моделі й Критик"],
    ["runtime", "/operations/runtime", "Підписки ШІ"],
    ["instructions", "/instructions", "Instructions"]
  ] as const).map(([key, path, label]) => `<a href="${path}"${key === section ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}
