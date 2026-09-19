import fs from "node:fs";
import path from "node:path";

const MESSAGE_PATTERN = /### (M\d+)\n\n- Час: `([^`]+)`\n- Відправник: (.+)\n- Одержувач: (.+)\n\n<!-- BEGIN VERBATIM MESSAGE \1 -->\n([\s\S]*?)\n<!-- END VERBATIM MESSAGE \1 -->/g;

export const visibleRole = (value) => String(value)
  .replace(/\s+`[^`]+`/g, "")
  .replace(/\s*;\s*/g, "; ")
  .trim();

export const displayTime = (value) => String(value).slice(11, 16);

export const htmlTime = (value) => String(value).replace(/([+-]\d{2})(\d{2})$/, "$1:$2");

export const startLabel = (openedAt) => (
  String(openedAt).slice(8, 10) + "." +
  String(openedAt).slice(5, 7) + "." +
  String(openedAt).slice(0, 4) + ", " +
  displayTime(openedAt)
);

export function parseChatSource(source) {
  const sessionId = source.match(/- ID сесії: `([^`]+)`/)?.[1] || "";
  const openedAt = source.match(/- Відкрито: `([^`]+)`/)?.[1] || "";
  const messages = [...source.matchAll(MESSAGE_PATTERN)].map((match) => ({
    id: match[1],
    timestamp: match[2],
    sender: visibleRole(match[3]),
    recipient: visibleRole(match[4]),
    body: match[5],
  }));

  return {
    sessionId,
    openedAt,
    startLabel: openedAt ? startLabel(openedAt) : "",
    title: sessionId.includes("financial-crisis") ? "Фінансовий консиліум" : "Консиліум",
    messages,
  };
}

export function readSessionState(sessionDir) {
  const resolvedDir = path.resolve(sessionDir);
  const chatPath = path.join(resolvedDir, "CHAT.md");
  const manifestPath = path.join(resolvedDir, "MANIFEST.md");
  const chatSource = fs.readFileSync(chatPath, "utf8");
  const state = parseChatSource(chatSource);

  let status = "відкрита";
  if (fs.existsSync(manifestPath)) {
    const manifest = fs.readFileSync(manifestPath, "utf8");
    status = manifest.match(/- Статус:\s*([^\n]+)/)?.[1]?.replaceAll("`", "").trim() || status;
  }

  return {
    ...state,
    status,
  };
}
