// Technova AI — client. Talks to the API in server.js.

const $ = (id) => document.getElementById(id);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

const state = {
  user: null,
  model: localStorage.getItem("technova.model") || "Technova 1.0 Flash",
  models: [],
  conversations: [],
  activeId: null,
  renamingId: null,
  attachments: [],
  search: localStorage.getItem("technova.search") === "1",
  deep: localStorage.getItem("technova.deep") === "1",
  sources: [],
  editing: null,
  messages: [],
  busy: false,
  controller: null,
  runId: 0,
  locked: false,
};

/* ---------------- api ---------------- */
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------- markdown-lite ---------------- */
const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const inline = (s) =>
  escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");

function renderMarkdown(text) {
  const parts = [];
  const fence = /```([\s\S]*?)```/g;
  let last = 0, match;
  while ((match = fence.exec(text))) {
    if (match.index > last) parts.push({ type: "text", body: text.slice(last, match.index) });
    const block = match[1].replace(/^\n+|\n+$/g, "");
    const nl = block.indexOf("\n");
    parts.push({ type: "code", head: nl > -1 ? block.slice(0, nl) : "", body: nl > -1 ? block.slice(nl + 1) : block });
    last = fence.lastIndex;
  }
  if (last < text.length) parts.push({ type: "text", body: text.slice(last) });

  return parts
    .map((part) => {
      if (part.type === "code") {
        const code = escapeHtml(part.body)
          .replace(/\b(from|import|as|def|return|print|const|let|function|await|async|export)\b/g, '<span class="k">$1</span>')
          .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, '<span class="s">$1</span>');
        return `<div class="code"><div class="code__bar"><span>${escapeHtml(part.head || "code")}</span>` +
          `<button type="button" data-copy-code>Copy</button></div><pre>${code}</pre></div>`;
      }
      return textBlock(part.body);
    })
    .join("");
}

function textBlock(text) {
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const flushList = () => {
    if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; }
  };
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const bullet = line.match(/^\s*[-•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(bullet ? bullet[1] : numbered[1]);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return out.join("");
}

/* ---------------- small ui bits ---------------- */
let toastTimer;
function toast(msg) {
  const node = $("toast");
  node.textContent = msg;
  node.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("on"), 1800);
}

function scrollDown(force) {
  const thread = $("thread");
  if (state.locked && !force) return;
  requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
}

function setStatus(text) { $("status").textContent = text; }

function setBusy(busy) {
  state.busy = busy;
  $("send").hidden = busy;
  $("stop").hidden = !busy;
  $("send").disabled = busy || !$("input").value.trim();
  setStatus(busy ? "Generating…" : "Technova AI can make mistakes. Check important info.");
}

/* ---------------- auth ---------------- */
let authMode = "login";

function showAuth(message) {
  $("app").hidden = true;
  $("auth").hidden = false;
  $("authError").textContent = message || "";
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  $("authTitle").textContent = signup ? "Create your account" : "Welcome back";
  $("authSub").textContent = signup ? "Your conversations are saved to this account." : "Sign in to pick up where you left off.";
  $("nameField").hidden = !signup;
  $("authSubmit").textContent = signup ? "Create account" : "Sign in";
  $("authSwitchText").textContent = signup ? "Already have an account?" : "New here?";
  $("authSwitch").textContent = signup ? "Sign in" : "Create an account";
  $("authPassword").setAttribute("autocomplete", signup ? "new-password" : "current-password");
  $("authError").textContent = "";
}

$("authSwitch").addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));

$("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("authSubmit");
  button.disabled = true;
  $("authError").textContent = "";
  try {
    const payload = {
      email: $("authEmail").value.trim(),
      password: $("authPassword").value,
    };
    if (authMode === "signup") payload.name = $("authName").value.trim();
    const result = await api(`/api/auth/${authMode}`, { method: "POST", body: payload });
    state.user = result.user;
    $("authForm").reset();
    await enterApp();
  } catch (err) {
    $("authError").textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$("userRow").addEventListener("click", () => { $("userMenu").hidden = !$("userMenu").hidden; });
$("logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  state.user = null;
  state.conversations = [];
  state.activeId = null;
  state.messages = [];
  $("userMenu").hidden = true;
  showAuth("");
  setAuthMode("login");
});

/* ---------------- conversations ---------------- */
function renderChatList() {
  const query = $("chatSearch").value.trim().toLowerCase();
  const list = $("chatList");
  list.innerHTML = "";
  const shown = state.conversations.filter((c) => !query || c.title.toLowerCase().includes(query));
  if (!shown.length) {
    const empty = el("div", "chats__label");
    empty.textContent = state.conversations.length ? "No chats match that." : "No chats yet.";
    list.appendChild(empty);
    return;
  }
  for (const conversation of shown) {
    const item = el("button", "chat-item");
    item.setAttribute("aria-current", String(conversation.id === state.activeId));
    item.dataset.id = conversation.id;
    if (conversation.id === state.renamingId) {
      const field = el("input", "rename");
      field.value = conversation.title || "";
      field.dataset.rename = conversation.id;
      item.appendChild(field);
      list.appendChild(item);
      continue;
    }
    const label = el("span");
    label.textContent = conversation.title || "New chat";
    if (conversation.pinned) item.classList.add("pinned");
    if (conversation.shared) item.classList.add("shared");
    const pin = el("button", "pin");
    pin.dataset.pin = conversation.id;
    pin.setAttribute("aria-label", conversation.pinned ? "Unpin chat" : "Pin chat");
    pin.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 14v7"/></svg>';
    const remove = el("button", "x");
    remove.dataset.delete = conversation.id;
    remove.setAttribute("aria-label", "Delete chat");
    remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    item.append(label, pin, remove);
    list.appendChild(item);
  }
}

async function loadConversations() {
  const { conversations } = await api("/api/conversations");
  state.conversations = conversations;
  renderChatList();
}

async function openConversation(id) {
  state.runId++;
  setBusy(false);
  state.controller?.abort();
  state.activeId = id;
  renderChatList();
  closeSide();
  if (!id) {
    state.messages = [];
    renderThread();
    return;
  }
  const conversation = state.conversations.find((c) => c.id === id);
  if (conversation?.model && conversation.model !== state.model) {
    state.model = conversation.model;
    $("model").value = state.model;
    syncModelLabel();
    $("modelMark").classList.toggle("pro", /pro/i.test(state.model));
  }
  const { messages, hasMore, nextBefore } = await api(`/api/conversations/${id}/messages`);
  state.messages = messages;
  state.hasMore = Boolean(hasMore);
  state.nextBefore = nextBefore;
  renderThread();
}

async function loadEarlier() {
  if (!state.activeId || !state.nextBefore) return;
  try {
    const { messages, hasMore, nextBefore } = await api(
      `/api/conversations/${state.activeId}/messages?before=${state.nextBefore}`);
    state.messages = [...messages, ...state.messages];
    state.hasMore = Boolean(hasMore);
    state.nextBefore = nextBefore;
    const at = $("thread").scrollHeight;
    renderThread();
    $("thread").scrollTop = $("thread").scrollHeight - at; // keep the reader's place
  } catch (err) { toast(err.message); }
}

async function deleteConversation(id) {
  await api(`/api/conversations/${id}`, { method: "DELETE" });
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.activeId === id) await openConversation(null);
  renderChatList();
  toast("Chat deleted");
}

