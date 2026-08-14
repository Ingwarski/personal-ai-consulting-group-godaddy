#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { escapeHtml, renderMarkdown } from "../consilium/live/markdown.js";
import { displayTime, htmlTime, parseChatSource } from "./consilium-chat-lib.mjs";

const [sessionDirArg, fragmentPathArg] = process.argv.slice(2);

if (!sessionDirArg || !fragmentPathArg) {
  throw new Error("Usage: render-consilium-chat.mjs <session-dir> <fragment-path>");
}

const sessionDir = path.resolve(sessionDirArg);
const chatPath = path.join(sessionDir, "CHAT.md");
const liveChatPath = path.join(sessionDir, "LIVE_CHAT.md");
const fragmentPath = path.resolve(fragmentPathArg);
const state = parseChatSource(fs.readFileSync(chatPath, "utf8"));

if (!state.sessionId || !state.openedAt) {
  throw new Error("CHAT.md has no session id or opening timestamp");
}

const liveChat = [
  "# " + state.title,
  "",
  "**Початок: " + state.startLabel + "**",
  "",
  ...state.messages.flatMap((message, index) => [
    ...(index ? ["---", ""] : []),
    "## " + message.sender + " → " + message.recipient + " · " + displayTime(message.timestamp),
    "",
    message.body,
    "",
  ]),
].join("\n").trimEnd() + "\n";

const messageHtml = state.messages.map((message) => {
  const direction = message.sender === "Головний консультант" ? "is-sent" : "is-received";
  const label = message.sender + " до " + message.recipient + " о " + displayTime(message.timestamp);
  return '      <article class="im-message ' + direction + '" aria-label="' + escapeHtml(label) + '">' +
    '<div class="im-stack">' +
    '<div class="im-meta">' +
    '<span class="im-role">' + escapeHtml(message.sender + " → " + message.recipient) + "</span>" +
    '<time datetime="' + htmlTime(message.timestamp) + '">' + displayTime(message.timestamp) + "</time>" +
    "</div>" +
    '<div class="im-bubble"><div class="markdown-body">' + renderMarkdown(message.body) + "</div></div>" +
    "</div></article>";
}).join("\n");

const emptyHtml = state.messages.length
  ? ""
  : '<div class="im-empty">Чекаємо на першу репліку.</div>';

