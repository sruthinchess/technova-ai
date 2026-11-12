// Settings: the key can be pasted once and used, without touching a file.
import { rmSync } from "node:fs";

process.env.ALLOW_SIGNUP = "1"; // tests create their own accounts
process.env.DB_PATH = "./data/settings-test.json";
delete process.env.NVIDIA_API_KEY;
delete process.env.TAVILY_API_KEY;
delete process.env.SEARCH_URL;
rmSync(process.env.DB_PATH, { force: true });

const { start, stop } = await import("../server.js");
const port = await start(0);
const base = `http://127.0.0.1:${port}`;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

const signup = await fetch(`${base}/api/auth/signup`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "s@example.com", password: "correct-horse", name: "S" }),
});
const cookie = (signup.headers.getSetCookie()[0] || "").split(";")[0];
const call = (path, opts = {}) =>
  fetch(base + path, {
    ...opts,
    headers: { Cookie: cookie, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
  });

console.log("\nbefore any key");
{
  const res = await call("/api/settings");
  const body = await res.json();
  check("reports no key", body.hasKey === false, JSON.stringify(body));
  const health = await (await fetch(`${base}/api/health`)).json();
  check("health says local mode", health.provider === "local", health.provider);
}

console.log("\nafter pasting a key");
{
  const put = await call("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ nvidiaApiKey: "nvapi-pasted-key-1234", tavilyApiKey: "tvly-abc-9876" }),
  });
  const saved = await put.json();
  check("key is accepted", saved.hasKey === true, JSON.stringify(saved));
  check("key comes back masked", saved.keyHint === "••••1234", saved.keyHint);
  check("the key itself is never returned", !JSON.stringify(saved).includes("nvapi-pasted-key"));
  check("search provider detected", saved.search === "tavily", saved.search);

  const health = await (await fetch(`${base}/api/health`)).json();
  check("health flips to the live model", health.provider === "nvidia", health.provider);

  const chat = await fetch(`${base}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message: "12.5% of 8400" }),
  });
  check("exact skills still answer instantly", (await chat.text()).includes("1050"));
}

console.log("\nclearing");
{
  const del = await call("/api/settings", { method: "DELETE" });
  const cleared = await del.json();
  check("clears the key", cleared.hasKey === false, JSON.stringify(cleared));
  const health = await (await fetch(`${base}/api/health`)).json();
  check("back to local mode", health.provider === "local", health.provider);
}

console.log("\nauth");
{
  const anon = await fetch(`${base}/api/settings`);
  check("needs a session", anon.status === 401, String(anon.status));
}

await stop();
rmSync(process.env.DB_PATH, { force: true });
console.log(`\n${failed ? failed + " failed" : "all settings checks passed"}\n`);
process.exit(failed ? 1 : 0);