$("chatList").addEventListener("dblclick", (event) => {
  const item = event.target.closest(".chat-item");
  if (!item) return;
  state.renamingId = item.dataset.id;
  renderChatList();
  const field = document.querySelector(`[data-rename="${state.renamingId}"]`);
  if (field) { field.focus(); field.select(); }
});

$("chatList").addEventListener("keydown", (event) => {
  const field = event.target.closest("[data-rename]");
  if (!field) return;
  if (event.key === "Enter" || event.key === "Escape") {
    event.preventDefault();
    commitRename(field.dataset.rename, event.key === "Enter" ? field.value.trim() : null);
  }
});

$("chatList").addEventListener("focusout", (event) => {
  const field = event.target.closest("[data-rename]");
  if (field) commitRename(field.dataset.rename, field.value.trim());
});

async function commitRename(id, title) {
  const conversation = state.conversations.find((c) => c.id === id);
  state.renamingId = null;
  if (conversation && title && title !== conversation.title) {
    try {
      await api(`/api/conversations/${id}`, { method: "PATCH", body: { title } });
      conversation.title = title;
      toast("Renamed");
    } catch (err) { toast(err.message); }
  }
  renderChatList();
}

$("chatList").addEventListener("click", async (event) => {
  if (state.renamingId) return;
  const pin = event.target.closest("[data-pin]");
  if (pin) {
    event.stopPropagation();
    const conversation = state.conversations.find((c) => c.id === pin.dataset.pin);
    if (!conversation) return;
    const next = !conversation.pinned;
    try {
      await api(`/api/conversations/${conversation.id}`, { method: "PATCH", body: { pinned: next } });
      await loadConversations();
      toast(next ? "Pinned to the top" : "Unpinned");
    } catch (err) { toast(err.message); }
    return;
  }
  const del = event.target.closest("[data-delete]");
  if (del) { event.stopPropagation(); deleteConversation(del.dataset.delete); return; }
  const item = event.target.closest(".chat-item");
  if (item) openConversation(item.dataset.id);
});

$("chatSearch").addEventListener("input", renderChatList);
$("newChat").addEventListener("click", () => openConversation(null));
$("deleteChat").addEventListener("click", () => {
  if (!state.activeId) { toast("Nothing to delete"); return; }
  deleteConversation(state.activeId);
});

/* ---------------- thread ---------------- */
function helloHtml() {
  return `<div class="hello">
    <div class="hello__badge">∞</div>
    <h1>What can I help with?</h1>
    <p class="hello__sub">Ask a question, run a calculation, or attach a file.</p>
    <div class="hello__chips">
      <button data-ask="What models are available?">
        <span class="ico"><svg viewBox="0 0 24 24"><path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5"/><circle cx="12" cy="12" r="3.2"/></svg></span>
        <span><b>Models</b>What's available right now?</span>
      </button>
      <button data-ask="12.5% of 8400">
        <span class="ico"><svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h9M5 17h5"/><path d="M17 14l3 3M20 14l-3 3"/></svg></span>
        <span><b>Calculate</b>12.5% of 8400</span>
      </button>
      <button data-ask="convert 10 km to miles">
        <span class="ico"><svg viewBox="0 0 24 24"><path d="M4 12h16M7 8l-3 4 3 4M17 8l3 4-3 4"/></svg></span>
        <span><b>Convert</b>10 km to miles</span>
      </button>
      <button data-ask="how much do voice agents cost per minute?">
        <span class="ico"><svg viewBox="0 0 24 24"><path d="M12 3v18M8 7h8M8 17h8"/><circle cx="12" cy="12" r="9"/></svg></span>
        <span><b>Pricing</b>What do voice agents cost?</span>
      </button>
    </div>
  </div>`;
}

