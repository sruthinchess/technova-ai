// Tools test: a fake SearxNG and a fake page, so search + reading are exercised end to end.
import { createServer } from "node:http";
import { rmSync } from "node:fs";

process.env.ALLOW_SIGNUP = "1"; // tests create their own accounts
process.env.DB_PATH = "./data/tools-test.json";
rmSync(process.env.DB_PATH, { force: true });

// stand-in for a search backend and a web page
const fake = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/search") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      results: [
        { title: "Voice agent pricing", url: "https://example.com/pricing", content: "Pay as you go is 3.50 rupees per minute." },
        { title: "Voice agents overview", url: "https://example.com/voice", content: "Agents handle barge-in and voicemail." },
      ],
    }));
    return;
  }
  if (url.pathname === "/page") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>Pricing page</title></head><body><script>ignore()</script><h1>Rates</h1><p>Three fifty a minute.</p></body></html>");
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fakePort = fake.address().port;

process.env.SEARCH_URL = `http://127.0.0.1:${fakePort}/search`;
process.env.ALLOW_LOCAL_FETCH = "1"; // the fake page is on loopback

const { start, stop } = await import("../server.js");
const { searchWeb, fetchPage, searchProvider } = await import("../lib/tools.js");

const port = await start(0);
const base = `http://127.0.0.1:${port}`;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

console.log("\ntools directly");
{
  check("provider detected", searchProvider() === "searxng", searchProvider());
  const found = await searchWeb("voice agent pricing");
  check("search returns results", found.ok && found.results.length === 2, JSON.stringify(found).slice(0, 120));
  check("results carry urls", found.results[0].url === "https://example.com/pricing");

  const page = await fetchPage(`http://127.0.0.1:${fakePort}/page`);
  check("reads a page", page.ok && page.text.includes("Three fifty"), JSON.stringify(page).slice(0, 120));
  check("extracts the title", page.title === "Pricing page", page.title);
  check("strips scripts", !page.text.includes("ignore()"), page.text.slice(0, 60));

  const bad = await fetchPage("http://127.0.0.1:1/nope");
  check("reports a failed fetch", bad.ok === false && Boolean(bad.reason));
  const blocked = await fetchPage("http://localhost/admin");
  check("refuses loopback from a request", blocked.ok === false);
}

console.log("\nchat with search");
{
  const signup = await fetch(`${base}/api/auth/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "tools@example.com", password: "correct-horse", name: "Tools" }),
  });
  const cookie = (signup.headers.getSetCookie?.()[0] || "").split(";")[0];

  const chat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message: "how much do voice agents cost?", search: true, deepThink: true }),
  });
  const frames = (await chat.text()).split("\n\n").map((f) => {
    const e = (f.match(/^event: (.*)$/m) || [])[1];
    const d = (f.match(/^data: (.*)$/m) || [])[1];
    return e && d ? { event: e, data: JSON.parse(d) } : null;
  }).filter(Boolean);

  const steps = frames.filter((f) => f.event === "step").map((f) => f.data.text);
  const sources = frames.find((f) => f.event === "sources");
  const done = frames.find((f) => f.event === "done");

  check("announces the search", steps.some((t) => /Searching the web/.test(t)), steps.join(" | "));
  check("reports how many results", steps.some((t) => /Found 2 results/.test(t)), steps.join(" | "));
  check("streams the sources", sources?.data.results.length === 2);
  check("returns sources in done", done?.data.sources?.length === 2);
  check("still answers", frames.some((f) => f.event === "delta"));

  const noSearch = await fetch(`${base}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message: "12.5% of 8400" }),
  });
  const plain = await noSearch.text();
  check("no search when the toggle is off", !/Searching the web/.test(plain));
}

console.log("\npage endpoint");
{
  const res = await fetch(`${base}/api/tools/page`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: "" },
    body: JSON.stringify({ url: "https://example.com" }),
  });
  // no sign-in any more: a bad URL is a 400, not an auth failure
  check("is reachable without a session", res.status !== 401, String(res.status));
}

await stop();
fake.close();
rmSync(process.env.DB_PATH, { force: true });
console.log(`\n${failed ? failed + " failed" : "all tool checks passed"}\n`);
process.exit(failed ? 1 : 0);
