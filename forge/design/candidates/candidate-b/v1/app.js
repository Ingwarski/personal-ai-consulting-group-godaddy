(function () {
  "use strict";

  const EXPECTED_FIXTURE_SHA256 =
    "96732f738a41bf1f838736de77a748ef65704d68010553bbf43638f83ddd1af6";
  const EXPECTED_BODY_SHA256 =
    "ddf71722bcb4d5a2e0a56a64a4f6f0160d99d276f75590afd263e10371e76cfa";
  const FIXTURE_URL =
    "../../../candidate-sets/whatsapp-consultant/v1/shared/scenario-fixture.js";

  const STATE_LABELS = Object.freeze({
    active: "Активний консиліум",
    permission: "Очікування окремого дозволу",
    failure: "Неповний результат",
    final: "Фінальна рекомендація",
    costs: "Витрати сесії",
    stopped: "Зупинена сесія"
  });

  const SYSTEM_LABELS = Object.freeze({
    "session-acknowledgement": "Головний консультант",
    "consilium-roster": "Головний консультант",
    "progress-wait": "Головний консультант",
    "continuation-permission": "Головний консультант",
    "failure-partial": "Головний консультант",
    "costs-response": "Personal Consultant",
    "stop-acknowledgement": "Personal Consultant",
    "new-task-acknowledgement": "Personal Consultant",
    "final-conclusion": "Головний консультант",
    "final-actions": "Головний консультант",
    "final-risk-review": "Головний консультант",
    "final-technical-part": "Головний консультант"
  });

  const OWNER_IDS = new Set([
    "owner-request",
    "owner-costs-command",
    "owner-stop-command",
    "owner-new-task-command"
  ]);

  const CLASS_BY_ID = Object.freeze({
    "progress-wait": "progress",
    "continuation-permission": "permission",
    "failure-partial": "failure",
    "stop-acknowledgement": "stopped",
    "final-conclusion": "final",
    "final-actions": "final",
    "final-risk-review": "final",
    "final-technical-part": "final"
  });

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderInline(value) {
    return escapeHtml(value)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function renderMarkdown(source) {
    const blocks = String(source).split(/\n\n+/);
    return blocks
      .map(function (block) {
        const lines = block.split("\n");
        const bulletItems = lines
          .map(function (line) {
            return line.match(/^(?:[-*]|•)\s+(.*)$/);
          });
        const ordered = block.match(/^(\d+)\.\s+([\s\S]*)$/);

        if (bulletItems.every(Boolean)) {
          return (
            "<ul>" +
            bulletItems
              .map(function (match) {
                return "<li>" + renderInline(match[1]) + "</li>";
              })
              .join("") +
            "</ul>"
          );
        }

        if (ordered) {
          return (
            '<ol start="' +
            ordered[1] +
            '"><li value="' +
            ordered[1] +
            '">' +
            renderInline(ordered[2]).replaceAll("\n", "<br>") +
            "</li></ol>"
          );
        }

        if (lines.every(function (line) { return /^>\s?/.test(line); })) {
          return (
            "<blockquote>" +
            lines
              .map(function (line) {
                return renderInline(line.replace(/^>\s?/, ""));
              })
              .join("<br>") +
            "</blockquote>"
          );
        }

        return "<p>" + lines.map(renderInline).join("<br>") + "</p>";
      })
      .join("");
  }

  function contentEntries(scenario) {
    const entries = new Map();
    scenario.agentMessages.forEach(function (message) {
      entries.set(message.id, Object.assign({ kind: "agent" }, message));
    });
    Object.keys(scenario.content).forEach(function (key) {
      const item = scenario.content[key];
      if (item && item.id) {
        entries.set(item.id, Object.assign({ kind: "content" }, item));
      }
    });
    return entries;
  }

  function messageClass(item) {
    if (OWNER_IDS.has(item.id)) {
      return "owner";
    }
    if (item.kind === "agent") {
      return "agent";
    }
    return "system " + (CLASS_BY_ID[item.id] || "");
  }

  function createMeta(item) {
    const meta = document.createElement("div");
    meta.className = "message-meta";

    if (item.kind === "agent") {
      const provenance = document.createElement("span");
      provenance.className = "provenance-label";
      provenance.textContent = "Підтверджена репліка";
      meta.append(provenance);

      const role = document.createElement("strong");
      role.textContent = item.role;
      meta.append(role);
    } else {
      const label = document.createElement("strong");
      label.textContent = OWNER_IDS.has(item.id)
        ? "Ви"
        : SYSTEM_LABELS[item.id] || "Personal Consultant";
      meta.append(label);
    }

    const separator = document.createElement("span");
    separator.setAttribute("aria-hidden", "true");
    separator.textContent = "·";
    meta.append(separator);

    const time = document.createElement("time");
    time.textContent = item.time || "";
    meta.append(time);

    return meta;
  }

  function createMessage(item) {
    const listItem = document.createElement("li");
    listItem.className = "message-item " + messageClass(item);

    const article = document.createElement("article");
    article.className = "message";
    article.append(createMeta(item));

    if (item.kind === "agent" && item.addressedTo) {
      const addressed = document.createElement("p");
      addressed.className = "address-line";
      addressed.textContent = "Адресовано: " + item.addressedTo;
      article.append(addressed);
    }

    const body = document.createElement("div");
    body.className = "markdown-body";
    const source = item.kind === "agent" ? item.body : item.text;
    body.innerHTML = renderMarkdown(source);
    article.append(body);

    listItem.append(article);
    return listItem;
  }

  function bytesToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(function (byte) {
        return byte.toString(16).padStart(2, "0");
      })
      .join("");
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    return bytesToHex(await window.crypto.subtle.digest("SHA-256", bytes));
  }

  async function verifyFixture(scenario) {
    const status = document.getElementById("fixture-integrity");
    try {
      const bodySource = scenario.agentMessages
        .map(function (message) {
          return message.body;
        })
        .join("");
      const bodyHash = await sha256(bodySource);
      const fixtureSource = await fetch(FIXTURE_URL).then(function (response) {
        if (!response.ok) {
          throw new Error("fixture unavailable");
        }
        return response.text();
      });
      const fixtureHash = await sha256(fixtureSource);
      const contractIsFrozen =
        Object.isFrozen(scenario) &&
        scenario.agentMessages.every(function (message) {
          return (
            Object.isFrozen(message) &&
            message.bodyContract.verbatim === true &&
            message.bodyContract.immutable === true &&
            message.bodyContract.normalization === "none"
          );
        });
      const passed =
        bodyHash === EXPECTED_BODY_SHA256 &&
        fixtureHash === EXPECTED_FIXTURE_SHA256 &&
        contractIsFrozen;

      status.dataset.status = passed ? "passed" : "failed";
      status.textContent = passed
        ? "Пройдено: fixture і всі agent bodies збігаються з frozen hashes."
        : "Не пройдено: fixture або body contract відрізняється від frozen source.";
    } catch (_error) {
      status.dataset.status = "failed";
      status.textContent =
        "Не вдалося перевірити hashes у цьому режимі відкриття. Запустіть prototype через HTTP route.";
    }
  }

  function currentState(scenario) {
    const requested = new URLSearchParams(window.location.search).get("state");
    return Object.prototype.hasOwnProperty.call(scenario.expectedViews, requested)
      ? requested
      : "active";
  }

  function renderScenario(scenario) {
    const state = currentState(scenario);
    const view = scenario.expectedViews[state];
    const entries = contentEntries(scenario);
    const stream = document.getElementById("message-stream");

    document.getElementById("state-title").textContent = STATE_LABELS[state];
    document.title =
      "Candidate B — " + STATE_LABELS[state] + " — Дослівний консиліум";

    document.querySelectorAll("[data-state-link]").forEach(function (link) {
      if (link.dataset.stateLink === state) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });

    view.messageIds.forEach(function (id) {
      const item = entries.get(id);
      if (!item) {
        return;
      }
      stream.append(createMessage(item));
    });

    verifyFixture(scenario);
  }

  const scenario = window.PC_SCENARIO_V1;
  if (!scenario) {
    document.getElementById("fixture-integrity").dataset.status = "failed";
    document.getElementById("fixture-integrity").textContent =
      "Frozen fixture не завантажено.";
    return;
  }

  renderScenario(scenario);
})();