function renderThread() {
  const thread = $("thread");
  const host = $("threadIn");
  host.innerHTML = "";
  if (!state.messages.length) {
    thread.classList.add("thread--empty");
    host.innerHTML = helloHtml();
    return;
  }
  thread.classList.remove("thread--empty");
  if (state.hasMore) {
    const more = el("button", "loadmore");
    more.textContent = "Load earlier messages";
    more.addEventListener("click", loadEarlier);
    host.appendChild(more);
  }
  const lastAssistant = [...state.messages].reverse().find((m) => m.role === "assistant");
  const lastUser = [...state.messages].reverse().find((m) => m.role === "user");
  for (const message of state.messages) {
    host.appendChild(messageNode(message, message === lastAssistant || message === lastUser));
  }
  scrollDown(true);
}

function messageNode(message, isLast = false) {
  if (message.role === "user") {
    const wrap = el("div", "msg msg--user");
    const bubble = el("div", "msg__bubble");
    bubble.innerHTML = inline(message.text).replace(/\n/g, "<br>") + filesHtml(message.attachments);
    wrap.appendChild(bubble);
    const meta = el("div", "msg__meta");
    meta.innerHTML = (message.createdAt ? `<span class="when">${escapeHtml(relTime(message.createdAt))}</span>` : "") +
      `<span class="spacer"></span>` +
      (isLast ? iconButton(`data-edit="${message.id}"`, "Edit and resend", ICON.edit) : "") +
      iconButton("data-copy-msg", "Copy", ICON.copy);
    wrap.appendChild(meta);
    return wrap;
  }
  const wrap = el("div", "msg msg--bot");
  const body = el("div", "msg__body");
  body.innerHTML = renderMarkdown(message.text) + metaHtml(message, isLast);
  wrap.appendChild(body);
  return wrap;
}

function sizeLabel(chars) {
  const n = Number(chars) || 0;
  return n >= 1000 ? `${Math.round(n / 1000)}k chars` : `${n} chars`;
}

function filesHtml(attachments) {
  if (!attachments || !attachments.length) return "";
  const chips = attachments.map((a) => `<span>${escapeHtml(a.name)} · ${sizeLabel(a.chars)}</span>`).join("");
  return `<div class="files">${chips}</div>`;
}

function followupsHtml() {
  const ideas = [
    "Explain that more simply",
    "Give me an example",
    "What are the trade-offs?",
    "Summarise in three lines",
  ].slice(0, 3);
  return `<div class="followups">${ideas.map((i) => `<button data-ask="${escapeHtml(i)}">${escapeHtml(i)}</button>`).join("")}</div>`;
}

const ICON = {
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  speak: '<svg viewBox="0 0 24 24"><path d="M4 10v4h3l4 3V7L7 10z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/></svg>',
  regen: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4h-4"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
};

function relTime(ms) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function iconButton(attr, label, icon) {
  return `<button type="button" class="mbtn" ${attr} title="${label}" aria-label="${label}">${icon}</button>`;
}

function metaHtml(message, isLast = false) {
  const label = message.source || message.model || "Assistant";
  const when = relTime(message.createdAt);
  return `<div class="msg__meta">` +
    `<span class="src">${escapeHtml(label)}</span>` +
    (when ? `<span class="when">${escapeHtml(when)}</span>` : "") +
    `<span class="spacer"></span>` +
    iconButton("data-copy-msg", "Copy", ICON.copy) +
    iconButton("data-speak", "Read aloud", ICON.speak) +
    (isLast ? iconButton("data-regen", "Regenerate", ICON.regen) : "") +
    `</div>` + (isLast ? followupsHtml() : "");
}

/* ---------------- thinking ---------------- */
function thinkBlock(host, title = "Thinking…") {
  const box = el("div", "think");
  box.dataset.open = "true";
  box.innerHTML = `<button class="think__head" type="button"><span class="spin"></span>` +
    `<span class="think__title">${escapeHtml(title)}</span>` +
    `<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button><div class="think__body"></div>`;
  host.appendChild(box);
  const bodyEl = box.querySelector(".think__body");
  let steps = 0, rawEl = null;
  return {
    el: box,
    step(text) {
      steps++;
      const row = el("div");
      row.innerHTML = `<em>›</em><span>${escapeHtml(text)}</span>`;
      bodyEl.appendChild(row);
      scrollDown();
    },
    reason(text) {
      if (!rawEl) { rawEl = el("div", "think__raw"); bodyEl.appendChild(rawEl); }
      rawEl.textContent = text.length > 1200 ? "…" + text.slice(-1200) : text;
    },
    done(ms) {
      box.classList.add("done");
      box.querySelector(".think__title").textContent = `Thought for ${(ms / 1000).toFixed(1)}s · ${steps} step${steps === 1 ? "" : "s"}`;
      box.dataset.open = "false";
    },
  };
}

/* ---------------- send ---------------- */
async function send(text, options = {}) {
  const message = (text ?? $("input").value).trim();
  if (!message || state.busy) return;
  $("input").value = "";
  autoGrow();
  $("charCount").textContent = "";
  const attachments = state.attachments.slice();
  state.attachments = [];
  renderAttachments();
  await streamRequest({
    url: "/api/chat",
    payload: {
      message, conversationId: state.activeId, model: state.model, attachments,
      search: state.search, deepThink: state.deep,
    },
    echoUser: message,
    attachments,
    realtime: Boolean(options.realtime),
  });
}

async function regenerate() {
  if (!state.activeId || state.busy) return;
  await streamRequest({
    url: `/api/conversations/${state.activeId}/regenerate`,
    payload: { model: state.model },
    echoUser: null,
    dropLastAssistant: true,
  });
}

