(function () {
  "use strict";

  const fixture = window.PC_SCENARIO_V1;
  const allowedStates = ["active", "permission", "failure", "final", "costs", "stopped"];
  const stateLabels = {
    active: "Активна сесія",
    permission: "Потрібен дозвіл",
    failure: "Неповний результат",
    final: "Фінальна рекомендація",
    costs: "Витрати",
    stopped: "Сесію зупинено"
  };

  const messageList = document.getElementById("message-list");
  const conversation = document.querySelector(".conversation");
  const conversationTitle = document.getElementById("conversation-title");

  const queryState = new URLSearchParams(window.location.search).get("state");
  const currentState = allowedStates.includes(queryState) ? queryState : "active";

  document.documentElement.dataset.prototypeState = currentState;
  document.title = `${stateLabels[currentState]} · Candidate C`;
  conversationTitle.textContent = `Сценарій: ${fixture ? fixture.title : "fixture недоступний"}. Стан: ${stateLabels[currentState]}.`;

  document.querySelectorAll("[data-state-link]").forEach((link) => {
    if (link.dataset.stateLink === currentState) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

  if (!fixture) {
    renderFixtureError();
    return;
  }

  const agentMessagesById = new Map(fixture.agentMessages.map((message) => [message.id, message]));
  const contentMessagesById = new Map(
    Object.values(fixture.content)
      .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string")
      .map((entry) => [entry.id, entry])
  );

  const activeView = fixture.expectedViews[currentState];
  const renderedMessagesById = new Map();
  const resolvedMessages = activeView.messageIds.map((id) => {
    return agentMessagesById.get(id) || contentMessagesById.get(id);
  });

  resolvedMessages.forEach((message) => {
    if (!message) {
      return;
    }

    const messageElement = createMessageElement(message, agentMessagesById.has(message.id));
    renderedMessagesById.set(message.id, messageElement);
    messageList.append(messageElement);
  });

  revealCriticalState();

  function revealCriticalState() {
    const criticalMessageByState = {
      permission: "continuation-permission",
      failure: "failure-partial",
      final: "final-conclusion",
      stopped: "stop-acknowledgement"
    };
    const target = renderedMessagesById.get(criticalMessageByState[currentState]);

    window.requestAnimationFrame(() => {
      window.scrollTo(0, 0);

      if (!target) {
        return;
      }

      const targetTop = target.getBoundingClientRect().top - conversation.getBoundingClientRect().top + conversation.scrollTop;
      conversation.scrollTop = Math.max(0, targetTop - 52);
    });
  }

  function createMessageElement(message, isAgent) {
    const listItem = document.createElement("li");
    const article = document.createElement("article");
    const body = document.createElement("div");
    const classification = classifyMessage(message, isAgent);

    listItem.className = `message ${classification.classes.join(" ")}`;
    article.className = "message-bubble";
    article.setAttribute("aria-label", classification.ariaLabel);
    body.className = "markdown-body";

    if (isAgent) {
      const header = document.createElement("header");
      const role = document.createElement("strong");
      const separator = document.createElement("span");
      const time = document.createElement("time");

      header.className = "role-time";
      role.textContent = message.role;
      separator.textContent = "·";
      separator.setAttribute("aria-hidden", "true");
      time.textContent = message.time;
      time.dateTime = `2026-08-15T${message.time}:00+03:00`;

      header.append(role, separator, time);
      article.append(header);
    }

    const sourceText = isAgent ? message.body : message.text;
    body.append(renderMarkdown(sourceText));

    if (classification.emphasizeFirst) {
      body.firstElementChild?.classList.add("signal-line");
    }

    if (classification.emphasizeLast && body.childElementCount > 1) {
      body.lastElementChild?.classList.add("consequence-line");
    }

    article.append(body);

    if (!isAgent && message.time) {
      const time = document.createElement("time");
      time.className = "message-time";
      time.textContent = message.time;
      time.dateTime = `2026-08-15T${message.time}:00+03:00`;
      article.append(time);
    }

    listItem.append(article);
    return listItem;
  }

  function classifyMessage(message, isAgent) {
    if (isAgent) {
      return {
        classes: ["message--agent"],
        ariaLabel: `Репліка агента: ${message.role}, ${message.time}`,
        emphasizeFirst: false,
        emphasizeLast: false
      };
    }

    const ownerIds = new Set(["owner-request", "owner-costs-command", "owner-stop-command", "owner-new-task-command"]);
    const base = ownerIds.has(message.id) ? ["message--owner"] : ["message--system"];
    const result = {
      classes: base,
      ariaLabel: ownerIds.has(message.id) ? `Повідомлення Власника, ${message.time}` : `Повідомлення Personal Consultant, ${message.time || "без часу"}`,
      emphasizeFirst: !ownerIds.has(message.id),
      emphasizeLast: false
    };

    if (message.id === "continuation-permission") {
      result.classes.push("message--permission");
      result.emphasizeLast = true;
      result.ariaLabel = `Потрібен окремий дозвіл, ${message.time}`;
    } else if (message.id === "failure-partial") {
      result.classes.push("message--failure");
      result.emphasizeLast = true;
      result.ariaLabel = `Неповний результат, ${message.time}`;
    } else if (message.id === "stop-acknowledgement") {
      result.classes.push("message--stopped");
      result.emphasizeLast = true;
      result.ariaLabel = `Сесію зупинено, ${message.time}`;
    } else if (message.id === "final-risk-review") {
      result.classes.push("message--risk");
      result.emphasizeLast = true;
    } else if (message.id === "costs-response") {
      result.classes.push("message--costs");
    } else if (message.id.startsWith("final-")) {
      result.classes.push("message--final");
    }

    return result;
  }

  function renderMarkdown(source) {
    const fragment = document.createDocumentFragment();
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];

      if (!line.trim()) {
        index += 1;
        continue;
      }

      if (line.startsWith("```")) {
        const codeLines = [];
        index += 1;
        while (index < lines.length && !lines[index].startsWith("```")) {
          codeLines.push(lines[index]);
          index += 1;
        }
        index += index < lines.length ? 1 : 0;
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = codeLines.join("\n");
        pre.append(code);
        fragment.append(pre);
        continue;
      }

      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const element = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
        element.append(renderInlineMarkdown(heading[2]));
        fragment.append(element);
        index += 1;
        continue;
      }

      const unordered = line.match(/^\s*(?:[-*+]\s+|•\s*)(.+)$/);
      const ordered = line.match(/^\s*(\d+)\.\s+(.+)$/);
      if (unordered || ordered) {
        const list = document.createElement(ordered ? "ol" : "ul");
        if (ordered && Number(ordered[1]) !== 1) {
          list.start = Number(ordered[1]);
        }
        const item = document.createElement("li");
        item.append(renderInlineMarkdown((ordered && ordered[2]) || (unordered && unordered[1])));
        list.append(item);
        fragment.append(list);
        index += 1;
        continue;
      }

      if (line.startsWith("> ")) {
        const quote = document.createElement("blockquote");
        quote.append(renderInlineMarkdown(line.slice(2)));
        fragment.append(quote);
        index += 1;
        continue;
      }

      const paragraphLines = [line];
      index += 1;
      while (index < lines.length && lines[index].trim()) {
        if (/^(?:#{1,3}\s|```|\s*(?:[-*+]\s+|•\s*)|\s*\d+\.\s+|>\s)/.test(lines[index])) {
          break;
        }
        paragraphLines.push(lines[index]);
        index += 1;
      }
      const paragraph = document.createElement("p");
      paragraph.append(renderInlineMarkdown(paragraphLines.join(" ")));
      fragment.append(paragraph);
    }

    return fragment;
  }

  function renderInlineMarkdown(source) {
    const template = document.createElement("template");
    const safe = escapeHtml(source)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
    template.innerHTML = safe;
    return template.content;
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderFixtureError() {
    const item = document.createElement("li");
    const article = document.createElement("article");
    item.className = "message message--system message--failure";
    article.className = "message-bubble";
    article.innerHTML = '<div class="markdown-body"><p class="signal-line">Fixture недоступний</p><p class="consequence-line">Прототип не показує сценарій і не заявляє успішний стан.</p></div>';
    item.append(article);
    messageList.append(item);
  }
})();
