// Technova AI — full-stack server.
// Plain Node 20, no dependencies: HTTP router, session auth, JSON store, SSE streaming.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { loadEnv } from "./lib/env.js";
import { load, data, save, flush, id, now } from "./lib/store.js";
import {
  createUser, findUserByEmail, verifyPassword, createSession, userForToken,
  destroySession, publicUser, parseCookies, sessionCookie, clearedCookie,
} from "./lib/auth.js";
import { streamAnswer, hasKey, upstreamModel, listModels } from "./lib/provider.js";
import { searchWeb, searchProvider, fetchPage } from "./lib/tools.js";

loadEnv(); // read .env before any module reads process.env

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 1_000_000;

/* ---------------- helpers ---------------- */
const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

const userFromRequest = (req) => userForToken(parseCookies(req.headers.cookie).sid);

/* ---------------- naive rate limit for auth ---------------- */
const attempts = new Map();
let lastSweep = 0;
function rateLimited(ip, limit = 12, windowMs = 60_000) {
  const key = ip || "unknown";
  const stamp = now();
  // drop expired buckets now and then, so a long-running process cannot leak memory
  if (stamp - lastSweep > 60_000) {
    lastSweep = stamp;
    for (const [k, rec] of attempts) if (stamp > rec.reset) attempts.delete(k);
  }
  const rec = attempts.get(key) || { count: 0, reset: stamp + windowMs };
  if (stamp > rec.reset) { rec.count = 0; rec.reset = stamp + windowMs; }
  rec.count++;
  attempts.set(key, rec);
  return rec.count > limit;
}

/* ---------------- conversations ---------------- */
const conversationsOf = (userId) => data().conversations.filter((c) => c.userId === userId);
const messagesOf = (conversationId) =>
  data().messages.filter((m) => m.conversationId === conversationId).sort((a, b) => a.createdAt - b.createdAt);

function createConversation(userId, title) {
  const conversation = {
    id: id(),
    userId,
    title: (title || "New chat").slice(0, 80),
    pinned: false,
    systemPrompt: null,
    shareToken: null,
    model: null,
    createdAt: now(),
    updatedAt: now(),
  };
  data().conversations.push(conversation);
  save();
  return conversation;
}

