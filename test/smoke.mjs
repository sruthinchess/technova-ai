// End-to-end smoke test: boots the server on a random port and exercises the API.
import { rmSync } from "node:fs";

// must be set before the server module loads: it reads DB_PATH at import time
process.env.DB_PATH = process.env.DB_PATH || "./data/test-db.json";
rmSync(process.env.DB_PATH, { force: true });

const { start, stop } = await import("../server.js");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const parseSse = (text) =>
  text
    .split("\n\n")
    .map((frame) => {
      const event = (frame.match(/^event: (.*)$/m) || [])[1];
      const data = (frame.match(/^data: (.*)$/m) || [])[1];
      if (!event || !data) return null;
      try { return { event, data: JSON.parse(data) }; } catch { return null; }
    })
    .filter(Boolean);

const port = await start(0);
const base = `http://127.0.0.1:${port}`;

const call = async (path, { method = "GET", body, cookie } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* sse or html */ }
  return { res, text, json, setCookie: res.headers.getSetCookie?.()[0] || res.headers.get("set-cookie") || "" };
};

console.log("\nhealth");
{
  const { json } = await call("/api/health");
  check("health reports ok", json?.ok === true);
  check("lists two models", json?.models?.length === 2, JSON.stringify(json?.models));
}

console.log("\nauth");
let cookie = "";
{
  const bad = await call("/api/auth/signup", { method: "POST", body: { email: "nope", password: "123" } });
  check("rejects a bad email", bad.res.status === 400);

  const weak = await call("/api/auth/signup", { method: "POST", body: { email: "a@b.co", password: "short" } });
  check("rejects a short password", weak.res.status === 400);

  const signup = await call("/api/auth/signup", {
    method: "POST",
    body: { email: "sruthin@example.com", password: "correct-horse", name: "Sruthin" },
  });
  cookie = signup.setCookie.split(";")[0];
  check("signup returns 201", signup.res.status === 201, signup.text);
  check("sets a session cookie", cookie.startsWith("sid="));
  check("never returns the password hash", !signup.text.includes("scrypt$"));

  const dupe = await call("/api/auth/signup", { method: "POST", body: { email: "sruthin@example.com", password: "correct-horse" } });
  check("refuses a duplicate email", dupe.res.status === 409);

  const me = await call("/api/auth/me", { cookie });
  check("session resolves to the user", me.json?.user?.email === "sruthin@example.com");

  const anonMe = await call("/api/auth/me");
  check("signed-out who-am-i is 200 with a null user", anonMe.res.status === 200 && anonMe.json?.user === null,
    `${anonMe.res.status} ${anonMe.text.slice(0, 40)}`);

  const anon = await call("/api/conversations");
  check("blocks anonymous access", anon.res.status === 401);

  const wrong = await call("/api/auth/login", { method: "POST", body: { email: "sruthin@example.com", password: "wrong-password" } });
  check("rejects a wrong password", wrong.res.status === 401);

  const login = await call("/api/auth/login", { method: "POST", body: { email: "sruthin@example.com", password: "correct-horse" } });
  check("login works", login.res.status === 200);
}

console.log("\nchat (local skills)");
let conversationId = null;
{
  const first = await call("/api/chat", { method: "POST", cookie, body: { message: "12.5% of 8400" } });
  const frames = parseSse(first.text);
  const deltas = frames.filter((f) => f.event === "delta").map((f) => f.data.text).join("");
  const done = frames.find((f) => f.event === "done");
  const meta = frames.find((f) => f.event === "meta");
  check("streams an answer", deltas.includes("1050"), deltas.slice(0, 60));
  check("sends a meta frame", Boolean(meta?.data?.conversationId));
  check("finishes with done", Boolean(done));
  check("names the skill", done?.data?.source === "Calculator", String(done?.data?.source));
  conversationId = meta?.data?.conversationId;

  const second = await call("/api/chat", {
    method: "POST", cookie,
    body: { message: "convert 10 km to miles", conversationId },
  });
  const done2 = parseSse(second.text).find((f) => f.event === "done");
  check("continues the same conversation", done2?.data?.conversationId === conversationId);

  const open = await call("/api/chat", { method: "POST", cookie, body: { message: "hello there, how are you?" } });
  const frames3 = parseSse(open.text);
  const answer3 = frames3.filter((f) => f.event === "delta").map((f) => f.data.text).join("");
  check("open-ended question still answers", answer3.length > 20, answer3.slice(0, 60));
  check("no key means local mode", frames3.some((f) => f.event === "step" && /No model key/.test(f.data.text)));
}

