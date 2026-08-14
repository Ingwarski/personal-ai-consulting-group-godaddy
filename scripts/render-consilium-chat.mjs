#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const [sessionDirArg, fragmentPathArg] = process.argv.slice(2);

if (!sessionDirArg || !fragmentPathArg) {
  throw new Error("Usage: render-consilium-chat.mjs <session-dir> <fragment-path>");
}

const sessionDir = path.resolve(sessionDirArg);
const chatPath = path.join(sessionDir, "CHAT.md");
const liveChatPath = path.join(sessionDir, "LIVE_CHAT.md");
const fragmentPath = path.resolve(fragmentPathArg);
const source = fs.readFileSync(chatPath, "utf8");

const sessionId = source.match(/- ID сесії: `([^`]+)`/)?.[1];
const openedAt = source.match(/- Відкрито: `([^`]+)`/)?.[1];

if (!sessionId || !openedAt) {
  throw new Error("CHAT.md has no session id or opening timestamp");
}

const messagePattern = /### (M\d+)\n\n- Час: `([^`]+)`\n- Відправник: (.+)\n- Одержувач: (.+)\n\n<!-- BEGIN VERBATIM MESSAGE \1 -->\n([\s\S]*?)\n<!-- END VERBATIM MESSAGE \1 -->/g;
const messages = [...source.matchAll(messagePattern)].map((match) => ({
  id: match[1],
  timestamp: match[2],
  sender: match[3],
  recipient: match[4],
  body: match[5],
}));

if (!messages.length) {
  throw new Error("CHAT.md has no messages");
}

const visibleRole = (value) => value
  .replace(/\s+`[^`]+`/g, "")
  .replace(/\s*;\s*/g, "; ")
  .trim();
const displayTime = (value) => value.slice(11, 16);
const htmlTime = (value) => value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
const startLabel = `${openedAt.slice(8, 10)}.${openedAt.slice(5, 7)}.${openedAt.slice(0, 4)}, ${displayTime(openedAt)}`;
const escapeHtml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const liveChat = [
  "# Фінансовий консиліум",
  "",
  `**Початок: ${startLabel}**`,
  "",
  ...messages.flatMap((message, index) => [
    ...(index ? ["---", ""] : []),
    `## ${visibleRole(message.sender)} → ${visibleRole(message.recipient)} · ${displayTime(message.timestamp)}`,
    "",
    message.body,
    "",
  ]),
].join("\n").trimEnd() + "\n";

const messageHtml = messages.map((message) => {
  const sender = visibleRole(message.sender);
  const recipient = visibleRole(message.recipient);
  const direction = sender === "Головний консультант" ? "is-sent" : "is-received";
  return `      <article class="im-message ${direction}" aria-label="${escapeHtml(sender)} до ${escapeHtml(recipient)} о ${displayTime(message.timestamp)}">
        <div class="im-stack">
          <div class="im-meta text-small">
            <span class="im-role">${escapeHtml(sender)} → ${escapeHtml(recipient)}</span>
            <time datetime="${htmlTime(message.timestamp)}">${displayTime(message.timestamp)}</time>
          </div>
          <div class="im-bubble"><div class="im-body">${escapeHtml(message.body)}</div></div>
        </div>
      </article>`;
}).join("\n\n");

const lastMessage = messages.at(-1).id;
const fragment = `<div id="fc-imessage-live" data-session-id="${escapeHtml(sessionId)}" data-last-message="${lastMessage}" aria-label="Дослівний чат фінансового консиліуму">
  <style>
    #fc-imessage-live {
      color-scheme: light dark;
      width: 100%;
      min-width: 0;
      color: light-dark(#1c1c1e, #f5f5f7);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    }

    #fc-imessage-live .im-window {
      overflow: hidden;
      background: light-dark(#f2f2f7, #000000);
      border: 1px solid light-dark(#d1d1d6, #38383a);
      border-radius: 18px;
    }

    #fc-imessage-live .im-header {
      padding: 15px 16px 13px;
      text-align: center;
      background: light-dark(#ffffff, #1c1c1e);
      border-bottom: 1px solid light-dark(#d1d1d6, #38383a);
    }

    #fc-imessage-live .im-title {
      margin: 0;
      font-weight: 500;
    }

    #fc-imessage-live .im-start {
      margin-top: 4px;
      color: light-dark(#636366, #aeaeb2);
    }

    #fc-imessage-live .im-thread {
      padding: 18px 13px 22px;
    }

    #fc-imessage-live .im-message {
      display: flex;
      min-width: 0;
      margin-top: 18px;
    }

    #fc-imessage-live .im-message:first-child {
      margin-top: 0;
    }

    #fc-imessage-live .im-message.is-sent {
      justify-content: flex-end;
    }

    #fc-imessage-live .im-stack {
      width: min(88%, 650px);
      min-width: 0;
    }

    #fc-imessage-live .is-sent .im-stack {
      text-align: right;
    }

    #fc-imessage-live .im-meta {
      display: flex;
      gap: 8px;
      align-items: baseline;
      margin: 0 7px 5px;
      color: light-dark(#636366, #aeaeb2);
    }

    #fc-imessage-live .is-sent .im-meta {
      justify-content: flex-end;
    }

    #fc-imessage-live .im-role {
      color: light-dark(#3a3a3c, #d1d1d6);
      font-weight: 500;
    }

    #fc-imessage-live .im-bubble {
      display: inline-block;
      max-width: 100%;
      padding: 10px 13px;
      border-radius: 18px;
      text-align: left;
      overflow-wrap: anywhere;
    }

    #fc-imessage-live .im-body {
      margin: 0;
      white-space: pre-wrap;
    }

    #fc-imessage-live .is-sent .im-bubble {
      color: #ffffff;
      background: light-dark(#0a84ff, #0a84ff);
      border-bottom-right-radius: 5px;
    }

    #fc-imessage-live .is-received .im-bubble {
      color: light-dark(#1c1c1e, #f5f5f7);
      background: light-dark(#e5e5ea, #2c2c2e);
      border-bottom-left-radius: 5px;
    }

    @media (max-width: 480px) {
      #fc-imessage-live .im-window {
        border-radius: 14px;
      }

      #fc-imessage-live .im-thread {
        padding-inline: 9px;
      }

      #fc-imessage-live .im-stack {
        width: 94%;
      }

      #fc-imessage-live .im-meta {
        align-items: flex-start;
        flex-direction: column;
        gap: 1px;
      }

      #fc-imessage-live .is-sent .im-meta {
        align-items: flex-end;
      }
    }
  </style>

  <section class="im-window">
    <header class="im-header">
      <h2 class="im-title">Фінансовий консиліум</h2>
      <div class="im-start text-small">Початок: ${startLabel}</div>
    </header>

    <div class="im-thread">
${messageHtml}
    </div>
  </section>
</div>
`;

fs.mkdirSync(path.dirname(fragmentPath), { recursive: true });
fs.writeFileSync(liveChatPath, liveChat);
fs.writeFileSync(fragmentPath, fragment);

console.log(`${messages.length} messages rendered`);
console.log(liveChatPath);
console.log(fragmentPath);