/* ---------------- static files ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "forbidden" });
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(body);
  } catch {
    const fallback = await readFile(join(PUBLIC_DIR, "index.html")).catch(() => null);
    if (!fallback) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fallback);
  }
}

/* ---------------- chat (SSE) ---------------- */
async function handleChat(req, res, user, body) {
  const text = String(body.message || "").trim().slice(0, 8000);
  const modelLabel = String(body.model || "Technova 1.0 Flash");
  const deepThink = Boolean(body.deepThink);
  const wantsSearch = Boolean(body.search);
  if (!text) return json(res, 400, { error: "message is required" });
  if (rateLimited(`chat:${user.id}`, 40, 60_000)) {
    return json(res, 429, { error: "slow down a moment — 40 messages a minute" });
  }

  // attachments are plain text, capped so a big paste can't blow up a request
  const attachments = Array.isArray(body.attachments)
    ? body.attachments.slice(0, 5).map((a) => ({
        name: String(a.name || "attachment").slice(0, 120),
        text: String(a.text || "").slice(0, 20_000),
      })).filter((a) => a.text.length > 0)
    : [];

  let conversation = body.conversationId
    ? conversationsOf(user.id).find((c) => c.id === body.conversationId)
    : null;
  if (!conversation) conversation = createConversation(user.id, text.slice(0, 60));

  let userMessage = null;
  if (!body.regenerate) {
    userMessage = {
      id: id(), conversationId: conversation.id, role: "user", text,
      attachments: attachments.map((a) => ({ name: a.name, chars: a.text.length })),
      createdAt: now(),
    };
    data().messages.push(userMessage);
    if (conversation.title === "New chat") conversation.title = text.slice(0, 60);
  } else {
    // keep the last user turn, drop any replies after it
    const all = messagesOf(conversation.id);
    const lastUser = [...all].reverse().find((m) => m.role === "user");
    userMessage = lastUser || null;
    if (lastUser) {
      data().messages = data().messages.filter((m) => m.conversationId !== conversation.id || m.createdAt <= lastUser.createdAt);
    }
  }
  conversation.model = modelLabel;
  conversation.updatedAt = now();
  save();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const seenSteps = new Set();
  const send = (event, payload) => {
    if (res.writableEnded) return;
    // the tool run and the model both announce the first step; keep it once
    if (event === "step") {
      if (seenSteps.has(payload.text)) return;
      seenSteps.add(payload.text);
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const controller = new AbortController();
  let closed = false;
  req.on("close", () => { closed = true; controller.abort(); });

  send("meta", { conversationId: conversation.id, title: conversation.title, userMessageId: userMessage ? userMessage.id : null, regenerate: Boolean(body.regenerate) });

  const promptParts = [];
  if (attachments.length) {
    promptParts.push("Attached material:\n" + attachments.map((a) => `--- ${a.name} ---\n${a.text}`).join("\n\n"));
  }
  promptParts.push(text);

  let search = null;
  send("step", { text: "Read your message" });
  if (wantsSearch) {
    send("step", { text: "Searching the web…" });
    search = await searchWeb(text);
    if (search.ok) {
      send("step", { text: `Found ${search.results.length} result${search.results.length === 1 ? "" : "s"} (${search.provider})` });
      send("sources", { results: search.results, provider: search.provider });
    } else {
      send("step", { text: `Search unavailable: ${search.reason}` });
      send("sources", { results: [], provider: search.provider, error: search.reason });
    }
  }

  let answer = "";
  let source = "Local";
  try {
    const result = await streamAnswer({
      text: promptParts.join("\n\n"),
      systemPrompt: conversation.systemPrompt || null,
      deepThink,
      search,
      modelLabel,
      signal: controller.signal,
      onStep: (step) => send("step", { text: step }),
      onReason: (chunk) => send("reason", { text: chunk }),
      onDelta: (chunk) => { answer += chunk; send("delta", { text: chunk }); },
    });
    source = result.source;
    if (!answer) answer = result.text;
  } catch (err) {
    if (!closed) send("error", { error: err?.message || "generation failed" });
  }

  if (answer.trim()) {
    const assistantMessage = {
      id: id(), conversationId: conversation.id, role: "assistant",
      text: answer, source, model: modelLabel, createdAt: now(),
    };
    data().messages.push(assistantMessage);
    conversation.updatedAt = now();
    save();
    send("done", {
      conversationId: conversation.id, messageId: assistantMessage.id, source,
      title: conversation.title, stopped: closed,
      sources: search && search.ok ? search.results : [],
    });
  } else {
    send("done", { conversationId: conversation.id, stopped: closed, empty: true });
  }

  res.end();
}

/* ---------------- router ---------------- */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  const method = req.method || "GET";

  try {
    if (path === "/api/health") {
      return json(res, 200, {
        ok: true,
        provider: hasKey() ? "nvidia" : "local",
        search: searchProvider(),
        models: ["Technova 1.0 Flash", "Technova 1.5 Pro"].map((label) => ({ label, upstream: upstreamModel(label) })),
        uptime: Math.round(process.uptime()),
      });
    }

    if (path === "/api/auth/signup" && method === "POST") {
      if (rateLimited(req.socket.remoteAddress)) return json(res, 429, { error: "too many attempts, wait a minute" });
      const { email, password, name } = await readBody(req);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ""))) return json(res, 400, { error: "enter a valid email" });
      if (String(password || "").length < 8) return json(res, 400, { error: "password needs at least 8 characters" });
      if (findUserByEmail(email)) return json(res, 409, { error: "that email is already registered" });
      const user = createUser(email, password, name);
      const session = createSession(user.id);
      res.setHeader("Set-Cookie", sessionCookie(session.token, 30 * 86400));
      return json(res, 201, { user: publicUser(user) });
    }

    if (path === "/api/auth/login" && method === "POST") {
      if (rateLimited(req.socket.remoteAddress)) return json(res, 429, { error: "too many attempts, wait a minute" });
      const { email, password } = await readBody(req);
      const user = findUserByEmail(email);
      if (!user || !verifyPassword(String(password || ""), user.password)) {
        return json(res, 401, { error: "email or password is wrong" });
      }
      const session = createSession(user.id);
      res.setHeader("Set-Cookie", sessionCookie(session.token, 30 * 86400));
      return json(res, 200, { user: publicUser(user) });
    }

    if (path === "/api/auth/logout" && method === "POST") {
      destroySession(parseCookies(req.headers.cookie).sid);
      res.setHeader("Set-Cookie", clearedCookie());
      return json(res, 200, { ok: true });
    }

    if (path === "/api/auth/me" && method === "GET") {
      const user = userFromRequest(req);
      if (!user) return json(res, 401, { error: "not signed in" });
      return json(res, 200, { user: publicUser(user) });
    }

    if (path.startsWith("/api/shared/") && method === "GET") {
      const token = path.slice("/api/shared/".length);
      const conversation = data().conversations.find((c) => c.shareToken && c.shareToken === token);
      if (!conversation) return json(res, 404, { error: "that link is not available" });
      return json(res, 200, {
        title: conversation.title,
        createdAt: conversation.createdAt,
        messages: messagesOf(conversation.id).map((m) => ({
          role: m.role, text: m.text, source: m.source || null, createdAt: m.createdAt,
          attachments: m.attachments || [],
        })),
      });
    }

    /* ----- everything below needs a session ----- */
    if (path.startsWith("/api/")) {
      const user = userFromRequest(req);
      if (!user) return json(res, 401, { error: "not signed in" });

      if (path === "/api/conversations" && method === "GET") {
        const list = conversationsOf(user.id)
          .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
          .map((c) => ({
            id: c.id, title: c.title, updatedAt: c.updatedAt,
            pinned: Boolean(c.pinned),
            systemPrompt: c.systemPrompt || null,
            shared: Boolean(c.shareToken),
            model: c.model || null,
            messages: data().messages.filter((m) => m.conversationId === c.id).length,
          }));
        return json(res, 200, { conversations: list });
      }

      if (path === "/api/conversations" && method === "DELETE") {
        const mine = new Set(conversationsOf(user.id).map((c) => c.id));
        data().conversations = data().conversations.filter((c) => !mine.has(c.id));
        data().messages = data().messages.filter((m) => !mine.has(m.conversationId));
        save();
        return json(res, 200, { deleted: mine.size });
      }

      if (path === "/api/conversations" && method === "POST") {
        const { title } = await readBody(req);
        return json(res, 201, { conversation: createConversation(user.id, title) });
      }

      const match = path.match(/^\/api\/conversations\/([\w-]+)(\/messages)?$/);
      if (match) {
        const conversation = conversationsOf(user.id).find((c) => c.id === match[1]);
        if (!conversation) return json(res, 404, { error: "conversation not found" });

        if (match[2] && method === "GET") {
          const all = messagesOf(conversation.id);
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 500);
          const before = Number(url.searchParams.get("before")) || null;
          const window = before ? all.filter((m) => m.createdAt < before) : all;
          const page = window.slice(-limit);
          return json(res, 200, {
            conversation: { id: conversation.id, title: conversation.title },
            hasMore: window.length > page.length,
            nextBefore: page.length ? page[0].createdAt : null,
            total: all.length,
            messages: page.map((m) => ({
              id: m.id, role: m.role, text: m.text, source: m.source || null, model: m.model || null,
              attachments: m.attachments || [], editedAt: m.editedAt || null, createdAt: m.createdAt,
            })),
          });
        }
        if (!match[2] && method === "PATCH") {
          const patch = await readBody(req);
          if (typeof patch.title === "string" && patch.title.trim()) conversation.title = patch.title.trim().slice(0, 80);
          if (typeof patch.pinned === "boolean") conversation.pinned = patch.pinned;
          if (typeof patch.model === "string" && patch.model.trim()) conversation.model = patch.model.trim().slice(0, 60);
          if (typeof patch.systemPrompt === "string") {
            const prompt = patch.systemPrompt.trim().slice(0, 2000);
            conversation.systemPrompt = prompt || null;
          }
          conversation.updatedAt = now();
          save();
          return json(res, 200, { conversation });
        }
        if (!match[2] && method === "DELETE") {
          data().conversations = data().conversations.filter((c) => c.id !== conversation.id);
          data().messages = data().messages.filter((m) => m.conversationId !== conversation.id);
          save();
          return json(res, 200, { ok: true });
        }
      }

      if (path === "/api/tools/page" && method === "POST") {
        const { url } = await readBody(req);
        const page = await fetchPage(url);
        return json(res, page.ok ? 200 : 400, page);
      }

      if (path === "/api/tools/search" && method === "POST") {
        const { query } = await readBody(req);
        const found = await searchWeb(query);
        return json(res, 200, found);
      }

      if (path === "/api/models" && method === "GET") {
        const models = await listModels();
        return json(res, 200, models);
      }

      if (path === "/api/usage" && method === "GET") {
        const mine = conversationsOf(user.id);
        const ids = new Set(mine.map((c) => c.id));
        const messages = data().messages.filter((m) => ids.has(m.conversationId));
        const words = messages.reduce((total, m) => total + String(m.text || "").split(/\s+/).length, 0);
        return json(res, 200, {
          conversations: mine.length,
          messages: messages.length,
          userMessages: messages.filter((m) => m.role === "user").length,
          words,
          provider: hasKey() ? "nvidia" : "local",
        search: searchProvider(),
          memberSince: user.createdAt,
        });
      }

      if (path === "/api/export" && method === "GET") {
        const mine = conversationsOf(user.id);
        const ids = new Set(mine.map((c) => c.id));
        return json(res, 200, {
          exportedAt: now(),
          user: publicUser(user),
          conversations: mine.map((c) => ({
            id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
            messages: messagesOf(c.id).map((m) => ({ role: m.role, text: m.text, source: m.source || null, createdAt: m.createdAt })),
          })),
        });
      }

      if (path === "/api/chat" && method === "POST") {
        const body = await readBody(req);
        return handleChat(req, res, user, body);
      }

      const share = path.match(/^\/api\/conversations\/([\w-]+)\/share$/);
      if (share) {
        const conversation = conversationsOf(user.id).find((c) => c.id === share[1]);
        if (!conversation) return json(res, 404, { error: "conversation not found" });
        if (method === "POST") {
          if (!conversation.shareToken) {
            conversation.shareToken = randomBytes(9).toString("base64url");
            save();
          }
          return json(res, 200, { token: conversation.shareToken, path: `/s/${conversation.shareToken}` });
        }
        if (method === "DELETE") {
          conversation.shareToken = null;
          save();
          return json(res, 200, { ok: true });
        }
      }

      const edit = path.match(/^\/api\/conversations\/([\w-]+)\/edit-last$/);
      if (edit && method === "POST") {
        const conversation = conversationsOf(user.id).find((c) => c.id === edit[1]);
        if (!conversation) return json(res, 404, { error: "conversation not found" });
        const payload = await readBody(req);
        const replacement = String(payload.message || "").trim().slice(0, 8000);
        if (!replacement) return json(res, 400, { error: "message is required" });
        const all = messagesOf(conversation.id);
        const lastUser = [...all].reverse().find((m) => m.role === "user");
        if (!lastUser) return json(res, 400, { error: "nothing to edit" });
        lastUser.text = replacement;
        lastUser.editedAt = now();
        data().messages = data().messages.filter(
          (m) => m.conversationId !== conversation.id || m.id === lastUser.id || m.createdAt <= lastUser.createdAt,
        );
        save();
        return handleChat(req, res, user, {
          message: replacement, conversationId: conversation.id,
          model: payload.model, regenerate: true,
        });
      }

      const regen = path.match(/^\/api\/conversations\/([\w-]+)\/regenerate$/);
      if (regen && method === "POST") {
        const conversation = conversationsOf(user.id).find((c) => c.id === regen[1]);
        if (!conversation) return json(res, 404, { error: "conversation not found" });
        const lastUser = [...messagesOf(conversation.id)].reverse().find((m) => m.role === "user");
        if (!lastUser) return json(res, 400, { error: "nothing to regenerate" });
        const body = await readBody(req);
        return handleChat(req, res, user, {
          message: lastUser.text, conversationId: conversation.id,
          model: body.model, regenerate: true,
        });
      }

      return json(res, 404, { error: "unknown endpoint" });
    }

    if (method !== "GET" && method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    return serveStatic(req, res, path);
  } catch (err) {
    console.error("[server]", err);
    if (!res.headersSent) json(res, 500, { error: err.message || "server error" });
    else res.end();
  }
});

/* ---------------- start ---------------- */
export function start(port = PORT) {
  load();
  return new Promise((resolve) => {
    server.listen(port, () => {
      const actual = server.address().port;
      console.log(`Technova AI listening on http://localhost:${actual}  (${hasKey() ? "live model" : "local skills"} mode)`);
      resolve(actual);
    });
  });
}

export function stop() {
  flush();
  return new Promise((resolve) => server.close(resolve));
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  start();
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => stop().then(() => process.exit(0)));
  }
}
