// Sign-up is closed: the only ways in are the CLI script or ADMIN_EMAIL/ADMIN_PASSWORD.
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

process.env.DB_PATH = "./data/auth-off.json";
delete process.env.ALLOW_SIGNUP;
delete process.env.ADMIN_EMAIL;
delete process.env.ADMIN_PASSWORD;
rmSync(process.env.DB_PATH, { force: true });

const { start, stop } = await import("../server.js");
const port = await start(0);
const base = `http://127.0.0.1:${port}`;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

console.log("\nsign-up is closed");
{
  const res = await fetch(`${base}/api/auth/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nope@example.com", password: "correct-horse" }),
  });
  const body = await res.json();
  check("signup returns 403", res.status === 403, String(res.status));
  check("with a useful message", /disabled/.test(body.error || ""), body.error);
}

console.log("\nthe CLI creates the account");
{
  execFileSync(process.execPath, ["scripts/create-user.mjs", "owner@example.com", "correct-horse", "Owner"], {
    env: { ...process.env },
    stdio: "pipe",
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "correct-horse" }),
  });
  check("the created account can sign in", login.status === 200, String(login.status));
  const cookie = (login.headers.getSetCookie()[0] || "").split(";")[0];
  const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json();
  check("session works", me.user?.email === "owner@example.com");
}

await stop();
rmSync(process.env.DB_PATH, { force: true });

console.log(`\n${failed ? failed + " failed" : "all sign-up checks passed"}\n`);
process.exit(failed ? 1 : 0);