/** Shared streaming pipeline for a new message and for regenerating one. */
async function streamRequest({ url, payload, echoUser, attachments = [], dropLastAssistant = false, realtime = false }) {
  setBusy(true);
  state.runId++;
  const runId = state.runId;

  const thread = $("thread");
  const wasEmpty = thread.classList.contains("thread--empty");
  thread.classList.remove("thread--empty");
  if (wasEmpty) $("threadIn").innerHTML = "";

  if (dropLastAssistant) {
    const bots = [...$("threadIn").querySelectorAll(".msg--bot")];
    const last = bots[bots.length - 1];
    if (last) last.remove();
  }

  if (echoUser) {
    $("threadIn").appendChild(messageNode({
      role: "user", text: echoUser,
      attachments: attachments.map((a) => ({ name: a.name, chars: a.text.length })),
    }, true));
  }

  const botWrap = el("div", "msg msg--bot has-think");
  const think = thinkBlock(botWrap, "Thinking…");
  const body = el("div", "msg__body");
  body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  botWrap.appendChild(body);
  $("threadIn").appendChild(botWrap);
  scrollDown(true);

  const started = Date.now();
  think.step("Sent to the server");

  state.controller = new AbortController();
  let answer = "", meta = null, source = null, sources = [];

  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: state.controller.signal,
    });

    if (res.status === 401) { showAuth("Your session expired — sign in again."); setBusy(false); return; }
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (runId !== state.runId) { try { reader.cancel(); } catch {} return; }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const lines = frame.split("\n");
        const eventLine = lines.find((l) => l.startsWith("event:")) || "";
        const dataLine = lines.find((l) => l.startsWith("data:")) || "";
        if (!dataLine) continue;
        const event = eventLine.slice(6).trim();
        let data = {};
        try { data = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }

        if (event === "meta") {
          meta = data;
          if (!state.activeId) state.activeId = data.conversationId;
        } else if (event === "step") {
          think.step(data.text);
        } else if (event === "reason") {
          think.reason(data.text);
        } else if (event === "delta") {
          if (!answer) think.step("Streaming the reply");
          answer += data.text;
          body.innerHTML = renderMarkdown(answer);
          scrollDown();
        } else if (event === "sources") {
          sources = data.results || [];
        } else if (event === "error") {
          think.step("Error: " + data.error);
        } else if (event === "done") {
          source = data.source;
          if (data.sources) sources = data.sources;
          meta = { ...meta, ...data };
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      think.step("Failed: " + err.message);
      answer = answer || `**Request failed** — ${err.message}`;
    }
  } finally {
    if (runId === state.runId) {
      think.done(Date.now() - started);
      body.innerHTML = answer
        ? renderMarkdown(answer) + sourcesHtml(sources) + metaHtml({ source, createdAt: Date.now() }, true)
        : '<p style="color:var(--text-faint)">Stopped.</p>';
      setBusy(false);
      scrollDown();
      if (realtime && realtimeActive()) speakAnswer(answer);
    }
  }

  if (runId !== state.runId) return;

  if (meta?.conversationId) {
    state.activeId = meta.conversationId;
    await loadConversations().catch(() => {});
    renderChatList();
    // keep the in-memory transcript in step with the server without repainting the thread
    try {
      const { messages } = await api(`/api/conversations/${state.activeId}/messages`);
      state.messages = messages;
    } catch { /* the UI already shows the answer */ }
  }
}

/* ---------------- composer ---------------- */
function autoGrow() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}

$("input").addEventListener("input", () => {
  autoGrow();
  $("send").disabled = state.busy || !$("input").value.trim();
  const n = $("input").value.length;
  $("charCount").textContent = n ? `${n} chars` : "";
});

$("input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
});

$("send").addEventListener("click", () => send());
$("stop").addEventListener("click", () => {
  state.runId++;
  state.controller?.abort();
  const bots = [...$("threadIn").querySelectorAll(".msg--bot .msg__body")];
  const last = bots[bots.length - 1];
  if (last) {
    const think = last.parentNode.querySelector(".think");
    if (think && !think.classList.contains("done")) {
      think.classList.add("done");
      think.dataset.open = "false";
      const title = think.querySelector(".think__title");
      if (title) title.textContent = "Stopped";
    }
    if (!last.querySelector(".msg__meta")) {
      const typing = last.querySelector(".typing");
      if (typing) last.innerHTML = '<p style="color:var(--text-faint)">Stopped.</p>';
    }
  }
  setBusy(false);
  toast("Stopped");
});

/* ---------------- attachments ---------------- */
function renderAttachments() {
  const bar = $("attachBar");
  bar.innerHTML = "";
  bar.hidden = state.attachments.length === 0;
  state.attachments.forEach((file, index) => {
    const chip = el("span", "attach");
    chip.innerHTML = `<span>${escapeHtml(file.name)} · ${sizeLabel(file.text.length)}</span>`;
    const drop = el("button");
    drop.type = "button";
    drop.textContent = "×";
    drop.setAttribute("aria-label", `Remove ${file.name}`);
    drop.addEventListener("click", () => { state.attachments.splice(index, 1); renderAttachments(); });
    chip.appendChild(drop);
    bar.appendChild(chip);
  });
}

$("attachBtn").addEventListener("click", () => $("attachInput").click());
$("attachInput").addEventListener("change", async (event) => {
  for (const file of [...event.target.files].slice(0, 5)) {
    if (file.size > 200_000) { toast(`${file.name} is too big (200 KB limit)`); continue; }
    const text = await file.text();
    state.attachments.push({ name: file.name, text });
  }
  event.target.value = "";
  renderAttachments();
});

