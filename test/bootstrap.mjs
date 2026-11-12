// A fresh instance with ADMIN_EMAIL/ADMIN_PASSWORD creates the first account on boot.
import { rmSync } from "node:fs";

process.env.DB_PATH = "./data/bootstrap-test.json";
delete process.env.ALLOW_SIGNUP;
process.env.ADMIN_EMAIL = "boot@example.com";
process.env.ADMIN_PASSWORD = "correct-horse";
rmSync(process.env.DB_PATH, { force: true });

const { start, stop } = await import("../server.js");
const port = await start(0);
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "boot@example.com", password: "correct-horse" }),
});
check("env credentials create the first account", login.status === 200, String(login.status));

const signup = await fetch(`http://127.0.0.1:${port}/api/auth/signup`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "other@example.com", password: "correct-horse" }),
});
check("sign-up stays closed", signup.status === 403, String(signup.status));

await stop();
rmSync(process.env.DB_PATH, { force: true });
console.log(`\n${failed ? failed + " failed" : "bootstrap checks passed"}\n`);
process.exit(failed ? 1 : 0);