const fragment = `<div id="consilium-chat-archive" aria-label="Дослівний чат консиліуму">
  <style>
    #consilium-chat-archive {
      color-scheme: light dark;
      width: 100%;
      min-width: 0;
      color: light-dark(#1c1c1e, #f5f5f7);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    }
    #consilium-chat-archive .im-window {
      overflow: hidden;
      border: 1px solid light-dark(#d1d1d6, #38383a);
      border-radius: 18px;
      background: light-dark(#f2f2f7, #000000);
    }
    #consilium-chat-archive .im-header {
      padding: 14px;
      border-bottom: 1px solid light-dark(#d1d1d6, #38383a);
      background: light-dark(#ffffff, #1c1c1e);
      text-align: center;
    }
    #consilium-chat-archive .im-title {
      margin: 0;
      font-size: 1rem;
    }
    #consilium-chat-archive .im-start,
    #consilium-chat-archive .im-empty {
      margin-top: 4px;
      color: light-dark(#636366, #aeaeb2);
      font-size: 0.75rem;
    }
    #consilium-chat-archive .im-thread {
      padding: 17px 12px 28px;
    }
    #consilium-chat-archive .im-message {
      display: flex;
      width: 100%;
      margin-top: 16px;
    }
    #consilium-chat-archive .im-message:first-child {
      margin-top: 0;
    }
    #consilium-chat-archive .im-message.is-sent {
      justify-content: flex-end;
    }
    #consilium-chat-archive .im-stack {
      width: min(92%, 720px);
      min-width: 0;
    }
    #consilium-chat-archive .is-sent .im-stack {
      text-align: right;
    }
    #consilium-chat-archive .im-meta {
      display: flex;
      gap: 8px;
      align-items: baseline;
      margin: 0 7px 5px;
      color: light-dark(#636366, #aeaeb2);
      font-size: 0.72rem;
      line-height: 1.35;
    }
    #consilium-chat-archive .is-sent .im-meta {
      justify-content: flex-end;
    }
    #consilium-chat-archive .im-role {
      color: light-dark(#3a3a3c, #d1d1d6);
      font-weight: 600;
    }
    #consilium-chat-archive .im-bubble {
      display: inline-block;
      max-width: 100%;
      padding: 10px 13px 11px;
      border-radius: 18px;
      text-align: left;
      overflow-wrap: anywhere;
    }
    #consilium-chat-archive .is-sent .im-bubble {
      border-bottom-right-radius: 5px;
      background: #0a84ff;
      color: #ffffff;
    }
    #consilium-chat-archive .is-received .im-bubble {
      border-bottom-left-radius: 5px;
      background: light-dark(#e5e5ea, #2c2c2e);
    }
    #consilium-chat-archive .markdown-body {
      font-size: 0.9rem;
      line-height: 1.46;
    }
    #consilium-chat-archive .markdown-body > :first-child {
      margin-top: 0;
    }
    #consilium-chat-archive .markdown-body > :last-child {
      margin-bottom: 0;
    }
    #consilium-chat-archive .markdown-body h1,
    #consilium-chat-archive .markdown-body h2,
    #consilium-chat-archive .markdown-body h3,
    #consilium-chat-archive .markdown-body h4,
    #consilium-chat-archive .markdown-body h5,
    #consilium-chat-archive .markdown-body h6 {
      margin: 0.85em 0 0.35em;
      font-size: 1em;
      line-height: 1.35;
    }
    #consilium-chat-archive .markdown-body p,
    #consilium-chat-archive .markdown-body ul,
    #consilium-chat-archive .markdown-body ol,
    #consilium-chat-archive .markdown-body blockquote,
    #consilium-chat-archive .markdown-body pre,
    #consilium-chat-archive .markdown-body .table-scroll {
      margin: 0.55em 0;
    }
    #consilium-chat-archive .markdown-body ul,
    #consilium-chat-archive .markdown-body ol {
      padding-left: 1.35em;
    }
    #consilium-chat-archive .markdown-body code {
      padding: 0.12em 0.33em;
      border-radius: 5px;
      background: color-mix(in srgb, currentColor 12%, transparent);
      font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
      font-size: 0.86em;
    }
    #consilium-chat-archive .markdown-body pre {
      max-width: 100%;
      padding: 10px;
      overflow: auto;
      border-radius: 9px;
      background: color-mix(in srgb, #000000 19%, transparent);
    }
    #consilium-chat-archive .markdown-body pre code {
      padding: 0;
      background: transparent;
      white-space: pre;
    }
    #consilium-chat-archive .table-scroll {
      max-width: 100%;
      overflow-x: auto;
      border: 1px solid color-mix(in srgb, currentColor 17%, transparent);
      border-radius: 9px;
    }
    #consilium-chat-archive table {
      width: 100%;
      min-width: 380px;
      border-collapse: collapse;
      font-size: 0.8rem;
    }
    #consilium-chat-archive th,
    #consilium-chat-archive td {
      padding: 7px 8px;
      border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent);
      text-align: left;
      vertical-align: top;
    }
    @media (max-width: 520px) {
      #consilium-chat-archive .im-stack {
        width: 96%;
      }
      #consilium-chat-archive .im-meta {
        gap: 3px;
        align-items: flex-start;
        flex-direction: column;
      }
      #consilium-chat-archive .is-sent .im-meta {
        align-items: flex-end;
      }
    }
  </style>
  <section class="im-window">
    <header class="im-header">
      <h2 class="im-title">${escapeHtml(state.title)}</h2>
      <div class="im-start">Початок: ${escapeHtml(state.startLabel)}</div>
    </header>
    <div class="im-thread">
      ${emptyHtml}
      ${messageHtml}
    </div>
  </section>
</div>
`;

fs.mkdirSync(path.dirname(fragmentPath), { recursive: true });
fs.writeFileSync(liveChatPath, liveChat);
fs.writeFileSync(fragmentPath, fragment);

console.log(state.messages.length + " messages rendered");
console.log(liveChatPath);
console.log(fragmentPath);