console.log("\nmodels");
{
  const models = await call("/api/models", { cookie });
  check("model catalogue responds", models.res.status === 200);
  check("falls back to the built-ins without a key", models.json?.source === "builtin", models.json?.source);
  check("returns two built-in models", models.json?.models?.length === 2);
  check("labels are Technova", models.json?.models?.[0]?.label?.startsWith("Technova"), models.json?.models?.[0]?.label);
}

console.log("\nregenerate");
{
  const before = await call(`/api/conversations/${conversationId}/messages`, { cookie });
  const countBefore = before.json.messages.length;
  const regen = await call(`/api/conversations/${conversationId}/regenerate`, { method: "POST", cookie, body: {} });
  const frames = parseSse(regen.text);
  check("regenerate streams", frames.some((f) => f.event === "delta"));
  check("regenerate is flagged in meta", frames.find((f) => f.event === "meta")?.data?.regenerate === true);
  const after = await call(`/api/conversations/${conversationId}/messages`, { cookie });
  check("replaces the last answer instead of appending", after.json.messages.length === countBefore, `${countBefore} -> ${after.json.messages.length}`);
}

console.log("\npin, instructions, attachments, edit");
{
  const pinned = await call(`/api/conversations/${conversationId}`, { method: "PATCH", cookie, body: { pinned: true } });
  check("pins a conversation", pinned.json?.conversation?.pinned === true);

  const instructions = await call(`/api/conversations/${conversationId}`, {
    method: "PATCH", cookie, body: { systemPrompt: "Answer in Tamil, briefly." },
  });
  check("saves custom instructions", instructions.json?.conversation?.systemPrompt === "Answer in Tamil, briefly.");

  const list = await call("/api/conversations", { cookie });
  check("list exposes pinned", list.json.conversations.some((c) => c.pinned === true));
  check("pinned chats sort first", list.json.conversations[0].pinned === true);
  check("list exposes instructions", typeof list.json.conversations[0].systemPrompt === "string");

  const withFile = await call("/api/chat", {
    method: "POST", cookie,
    body: {
      message: "summarise this file",
      conversationId,
      attachments: [{ name: "notes.txt", text: "The quarterly review is on Friday." }],
    },
  });
  check("accepts an attachment", parseSse(withFile.text).some((f) => f.event === "delta"));

  const transcript = await call(`/api/conversations/${conversationId}/messages`, { cookie });
  const withAttachments = transcript.json.messages.filter((m) => m.attachments?.length);
  check("stores attachment metadata", withAttachments.length === 1, String(withAttachments.length));
  check("keeps the file name", withAttachments[0]?.attachments?.[0]?.name === "notes.txt");

  const edited = await call(`/api/conversations/${conversationId}/edit-last`, {
    method: "POST", cookie, body: { message: "12.5% of 2000" },
  });
  const frames = parseSse(edited.text);
  const text = frames.filter((f) => f.event === "delta").map((f) => f.data.text).join("");
  check("edit streams a fresh answer", text.includes("250"), text.slice(0, 60));

  const after = await call(`/api/conversations/${conversationId}/messages`, { cookie });
  const lastUser = [...after.json.messages].reverse().find((m) => m.role === "user");
  check("edit replaces the question", lastUser?.text === "12.5% of 2000", lastUser?.text);
  check("edit marks the message edited", Boolean(lastUser?.editedAt));
}

console.log("\npagination and per-chat model");
{
  const fresh = await call("/api/conversations", { method: "POST", cookie, body: { title: "Long chat" } });
  const id = fresh.json.conversation.id;
  for (let i = 1; i <= 6; i++) {
    await call("/api/chat", { method: "POST", cookie, body: { message: `${i} + ${i}`, conversationId: id, model: "Technova 1.5 Pro" } });
  }
  const page = await call(`/api/conversations/${id}/messages?limit=5`, { cookie });
  check("limits the page", page.json.messages.length === 5, String(page.json.messages.length));
  check("reports more to load", page.json.hasMore === true);
  check("gives a cursor", typeof page.json.nextBefore === "number");
  check("counts the whole thread", page.json.total === 12, String(page.json.total));

  const earlier = await call(`/api/conversations/${id}/messages?limit=5&before=${page.json.nextBefore}`, { cookie });
  check("loads older messages", earlier.json.messages.length === 5);
  check("older page ends where the first began", earlier.json.messages.at(-1).createdAt <= page.json.nextBefore);

  const list = await call("/api/conversations", { cookie });
  const stored = list.json.conversations.find((c) => c.id === id);
  check("remembers the chat's model", stored?.model === "Technova 1.5 Pro", String(stored?.model));
}

