// Minimal .env loader: Node has no built-in one before v20.6 flags, and this keeps
// `npm start` working whether or not a .env exists.
import { readFileSync, existsSync } from "node:fs";

export function loadEnv(path = ".env") {
  if (!existsSync(path)) return false;
  let loaded = 0;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) { // real environment wins over the file
      process.env[key] = value;
      loaded++;
    }
  }
  return loaded > 0;
}