/* ---------------- edit the last message ---------------- */
async function startEdit(messageId) {
  if (state.busy) return;
  // the freshly echoed bubble has no id yet, so fall back to the last question
  const message = state.messages.find((m) => m.id === messageId) ||
    [...state.messages].reverse().find((m) => m.role === "user");
  if (!message) { toast("Nothing to edit yet"); return; }
  const wrap = [...document.querySelectorAll(".msg--user")].pop();
  if (!wrap) return;
  const bubble = wrap.querySelector(".msg__bubble");
  bubble.innerHTML = "";
  const box = el("div", "editbox");
  const area = el("textarea");
  area.value = message.text;
  const actions = el("div", "msg__meta");
  actions.innerHTML = '<button type="button" data-save-edit>Save & resend</button><button type="button" data-cancel-edit>Cancel</button>';
  box.append(area, actions);
  bubble.appendChild(box);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);

  actions.addEventListener("click", async (event) => {
    if (event.target.closest("[data-cancel-edit]")) { renderThread(); return; }
    if (!event.target.closest("[data-save-edit]")) return;
    const next = area.value.trim();
    if (!next) return;
    message.text = next;
    renderThread();
    await streamRequest({
      url: `/api/conversations/${state.activeId}/edit-last`,
      payload: { message: next, model: state.model },
      echoUser: null,
      dropLastAssistant: true,
    });
  });
  area.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); actions.querySelector("[data-save-edit]").click(); }
    if (event.key === "Escape") renderThread();
  });
}

/* ---------------- custom instructions ---------------- */
function currentConversation() {
  return state.conversations.find((c) => c.id === state.activeId) || null;
}

$("instructionsBtn").addEventListener("click", () => {
  if (!state.activeId) { toast("Send a message first — instructions belong to a chat"); return; }
  $("instructionsText").value = currentConversation()?.systemPrompt || "";
  $("instructionsModal").hidden = false;
  $("instructionsText").focus();
});
$("instructionsClose").addEventListener("click", () => { $("instructionsModal").hidden = true; });
$("instructionsModal").addEventListener("click", (e) => { if (e.target.id === "instructionsModal") $("instructionsModal").hidden = true; });
$("instructionsSave").addEventListener("click", async () => {
  const systemPrompt = $("instructionsText").value.trim();
  try {
    const { conversation } = await api(`/api/conversations/${state.activeId}`, { method: "PATCH", body: { systemPrompt } });
    const local = currentConversation();
    if (local) local.systemPrompt = conversation.systemPrompt;
    $("instructionsModal").hidden = true;
    toast(systemPrompt ? "Instructions saved" : "Instructions cleared");
  } catch (err) { toast(err.message); }
});
$("instructionsClear").addEventListener("click", () => { $("instructionsText").value = ""; });

/* ---------------- voice input ---------------- */
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
$("mic").addEventListener("click", () => {
  if (!Recognition) { toast("This browser has no speech recognition — Chrome or Edge does"); return; }
  const mic = $("mic");
  if (mic.classList.contains("mic-live")) { mic.classList.remove("mic-live"); return; }
  const recognition = new Recognition();
  recognition.lang = "en-IN";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  mic.classList.add("mic-live");
  $("wave").classList.add("on");
  setStatus("Listening…");
  recognition.onresult = (event) => {
    const said = event.results[0][0].transcript;
    $("input").value = ($("input").value + " " + said).trim();
    autoGrow();
    $("send").disabled = false;
    $("charCount").textContent = `${$("input").value.length} chars`;
  };
  recognition.onerror = (event) => toast(`Microphone: ${event.error}`);
  recognition.onend = () => {
    mic.classList.remove("mic-live");
    $("wave").classList.remove("on");
    setStatus("Technova AI can make mistakes. Check important info.");
    $("input").focus();
  };
  recognition.start();
});

/* ---------------- actions ---------------- */
document.addEventListener("click", (event) => {
  const ask = event.target.closest("[data-ask]");
  if (ask) { send(ask.dataset.ask); return; }

  const copyCode = event.target.closest("[data-copy-code]");
  if (copyCode) {
    const pre = copyCode.closest(".code")?.querySelector("pre");
    navigator.clipboard?.writeText(pre?.innerText || "").then(() => toast("Copied"));
    return;
  }

  const editBtn = event.target.closest("[data-edit]");
  if (editBtn) { startEdit(editBtn.dataset.edit); return; }

  const regen = event.target.closest("[data-regen]");
  if (regen) { regenerate(); return; }

  const copyMsg = event.target.closest("[data-copy-msg]");
  if (copyMsg) {
    const body = copyMsg.closest(".msg__body");
    const clone = body.cloneNode(true);
    clone.querySelectorAll(".msg__meta,.think").forEach((n) => n.remove());
    navigator.clipboard?.writeText(clone.innerText.trim()).then(() => toast("Copied"));
    return;
  }

  const speak = event.target.closest("[data-speak]");
  if (speak && "speechSynthesis" in window) {
    const body = speak.closest(".msg__body");
    const clone = body.cloneNode(true);
    clone.querySelectorAll(".msg__meta,.think").forEach((n) => n.remove());
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(clone.innerText.trim().slice(0, 700)));
    return;
  }

  const thinkHead = event.target.closest(".think__head");
  if (thinkHead) {
    const box = thinkHead.closest(".think");
    box.dataset.open = box.dataset.open === "true" ? "false" : "true";
    return;
  }

  if (!event.target.closest("#userRow") && !event.target.closest("#userMenu")) $("userMenu").hidden = true;
});