console.log("\nsharing");
{
  const created = await call(`/api/conversations/${conversationId}/share`, { method: "POST", cookie });
  check("creates a share link", Boolean(created.json?.token), created.text);
  check("returns a path", created.json?.path === `/s/${created.json.token}`);
  const token = created.json.token;

  const publicRead = await fetch(`${base}/api/shared/${token}`);
  const shared = await publicRead.json();
  check("public link works without a session", publicRead.status === 200, String(publicRead.status));
  check("shares the title", typeof shared.title === "string");
  check("shares the messages", Array.isArray(shared.messages) && shared.messages.length >= 2);
  check("never shares the owner's email", !JSON.stringify(shared).includes("sruthin@example.com"));

  const list = await call("/api/conversations", { cookie });
  check("list flags the shared chat", list.json.conversations.find((c) => c.id === conversationId)?.shared === true);

  const bogus = await fetch(`${base}/api/shared/not-a-token`);
  check("unknown token 404s", bogus.status === 404);

  await call(`/api/conversations/${conversationId}/share`, { method: "DELETE", cookie });
  const afterRevoke = await fetch(`${base}/api/shared/${token}`);
  check("revoking kills the link", afterRevoke.status === 404, String(afterRevoke.status));
}

console.log("\nusage and export");
{
  const usage = await call("/api/usage", { cookie });
  check("usage counts conversations", usage.json?.conversations >= 1, String(usage.json?.conversations));
  check("usage counts messages", usage.json?.messages >= 2);
  check("usage reports the provider", ["local", "nvidia"].includes(usage.json?.provider), usage.json?.provider);

  const dump = await call("/api/export", { cookie });
  check("export returns conversations", Array.isArray(dump.json?.conversations) && dump.json.conversations.length >= 1);
  check("export includes messages", dump.json?.conversations?.[0]?.messages?.length >= 2);
  check("export omits password hashes", !dump.text.includes("scrypt$"));
}

console.log("\nconversations");
{
  const list = await call("/api/conversations", { cookie });
  check("lists conversations", list.json?.conversations?.length >= 2, JSON.stringify(list.json?.conversations?.length));
  check("counts messages", list.json?.conversations?.some((c) => c.messages >= 4));

  const messages = await call(`/api/conversations/${conversationId}/messages`, { cookie });
  check("returns messages in order", messages.json?.messages?.[0]?.role === "user");
  check("stores both sides", messages.json?.messages?.length >= 4 &&
    messages.json.messages.some((m) => m.role === "user") &&
    messages.json.messages.some((m) => m.role === "assistant"), String(messages.json?.messages?.length));

  const rename = await call(`/api/conversations/${conversationId}`, { method: "PATCH", cookie, body: { title: "Renamed chat" } });
  check("renames a conversation", rename.json?.conversation?.title === "Renamed chat");

  const other = await call(`/api/conversations/${conversationId}`, { cookie: "sid=bogus" });
  check("other sessions can't read it", other.res.status === 401);

  const del = await call(`/api/conversations/${conversationId}`, { method: "DELETE", cookie });
  check("deletes a conversation", del.res.status === 200);

  const after = await call("/api/conversations", { cookie });
  check("conversation is gone", !after.json.conversations.some((c) => c.id === conversationId));
}

console.log("\nclear all");
{
  const before = await call("/api/conversations", { cookie });
  check("has chats to clear", before.json.conversations.length >= 2);
  const cleared = await call("/api/conversations", { method: "DELETE", cookie });
  check("clear-all reports a count", cleared.json.deleted >= 2, String(cleared.json.deleted));
  const after = await call("/api/conversations", { cookie });
  check("every chat is gone", after.json.conversations.length === 0);
  const usage = await call("/api/usage", { cookie });
  check("usage resets with them", usage.json.conversations === 0 && usage.json.messages === 0);
}

console.log("\nstatic files");
{
  const index = await call("/");
  check("serves index.html", index.res.status === 200 && index.text.includes("Technova AI"));
  const css = await call("/styles.css");
  check("serves the stylesheet", css.res.headers.get("content-type")?.includes("text/css"));
  const traversal = await call("/../package.json");
  check("blocks path traversal", !traversal.text.includes('"name": "technova-ai"'));
}

console.log("\nlogout");
{
  const out = await call("/api/auth/logout", { method: "POST", cookie });
  check("logout succeeds", out.res.status === 200);
  const me = await call("/api/auth/me", { cookie });
  check("session is dead after logout", me.res.status === 200 && me.json?.user === null);
}

await stop();
rmSync(process.env.DB_PATH, { force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
