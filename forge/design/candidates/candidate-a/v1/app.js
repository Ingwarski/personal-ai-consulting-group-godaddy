(function () {
  "use strict";

  const scenario = window.PC_SCENARIO_V1;
  const transcript = document.querySelector("#transcript");
  const stateLinks = document.querySelector("#state-links");
  if (!scenario || !transcript || !stateLinks) {
    document.documentElement.dataset.ready = "error";
    throw new Error("Candidate A could not load its frozen scenario fixture.");
  }

  const stateLabels = Object.freeze({
    active: "Активна",
    permission: "Дозвіл",
    failure: "Неповний результат",
    final: "Фінал",
    costs: "Витрати",
    stopped: "Зупинено"
  });

  const allowedStates = Object.freeze(Object.keys(stateLabels));
  const requestedState = new URLSearchParams(window.location.search).get("state") || "active";
  const currentState = allowedStates.includes(requestedState) ? requestedState : "active";
  const currentView = scenario.expectedViews[currentState];

  const contentById = new Map(
    Object.values(scenario.content).map((item) => [item.id, Object.freeze({ ...item, sourceType: "content" })])
  );

  scenario.agentMessages.forEach((message) => {
    contentById.set(message.id, Object.freeze({ ...message, sourceType: "agent" }));
  });

  const appendInlineMarkdown = (container, source) => {
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
    let cursor = 0;

    source.replace(pattern, (token, _capture, offset) => {
      container.append(document.createTextNode(source.slice(cursor, offset)));

      if (token.startsWith("**")) {
        const strong = document.createElement("strong");
        strong.textContent = token.slice(2, -2);
        container.append(strong);
      } else if (token.startsWith("`")) {
        const code = document.createElement("code");
        code.textContent = token.slice(1, -1);
        container.append(code);
      } else {
        const emphasis = document.createElement("em");
        emphasis.textContent = token.slice(1, -1);
        container.append(emphasis);
      }

      cursor = offset + token.length;
      return token;
    });

    container.append(document.createTextNode(source.slice(cursor)));
  };

  const appendParagraph = (container, block, signalFirst) => {
    const paragraph = document.createElement("p");
    if (signalFirst) paragraph.className = "signal-line";

    block.split("\n").forEach((line, index) => {
      if (index > 0) paragraph.append(document.createElement("br"));
      appendInlineMarkdown(paragraph, line);
    });

    container.append(paragraph);
  };

  const appendList = (container, lines, ordered) => {
    const list = document.createElement(ordered ? "ol" : "ul");
    if (ordered) {
      const firstNumber = Number(lines[0].match(/^(\d+)\./)?.[1] || 1);
      list.start = firstNumber;
    }

    lines.forEach((line) => {
      const item = document.createElement("li");
      const text = ordered ? line.replace(/^\d+\.\s*/, "") : line.replace(/^[•-]\s*/, "");
      appendInlineMarkdown(item, text);
      list.append(item);
    });

    container.append(list);
  };

  const renderMarkdown = (source, options = {}) => {
    const container = document.createElement("div");
    container.className = "message-copy";

    const blocks = source.split(/\n{2,}/);
    blocks.forEach((block, index) => {
      const lines = block.split("\n");
      const unordered = lines.every((line) => /^[•-]\s+/.test(line));
      const ordered = lines.every((line) => /^\d+\.\s+/.test(line));

      if (unordered || ordered) {
        appendList(container, lines, ordered);
        return;
      }

      if (/^```[\s\S]*```$/.test(block)) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
        pre.append(code);
        container.append(pre);
        return;
      }

      appendParagraph(container, block, Boolean(options.signalFirst && index === 0));
    });

    return container;
  };

  const isOwnerMessage = (message) =>
    message.id === "owner-request" ||
    message.id === "owner-costs-command" ||
    message.id === "owner-stop-command" ||
    message.id === "owner-new-task-command";

  const isFinalMessage = (message) => message.id.startsWith("final-");

  const renderMessage = (message) => {
    const owner = isOwnerMessage(message);
    const row = document.createElement("div");
    row.className = `message-row ${owner ? "message-row--owner" : "message-row--incoming"}`;
    if (isFinalMessage(message)) row.classList.add("message-row--final");

    const article = document.createElement("article");
    article.className = "message";
    article.dataset.evidenceId = message.id;
    article.dataset.mg = Array.isArray(message.mg) ? message.mg.join(" ") : message.mg;
    article.dataset.ss = Array.isArray(message.ss) ? message.ss.join(" ") : message.ss;

    if (message.sourceType === "agent") {
      const identity = document.createElement("header");
      identity.className = "role-time";

      const role = document.createElement("strong");
      role.textContent = message.role;
      const separator = document.createTextNode(" · ");
      const time = document.createElement("time");
      time.dateTime = `2026-08-15T${message.time}:00+03:00`;
      time.textContent = message.time;

      identity.append(role, separator, time);
      article.append(identity);

      const body = renderMarkdown(message.body);
      body.dataset.verbatimBody = "true";
      Object.defineProperty(body, "verbatimSource", {
        value: message.body,
        writable: false,
        configurable: false,
        enumerable: false
      });
      article.append(body);
    } else {
      article.append(renderMarkdown(message.text, { signalFirst: !owner }));

      if (message.time) {
        const time = document.createElement("time");
        time.className = "message-time";
        time.dateTime = `2026-08-15T${message.time}:00+03:00`;
        time.textContent = message.time;
        article.append(time);
      }
    }

    row.append(article);
    return row;
  };

  const renderStateLinks = () => {
    allowedStates.forEach((state) => {
      const link = document.createElement("a");
      link.className = "state-link";
      link.href = `?state=${encodeURIComponent(state)}`;
      link.textContent = stateLabels[state];
      if (state === currentState) link.setAttribute("aria-current", "page");
      stateLinks.append(link);
    });
  };

  const renderTranscript = () => {
    const fragment = document.createDocumentFragment();

    currentView.messageIds.forEach((id) => {
      const message = contentById.get(id);
      if (!message) throw new Error(`Missing frozen fixture message: ${id}`);
      fragment.append(renderMessage(message));
    });

    transcript.replaceChildren(fragment);
  };

  const focusLatestOutcome = () => {
    const preferredId =
      currentState === "final" ? "final-conclusion" : currentView.messageIds.at(-1);
    const preferred = transcript.querySelector(`[data-evidence-id="${preferredId}"]`);

    window.requestAnimationFrame(() => {
      if (preferred) {
        const transcriptTop = transcript.getBoundingClientRect().top;
        const messageTop = preferred.getBoundingClientRect().top;
        transcript.scrollTop += messageTop - transcriptTop - 12;
      } else {
        transcript.scrollTop = transcript.scrollHeight;
      }
    });
  };

  renderStateLinks();
  renderTranscript();

  window.PC_CANDIDATE_A_V1 = Object.freeze({
    candidate: "A",
    version: "v1",
    status: "proposed",
    direction: "Рішення спочатку",
    state: currentState,
    route: `${window.location.pathname}?state=${currentState}`,
    renderedMessageIds: Object.freeze(currentView.messageIds),
    frozenAgentBodies: Object.freeze(scenario.agentMessages.map((message) => message.body))
  });

  document.body.dataset.state = currentState;
  document.title = `Candidate A · ${stateLabels[currentState]} · Рішення спочатку`;
  document.documentElement.dataset.ready = "true";
  focusLatestOutcome();
})();
