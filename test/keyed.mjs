// With a key set but the upstream unreachable, the catalogue must degrade gracefully.
import { rmSync } from "node:fs";

process.env.DB_PATH = "./data/keyed-test.json";
process.env.NVIDIA_API_KEY = "nvapi-not-a-real-key-for-tests";
rmSync(process.env.DB_PATH, { force: true });

const { start, stop } = await import("../server.js");
const port = await start(0);
const base = `http://127.0.0.1:${port}`;

const health = await (await fetch(`${base}/api/health`)).json();

const signup = await fetch(`${base}/api/auth/signup`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "keyed@example.com", password: "correct-horse", name: "Keyed" }),
});
const cookie = (signup.headers.getSetCookie?.()[0] || signup.headers.get("set-cookie") || "").split(";")[0];
const models = await (await fetch(`${base}/api/models`, { headers: { Cookie: cookie } })).json();

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

check("health reports the key is present", health.provider === "nvidia", health.provider);
check("catalogue still answers", Array.isArray(models.models) && models.models.length > 0);
check("falls back to built-ins when upstream is unreachable", models.source === "builtin", models.source);
check("explains why", typeof models.error === "string" && models.error.length > 0, models.error);

await stop();
rmSync(process.env.DB_PATH, { force: true });
process.exit(failed ? 1 : 0);
