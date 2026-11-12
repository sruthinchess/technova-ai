// Writes the model key into .env without it ever touching the repo or a chat window.
//   node scripts/setup-key.mjs nvapi-...
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const key = process.argv[2];
if (!key) {
  console.log("usage: node scripts/setup-key.mjs <your-api-key>");
  process.exit(1);
}

const path = ".env";
const lines = existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("NVIDIA_API_KEY="))
  : [];
lines.push(`NVIDIA_API_KEY=${key}`);
writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
console.log("Saved to .env (gitignored, chmod 600). Restart the server, then open the model menu.");
