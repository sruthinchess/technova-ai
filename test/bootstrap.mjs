// A fresh instance is usable immediately: one local account, no sign-in.
import { rmSync } from "node:fs";

process.env.DB_PATH = "./data/bootstrap-test.json";
rmSync(process.env.DB_PATH, { force: true });

const { start, stop } = await import("../server.js");
const port = await start(0);
const base = `http://127.0.0.1:${port}`;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

const me = await (await fetch(`${base}/api/auth/me`)).json();
check("a fresh instance has a local account", me.user?.id === "local", JSON.stringify(me).slice(0, 80));
check("it reports auth is off", me.auth === "off");

const page = await fetch(`${base}/`);
const html = await page.text();
check("the app loads without signing in", page.status === 200 && html.includes("Technova AI"));
check("no login form in the markup", !html.includes("authForm"));

const chat = await fetch(`${base}/api/chat`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "12.5% of 8400" }),
});
check("chat works straight away", (await chat.text()).includes("1050"));

await stop();
rmSync(process.env.DB_PATH, { force: true });
console.log(`\n${failed ? failed + " failed" : "fresh-instance checks passed"}\n`);
process.exit(failed ? 1 : 0);
