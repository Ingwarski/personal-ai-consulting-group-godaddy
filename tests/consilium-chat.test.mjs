import test from "node:test";
import assert from "node:assert/strict";
import { parseChatSource, visibleRole } from "../scripts/consilium-chat-lib.mjs";
import { renderMarkdown } from "../consilium/live/markdown.js";

const sampleChat = `# Дослівний чат консиліуму

- ID сесії: \`2026-08-14-1900-test\`
- Відкрито: \`2026-08-14T19:00:00+0300\`

### M000001

- Час: \`2026-08-14T19:00:07+0300\`
- Відправник: Головний консультант \`/root\`
- Одержувач: Фінансовий консультант \`/root/finance\`

<!-- BEGIN VERBATIM MESSAGE M000001 -->
## Висновок

- Перший пункт

| Метрика | Значення |
|---|---:|
| Оплати | 2 |
<!-- END VERBATIM MESSAGE M000001 -->`;

test("chat parser keeps the verbatim body and exposes only business roles", () => {
  const state = parseChatSource(sampleChat);

  assert.equal(state.sessionId, "2026-08-14-1900-test");
  assert.equal(state.startLabel, "14.08.2026, 19:00");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].sender, "Головний консультант");
  assert.equal(state.messages[0].recipient, "Фінансовий консультант");
  assert.match(state.messages[0].body, /^## Висновок/);
});

test("Markdown becomes semantic chat content instead of raw markers", () => {
  const html = renderMarkdown(parseChatSource(sampleChat).messages[0].body);

  assert.match(html, /<h3>Висновок<\/h3>/);
  assert.match(html, /<ul><li>Перший пункт<\/li><\/ul>/);
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /## Висновок/);
});

test("unsafe HTML and links never execute", () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> [небезпечно](javascript:alert(1))');

  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /href=/);
  assert.doesNotMatch(html, /javascript:/);
});

test("role cleanup removes technical agent identifiers", () => {
  assert.equal(visibleRole("Growth-маркетолог `/root/growth_marketing`"), "Growth-маркетолог");
});
