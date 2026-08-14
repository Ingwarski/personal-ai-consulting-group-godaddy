import { renderMarkdown } from "./markdown.js";

const titleNode = document.querySelector("#chatTitle");
const startNode = document.querySelector("#chatStart");
const threadNode = document.querySelector("#chatThread");
const emptyNode = document.querySelector("#emptyState");
const connectionNode = document.querySelector("#connectionState");
const connectionLabel = document.querySelector("#connectionLabel");
const soundButton = document.querySelector("#soundButton");
const newMessagesButton = document.querySelector("#newMessagesButton");

let currentState = null;
let renderedIds = [];
let soundEnabled = false;
let audioContext = null;
let unseenCount = 0;
let pendingState = null;
let applyingState = false;

const isNearBottom = () => (
  window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120
);

const scrollToBottom = (behavior = "smooth") => {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  unseenCount = 0;
  newMessagesButton.hidden = true;
};

const updateNewMessagesButton = () => {
  if (!unseenCount) {
    newMessagesButton.hidden = true;
    return;
  }
  newMessagesButton.textContent = unseenCount === 1
    ? "1 нове повідомлення"
    : unseenCount + " нових повідомлень";
  newMessagesButton.hidden = false;
};

const setConnection = (mode, label) => {
  connectionNode.classList.toggle("is-live", mode === "live");
  connectionNode.classList.toggle("is-offline", mode === "offline");
  connectionLabel.textContent = label;
};

const makeWhoosh = () => {
  if (!soundEnabled) return;
  audioContext ||= new AudioContext();
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }

  const duration = 0.32;
  const sampleRate = audioContext.sampleRate;
  const buffer = audioContext.createBuffer(1, sampleRate * duration, sampleRate);
  const data = buffer.getChannelData(0);

  for (let index = 0; index < data.length; index += 1) {
    const progress = index / data.length;
    const envelope = Math.sin(Math.PI * progress) * (1 - progress * 0.35);
    data[index] = (Math.random() * 2 - 1) * envelope;
  }

  const source = audioContext.createBufferSource();
  const filter = audioContext.createBiquadFilter();
  const gain = audioContext.createGain();
  const now = audioContext.currentTime;

  source.buffer = buffer;
  filter.type = "bandpass";
  filter.Q.value = 0.7;
  filter.frequency.setValueAtTime(1500, now);
  filter.frequency.exponentialRampToValueAtTime(480, now + duration);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.035);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  source.connect(filter).connect(gain).connect(audioContext.destination);
  source.start(now);
  source.stop(now + duration);
};

const setSoundEnabled = async (enabled) => {
  soundEnabled = enabled;
  soundButton.setAttribute("aria-pressed", String(enabled));
  soundButton.firstElementChild.textContent = enabled ? "🔊" : "🔇";
  if (enabled) {
    audioContext ||= new AudioContext();
    await audioContext.resume();
    makeWhoosh();
  }
};

soundButton.addEventListener("click", () => {
  setSoundEnabled(!soundEnabled);
});

newMessagesButton.addEventListener("click", () => scrollToBottom());

const createMessage = (message, animate) => {
  const article = document.createElement("article");
  const sent = message.sender === "Головний консультант";
  article.className = "message " + (sent ? "is-sent" : "is-received") + (animate ? " is-new" : "");
  article.dataset.messageId = message.id;
  article.setAttribute(
    "aria-label",
    message.sender + " до " + message.recipient + " о " + message.timestamp.slice(11, 16),
  );

  const stack = document.createElement("div");
  stack.className = "message__stack";

  const meta = document.createElement("div");
  meta.className = "message__meta";

  const role = document.createElement("span");
  role.className = "message__role";
  role.textContent = message.sender + " → " + message.recipient;

  const time = document.createElement("time");
  time.dateTime = message.timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  time.textContent = message.timestamp.slice(11, 16);

  const bubble = document.createElement("div");
  bubble.className = "message__bubble";

  const body = document.createElement("div");
  body.className = "markdown-body";
  body.innerHTML = renderMarkdown(message.body);

  meta.append(role, time);
  bubble.append(body);
  stack.append(meta, bubble);
  article.append(stack);
  return article;
};

const replaceAllMessages = (state) => {
  const fragment = document.createDocumentFragment();
  state.messages.forEach((message) => fragment.append(createMessage(message, false)));
  threadNode.replaceChildren(fragment);
  renderedIds = state.messages.map((message) => message.id);

  if (!state.messages.length) {
    threadNode.append(emptyNode);
    emptyNode.hidden = false;
  }
  requestAnimationFrame(() => scrollToBottom("auto"));
};

const appendMessages = async (messages) => {
  const shouldFollow = isNearBottom();
  emptyNode.hidden = true;

  for (const message of messages) {
    threadNode.append(createMessage(message, true));
    renderedIds.push(message.id);
    if (shouldFollow) {
      scrollToBottom("smooth");
    } else {
      unseenCount += 1;
      updateNewMessagesButton();
    }
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
  makeWhoosh();
};

const applyState = async (state) => {
  titleNode.textContent = state.title || "Консиліум";
  startNode.textContent = state.startLabel ? "Початок: " + state.startLabel : "Початок не вказано";
  document.title = (state.title || "Консиліум") + " · наживо";

  const nextIds = state.messages.map((message) => message.id);
  const prefixMatches = renderedIds.every((id, index) => nextIds[index] === id);

  if (!currentState || !prefixMatches || nextIds.length < renderedIds.length) {
    replaceAllMessages(state);
  } else if (nextIds.length > renderedIds.length) {
    await appendMessages(state.messages.slice(renderedIds.length));
  }

  currentState = state;
  const isClosed = /закрит/i.test(state.status);
  setConnection("live", isClosed ? "Архів синхронізовано" : "Наживо");
};

const queueState = async (state) => {
  pendingState = state;
  if (applyingState) return;

  applyingState = true;
  try {
    while (pendingState) {
      const nextState = pendingState;
      pendingState = null;
      await applyState(nextState);
    }
  } finally {
    applyingState = false;
  }
};

const eventSource = new EventSource("/events");

eventSource.addEventListener("state", (event) => {
  queueState(JSON.parse(event.data));
});

eventSource.addEventListener("open", () => {
  setConnection("live", "Наживо");
});

eventSource.addEventListener("error", () => {
  setConnection("offline", "Відновлення зв’язку");
});

window.addEventListener("offline", () => setConnection("offline", "Немає мережі"));
window.addEventListener("online", () => setConnection("live", "Відновлено"));
