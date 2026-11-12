// Agent test: a fake model that calls tools, plus a fake web to call them against.
import { createServer } from "node:http";
import { rmSync } from "node:fs";

process.env.DB_PATH = "./data/agent-test.json";
rmSync(process.env.DB_PATH, { force: true });
process.env.ALLOW_LOCAL_FETCH = "1";

const seenRequests = [];
let mode = "tools"; // "tools" | "loop" | "plain"

const fake = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/search") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: [{ title: "Voice pricing", url: "http://127.0.0.1:9/page", content: "3.50 per minute" }] }));
    return;
  }
  if (url.pathname === "/page") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>Pricing</title></head><body><h1>Rates</h1><p>Three fifty a minute.</p></body></html>");
    return;
  }
  if (url.pathname === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const payload = JSON.parse(body || "{}");
      seenRequests.push(payload);
      const hasToolResult = payload.messages.some((m) => m.role === "tool");
      res.writeHead(200, { "Content-Type": "application/json" });

      if (mode === "tools" && !hasToolResult) {
        res.end(JSON.stringify({
          choices: [{ message: {
            role: "assistant", content: "",
            tool_calls: [{
              id: "call_1", type: "function",
              function: { name: "web_search", arguments: JSON.stringify({ query: "voice agent pricing" }) },
            }],
          } }],
        }));
        return;
      }
      if (mode === "loop") {
        res.end(JSON.stringify({
          choices: [{ message: {
            role: "assistant", content: "",
            tool_calls: [{
              id: "call_" + seenRequests.length, type: "function",
              function: { name: "calculate", arguments: JSON.stringify({ expression: "1+1" }) },
            }],
          } }],
        }));
        return;
      }
      res.end(JSON.stringify({
        choices: [{ message: {
          role: "assistant",
          content: hasToolResult
            ? "Voice agents cost 3.50 rupees a minute. Source: http://127.0.0.1:9/page"
            : "A plain answer without tools.",
        } }],
      }));
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fakePort = fake.address().port;

process.env.NVIDIA_API_KEY = "nvapi-test-key";
process.env.MODEL_ENDPOINT = `http://127.0.0.1:${fakePort}/v1/chat/completions`;
process.env.SEARCH_URL = `http://127.0.0.1:${fakePort}/search`;

const { start, stop } = await import("../server.js");
const { runTool } = await import("../lib/tools.js");

const port = await start(0);
const base = `http://127.0.0.1:${port}`;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

const parse = (text) =>
  text.split("\n\n").map((f) => {
    const e = (f.match(/^event: (.*)$/m) || [])[1];
    const d = (f.match(/^data: (.*)$/m) || [])[1];
    return e && d ? { event: e, data: JSON.parse(d) } : null;
  }).filter(Boolean);

const signup = await fetch(`${base}/api/auth/signup`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "agent@example.com", password: "correct-horse", name: "A" }),
});
const cookie = (signup.headers.getSetCookie()[0] || "").split(";")[0];

console.log("\ntool registry");
{
  const calc = await runTool("calculate", { expression: "(1250 * 0.18) / 3" });
  check("calculate is exact", calc.result === "75", JSON.stringify(calc));
  const time = await runTool("current_time", {});
  check("current_time answers IST", /IST$/.test(time.ist || ""), JSON.stringify(time).slice(0, 80));
  const bad = await runTool("nope", {});
  check("unknown tool is reported", Boolean(bad.error));
}

console.log("\nbrowser tool");
let browserInstalled = true;
try { await import("playwright-core"); } catch { browserInstalled = false; }
if (!browserInstalled) {
  console.log("  skip  playwright-core is not installed (optional dependency)");
} else {
  const page = await runTool("open_browser", { url: `http://127.0.0.1:${fakePort}/page` });
  check("opens a page in a real browser", page.title === "Pricing", JSON.stringify(page).slice(0, 140));
  check("returns rendered text", (page.text || "").includes("Three fifty"), String(page.text).slice(0, 60));
  const blocked = await runTool("open_browser", { url: "http://169.254.169.254/latest/meta-data" });
  check("refuses link-local addresses", Boolean(blocked.error), JSON.stringify(blocked));
}

console.log("\nagent loop");
{
  const res = await fetch(`${base}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message: "how much do voice agents cost?", agent: true }),
  });
  const frames = parse(await res.text());
  const steps = frames.filter((f) => f.event === "step").map((f) => f.data.text);
  const answer = frames.filter((f) => f.event === "delta").map((f) => f.data.text).join("");

  check("announces the tool call", steps.some((s) => /Running web_search/.test(s)), steps.join(" | "));
  check("reports the tool returned", steps.some((s) => /web_search returned/.test(s)), steps.join(" | "));
  check("streams a final answer", answer.includes("3.50"), answer.slice(0, 80));
  check("sends tools to the model", Array.isArray(seenRequests[0]?.tools) && seenRequests[0].tools.length >= 4);
  check("feeds the tool result back", seenRequests.some((r) => r.messages.some((m) => m.role === "tool")));
  check("keeps the tool call in the history", seenRequests.some((r) => r.messages.some((m) => m.tool_calls)));
}

console.log("\nagent off");
{
  const res = await fetch(`${base}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message: "hello there", agent: false }),
  });
  const frames = parse(await res.text());
  const steps = frames.filter((f) => f.event === "step").map((f) => f.data.text);
  check("no tool loop when agent is off", !steps.some((s) => /Running /.test(s)), steps.join(" | "));
}

console.log("\nstep limit");
{
  mode = "loop";
  const before = seenRequests.length;
  const res = await fetch(`${base}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message: "keep going", agent: true }),
  });
  const frames = parse(await res.text());
  const answer = frames.filter((f) => f.event === "delta").map((f) => f.data.text).join("");
  const calls = seenRequests.length - before;
  check("stops after the step limit", calls <= 5, `${calls} upstream calls`);
  check("still answers after hitting it", answer.length > 0, answer.slice(0, 60));
}

await stop();
fake.close();
rmSync(process.env.DB_PATH, { force: true });
console.log(`\n${failed ? failed + " failed" : "all agent checks passed"}\n`);
process.exit(failed ? 1 : 0);