$("usageBtn").addEventListener("click", async () => {
  $("userMenu").hidden = true;
  try {
    const u = await api("/api/usage");
    $("usageStats").innerHTML =
      `<div><dt>Conversations</dt><dd>${u.conversations}</dd></div>` +
      `<div><dt>Messages</dt><dd>${u.messages}</dd></div>` +
      `<div><dt>Your questions</dt><dd>${u.userMessages}</dd></div>` +
      `<div><dt>Words</dt><dd>${u.words}</dd></div>`;
    $("usageNote").textContent =
      `Answering in ${u.provider === "nvidia" ? "live model" : "local skills"} mode · member since ` +
      new Date(u.memberSince).toLocaleDateString("en-IN");
    $("usageModal").hidden = false;
  } catch (err) { toast(err.message); }
});
$("usageClose").addEventListener("click", () => { $("usageModal").hidden = true; });
$("usageModal").addEventListener("click", (e) => { if (e.target.id === "usageModal") $("usageModal").hidden = true; });

$("clearAllBtn").addEventListener("click", async () => {
  $("userMenu").hidden = true;
  if (!state.conversations.length) { toast("No chats to clear"); return; }
  if (!confirm(`Delete all ${state.conversations.length} chats? This cannot be undone.`)) return;
  try {
    await api("/api/conversations", { method: "DELETE" });
    state.conversations = [];
    state.messages = [];
    state.activeId = null;
    renderThread();
    renderChatList();
    toast("All chats deleted");
  } catch (err) { toast(err.message); }
});

$("exportAllBtn").addEventListener("click", async () => {
  $("userMenu").hidden = true;
  try {
    const dump = await api("/api/export");
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "technova-chats.json";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast("Exported every chat");
  } catch (err) { toast(err.message); }
});

