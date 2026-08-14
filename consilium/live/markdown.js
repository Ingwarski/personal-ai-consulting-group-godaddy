const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const safeHref = (value) => {
  const decoded = String(value).trim();
  if (/^(https?:|mailto:)/i.test(decoded)) {
    return escapeHtml(decoded);
  }
  return "";
};

const inlineMarkdown = (source) => {
  const codeSpans = [];
  const links = [];
  let value = String(source)
    .replace(/`([^`]+)`/g, (_match, code) => {
      const token = "@@CODE" + codeSpans.length + "@@";
      codeSpans.push("<code>" + escapeHtml(code) + "</code>");
      return token;
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
      const safe = safeHref(href);
      const token = "@@LINK" + links.length + "@@";
      links.push(safe
        ? '<a href="' + safe + '" target="_blank" rel="noreferrer">' + escapeHtml(label) + "</a>"
        : escapeHtml(label));
      return token;
    });

  value = escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>");

  codeSpans.forEach((html, index) => {
    value = value.replace("@@CODE" + index + "@@", html);
  });
  links.forEach((html, index) => {
    value = value.replace("@@LINK" + index + "@@", html);
  });
  return value;
};

const splitTableRow = (line) => line
  .trim()
  .replace(/^\|/, "")
  .replace(/\|$/, "")
  .split("|")
  .map((cell) => cell.trim());

const isTableDivider = (line) => {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};

const renderTable = (lines) => {
  const header = splitTableRow(lines[0]);
  const rows = lines.slice(2).map(splitTableRow);
  const head = "<thead><tr>" + header.map((cell) => "<th>" + inlineMarkdown(cell) + "</th>").join("") + "</tr></thead>";
  const body = "<tbody>" + rows.map((row) => (
    "<tr>" + header.map((_cell, index) => "<td>" + inlineMarkdown(row[index] || "") + "</td>").join("") + "</tr>"
  )).join("") + "</tbody>";
  return '<div class="table-scroll"><table>' + head + body + "</table></div>";
};

export function renderMarkdown(source) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^\s*```/.test(line)) {
      const language = line.trim().slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += index < lines.length ? 1 : 0;
      const className = language ? ' class="language-' + escapeHtml(language) + '"' : "";
      html.push("<pre><code" + className + ">" + escapeHtml(code.join("\n")) + "</code></pre>");
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      html.push(renderTable(tableLines));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(6, Math.max(2, heading[1].length + 1));
      html.push("<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">");
      index += 1;
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      html.push("<hr />");
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }
      html.push("<ul>" + items.map((item) => "<li>" + inlineMarkdown(item) + "</li>").join("") + "</ul>");
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
      }
      html.push("<ol>" + items.map((item) => "<li>" + inlineMarkdown(item) + "</li>").join("") + "</ol>");
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      html.push("<blockquote>" + quote.map(inlineMarkdown).join("<br />") + "</blockquote>");
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?|```)/.test(lines[index]) &&
      !(lines[index].includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1]))
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push("<p>" + paragraph.map(inlineMarkdown).join("<br />") + "</p>");
  }

  return html.join("\n");
}

export { escapeHtml };