$("exportChat").addEventListener("click", () => {
  if (!state.messages.length) { toast("Nothing to export yet"); return; }
  const title = state.conversations.find((c) => c.id === state.activeId)?.title || "chat";
  const md = [`# ${title}`, "", `_Exported from Technova AI · ${new Date().toLocaleString("en-IN")}_`, ""];
  for (const m of state.messages) md.push(m.role === "user" ? `**You:** ${m.text}` : `**Technova AI:** ${m.text}`, "");
  const blob = new Blob([md.join("\n")], { type: "text/markdown" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "chat"}.md`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

/* ---------------- search + deep think toggles ---------------- */
function paintToggles() {
  $("searchToggle").setAttribute("aria-pressed", String(state.search));
  $("deepToggle").setAttribute("aria-pressed", String(state.deep));
}
$("searchToggle").addEventListener("click", () => {
  state.search = !state.search;
  localStorage.setItem("technova.search", state.search ? "1" : "0");
  paintToggles();
  toast(state.search ? "Web search on" : "Web search off");
});
$("deepToggle").addEventListener("click", () => {
  state.deep = !state.deep;
  localStorage.setItem("technova.deep", state.deep ? "1" : "0");
  paintToggles();
  toast(state.deep ? "Deep think on — slower, more careful answers" : "Deep think off");
});
paintToggles();

/* ---------------- web sources under an answer ---------------- */
function sourcesHtml(sources) {
  if (!sources || !sources.length) return "";
  const items = sources.map((r) => {
    let host = "";
    try { host = new URL(r.url).hostname.replace(/^www\./, ""); } catch { host = ""; }
    return `<li><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.title)}</a>` +
      `<em>${escapeHtml(host)}</em></li>`;
  }).join("");
  return `<div class="sources"><div class="sources__head">Web results <span>· ${sources.length}</span></div><ol>${items}</ol></div>`;
}

/* ---------------- realtime voice mode ---------------- */
const RealtimeRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let realtime = { active: false, recognition: null, speaking: false };

const realtimeActive = () => realtime.active;

function stripMarkdown(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function speakAnswer(text) {
  if (!("speechSynthesis" in window) || !text) { if (realtime.active) listenOnce(); return; }
  const utter = new SpeechSynthesisUtterance(stripMarkdown(text).slice(0, 700));
  utter.lang = "en-IN";
  realtime.speaking = true;
  setRealtimeState("Speaking…");
  const resume = () => { realtime.speaking = false; if (realtime.active) listenOnce(); };
  utter.onend = resume;
  utter.onerror = resume;
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
}

function setRealtimeState(text) {
  const el = $("realtimeState");
  if (el) el.textContent = text;
}

function stopRealtime() {
  realtime.active = false;
  try { realtime.recognition?.stop(); } catch {}
  realtime.recognition = null;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  $("realtimeBar").hidden = true;
  $("realtimeBtn").classList.remove("on");
  setBusy(false);
}

function listenOnce() {
  if (!realtime.active || !RealtimeRecognition) return;
  const recognition = new RealtimeRecognition();
  realtime.recognition = recognition;
  recognition.lang = "en-IN";
  recognition.interimResults = false;
  setRealtimeState("Listening…");
  recognition.onresult = (event) => {
    const said = event.results[0][0].transcript;
    if (said && said.trim()) send(said.trim(), { realtime: true });
    else listenOnce();
  };
  recognition.onerror = () => { if (realtime.active) setTimeout(listenOnce, 600); };
  recognition.onend = () => { if (realtime.active && !realtime.speaking) setTimeout(listenOnce, 300); };
  try { recognition.start(); } catch { setTimeout(listenOnce, 600); }
}

$("realtimeBtn").addEventListener("click", () => {
  if (!RealtimeRecognition) { toast("This browser has no speech recognition — Chrome or Edge does"); return; }
  if (realtime.active) { stopRealtime(); return; }
  realtime.active = true;
  $("realtimeBar").hidden = false;
  $("realtimeBtn").classList.add("on");
  listenOnce();
});
$("realtimeStop").addEventListener("click", stopRealtime);

/* ---------------- share ---------------- */
$("shareBtn").addEventListener("click", async () => {
  if (!state.activeId) { toast("Send a message first"); return; }
  try {
    const { token } = await api(`/api/conversations/${state.activeId}/share`, { method: "POST" });
    const local = currentConversation();
    if (local) { local.shared = true; renderChatList(); }
    $("shareUrl").value = `${location.origin}/s/${token}`;
    $("shareModal").hidden = false;
    $("shareUrl").select();
  } catch (err) { toast(err.message); }
});
$("shareClose").addEventListener("click", () => { $("shareModal").hidden = true; });
$("shareModal").addEventListener("click", (e) => { if (e.target.id === "shareModal") $("shareModal").hidden = true; });
$("shareCopy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("shareUrl").value);
    toast("Link copied");
  } catch { toast("Copy the link from the box"); }
});
$("shareRevoke").addEventListener("click", async () => {
  try {
    await api(`/api/conversations/${state.activeId}/share`, { method: "DELETE" });
    const local = currentConversation();
    if (local) { local.shared = false; renderChatList(); }
    $("shareModal").hidden = true;
    toast("Sharing stopped — the old link is dead");
  } catch (err) { toast(err.message); }
});

/* ---------------- accent ---------------- */
const ACCENTS = ["teal", "cobalt", "amber", "plum"];
function setAccent(name) {
  document.documentElement.dataset.accent = name;
  localStorage.setItem("technova.accent", name);
}

/* ---------------- command palette ---------------- */
const palette = $("palette");
let paletteIndex = 0;

function paletteActions() {
  return [
    { label: "New chat", hint: "⌘⇧O", run: () => openConversation(null) },
    { label: "Search chats", hint: "⌘K", run: () => { closePalette(); openSide(); $("chatSearch").focus(); } },
    { label: "Custom instructions", run: () => $("instructionsBtn").click() },
    { label: "Share this chat", run: () => $("shareBtn").click() },
    { label: "Export this chat", run: () => $("exportChat").click() },
    { label: "Export all chats", run: () => $("exportAllBtn").click() },
    { label: "Usage", run: () => $("usageBtn").click() },
    { label: "Keyboard shortcuts", run: () => { closePalette(); $("helpModal").hidden = false; } },
    { label: currentTheme() === "dark" ? "Switch to light theme" : "Switch to dark theme", run: () => $("themeBtn").click() },
    ...ACCENTS.map((a) => ({ label: `Accent: ${a}`, run: () => { setAccent(a); closePalette(); toast(`Accent: ${a}`); } })),
    { label: "Sign out", run: () => $("logoutBtn").click() },
  ];
}

function paletteResults(query) {
  const q = query.trim().toLowerCase();
  const chats = state.conversations
    .filter((c) => !q || c.title.toLowerCase().includes(q))
    .slice(0, 6)
    .map((c) => ({ label: c.title || "New chat", hint: "chat", run: () => openConversation(c.id) }));
  const actions = paletteActions().filter((a) => !q || a.label.toLowerCase().includes(q));
  return [...(q ? chats : chats.slice(0, 3)), ...actions];
}

function renderPalette(query) {
  const results = paletteResults(query);
  const list = $("paletteList");
  list.innerHTML = "";
  if (!results.length) {
    list.innerHTML = '<div class="palette__empty">Nothing matches that.</div>';
    return;
  }
  paletteIndex = Math.min(paletteIndex, results.length - 1);
  results.forEach((item, i) => {
    const button = el("button", "palette__item");
    button.setAttribute("aria-selected", String(i === paletteIndex));
    button.innerHTML = `<span>${escapeHtml(item.label)}</span>${item.hint ? `<span class="k">${escapeHtml(item.hint)}</span>` : ""}`;
    button.addEventListener("click", () => { closePalette(); item.run(); });
    list.appendChild(button);
  });
  list.dataset.count = String(results.length);
}

function openPalette() {
  palette.hidden = false;
  paletteIndex = 0;
  $("paletteInput").value = "";
  renderPalette("");
  $("paletteInput").focus();
}
function closePalette() {
  palette.hidden = true;
  // leaving focus inside the hidden input swallows the next keystroke (e.g. "?")
  $("paletteInput").blur();
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

$("helpClose").addEventListener("click", () => { $("helpModal").hidden = true; });
$("helpModal").addEventListener("click", (e) => { if (e.target.id === "helpModal") $("helpModal").hidden = true; });

$("paletteInput").addEventListener("input", (e) => { paletteIndex = 0; renderPalette(e.target.value); });
$("paletteInput").addEventListener("keydown", (event) => {
  const count = Number($("paletteList").dataset.count || 0);
  if (event.key === "ArrowDown") { event.preventDefault(); paletteIndex = Math.min(paletteIndex + 1, count - 1); renderPalette($("paletteInput").value); }
  else if (event.key === "ArrowUp") { event.preventDefault(); paletteIndex = Math.max(paletteIndex - 1, 0); renderPalette($("paletteInput").value); }
  else if (event.key === "Enter") {
    event.preventDefault();
    const item = $("paletteList").querySelectorAll(".palette__item")[paletteIndex];
    if (item) item.click();
  } else if (event.key === "Escape") { closePalette(); }
});
palette.addEventListener("click", (e) => { if (e.target === palette) closePalette(); });

/* ---------------- read-only shared view ---------------- */
async function renderShared(token) {
  document.body.classList.add("shared-view");
  $("auth").hidden = true;
  $("app").hidden = false;
  $("side").hidden = true;
  document.querySelector(".topbar").innerHTML =
    `<div class="modelbtn" style="pointer-events:none"><span class="mmark">∞</span><span id="sharedTitle">Shared chat</span></div>
     <div class="topbar__right"><a class="icon-btn" href="/" title="Open Technova AI">Open app</a></div>`;
  document.querySelector(".composer").hidden = true;
  document.querySelectorAll("#shareBtn,#exportChat,#deleteChat,#instructionsBtn").forEach((n) => n?.remove());
  try {
    const data = await api(`/api/shared/${token}`);
    document.getElementById("sharedTitle").textContent = data.title || "Shared chat";
    const host = $("threadIn");
    host.innerHTML = "";
    $("thread").classList.remove("thread--empty");
    for (const message of data.messages) host.appendChild(messageNode(message, false));
    document.querySelectorAll(".followups,[data-regen],[data-edit]").forEach((n) => n.remove());
  } catch (err) {
    $("threadIn").innerHTML = `<div class="hello"><div class="hello__badge">∞</div><h1>Link not available</h1><p class="hello__sub">${escapeHtml(err.message)}</p></div>`;
  }
}

/* ---------------- model + theme + layout ---------------- */
function renderModels(models) {
  const select = $("model");
  select.innerHTML = "";
  for (const m of models) {
    const option = document.createElement("option");
    option.value = m.label;
    option.textContent = m.label;
    select.appendChild(option);
  }
  const known = models.some((m) => m.label === state.model);
  if (!known && models.length) state.model = models[0].label;
  select.value = state.model;
  syncModelLabel();
  $("modelMark").classList.toggle("pro", /pro/i.test(state.model));
}

function syncModelLabel() {
  const label = $("modelLabel");
  if (!label) return; // the shared view has no model picker
  const narrow = window.innerWidth < 520;
  label.textContent = narrow ? state.model.replace(/^Technova\s+/i, "") : state.model;
}
window.addEventListener("resize", syncModelLabel);

async function loadModels() {
  try {
    const { models } = await api("/api/models");
    if (models?.length) { state.models = models; renderModels(models); }
  } catch { /* keep the built-in two */ }
}

$("model").value = state.model;
$("modelLabel").textContent = state.model;
$("modelMark").classList.toggle("pro", state.model === "Technova 1.5 Pro");
$("model").addEventListener("change", (event) => {
  state.model = event.target.value;
  localStorage.setItem("technova.model", state.model);
  syncModelLabel();
  $("modelMark").classList.toggle("pro", state.model === "Technova 1.5 Pro");
  // remember the choice on this chat so it comes back on reload
  if (state.activeId) {
    api(`/api/conversations/${state.activeId}`, { method: "PATCH", body: { model: state.model } })
      .then(() => {
        const local = state.conversations.find((c) => c.id === state.activeId);
        if (local) local.model = state.model;
      })
      .catch(() => {});
  }
  toast("Model set to " + state.model);
});

const currentTheme = () =>
  document.documentElement.dataset.theme ||
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

$("themeBtn").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("technova.theme", next);
});

function openSide() { $("side").classList.add("open"); $("scrim").classList.add("on"); }
function closeSide() { $("side").classList.remove("open"); $("scrim").classList.remove("on"); }
$("burger").addEventListener("click", openSide);
$("closeSide").addEventListener("click", closeSide);
$("scrim").addEventListener("click", closeSide);

$("thread").addEventListener("scroll", () => {
  const t = $("thread");
  document.querySelector(".topbar").classList.toggle("stuck", t.scrollTop > 8);
  state.locked = t.scrollHeight - t.scrollTop - t.clientHeight > 80;
  $("jumpBtn").classList.toggle("on", state.locked);
});
$("jumpBtn").addEventListener("click", () => {
  state.locked = false;
  $("jumpBtn").classList.remove("on");
  scrollDown(true);
});

document.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if ($("app").hidden) return; // not signed in yet
    openPalette();
  }
  else if (mod && event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); openConversation(null); }
  else if (event.key === "?" && !event.target.closest("input, textarea") && !$("app").hidden) {
    event.preventDefault();
    $("helpModal").hidden = false;
  }
  else if (event.key === "Escape") {
    closeSide();
    $("userMenu").hidden = true;
    $("instructionsModal").hidden = true;
    $("usageModal").hidden = true;
    $("helpModal").hidden = true;
    $("shareModal").hidden = true;
  }
});

/* ---------------- boot ---------------- */
async function enterApp() {
  $("auth").hidden = true;
  $("app").hidden = false;
  $("userName").textContent = state.user.name;
  $("userEmail").textContent = state.user.email;
  $("userAvatar").textContent = (state.user.name || "U").slice(0, 1).toUpperCase();
  await loadModels();
  await loadConversations();
  const latest = state.conversations[0];
  await openConversation(latest ? latest.id : null);
  $("input").focus();
}

(async function boot() {
  const savedTheme = localStorage.getItem("technova.theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  const savedAccent = localStorage.getItem("technova.accent");
  if (savedAccent) document.documentElement.dataset.accent = savedAccent;

  const sharedMatch = location.pathname.match(/^\/s\/([\w-]+)$/);
  if (sharedMatch) { await renderShared(sharedMatch[1]); return; }

  try {
    const { user } = await api("/api/auth/me");
    if (!user) throw new Error("no session");
    state.user = user;
    await enterApp();
  } catch {
    setAuthMode("login");
    showAuth("");
  }
})();
