// Tiny JSON store: in-memory data with atomic writes to disk.
// No native modules, no database to install — the file is the database.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const dbPath = () => process.env.DB_PATH || join(process.cwd(), "data", "db.json");

const empty = () => ({ users: [], sessions: [], conversations: [], messages: [] });

let db = empty();
let writeTimer = null;

export function load() {
  if (existsSync(dbPath())) {
    try {
      const parsed = JSON.parse(readFileSync(dbPath(), "utf8"));
      db = { ...empty(), ...parsed };
    } catch (err) {
      console.error("[store] could not read db.json, starting empty:", err.message);
      db = empty();
    }
  }
  for (const key of Object.keys(empty())) if (!Array.isArray(db[key])) db[key] = [];
  return db;
}

export function data() {
  return db;
}

export function save() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      mkdirSync(dirname(dbPath()), { recursive: true });
      const tmp = `${dbPath()}.tmp`;
      writeFileSync(tmp, JSON.stringify(db, null, 2));
      renameSync(tmp, dbPath()); // atomic swap, so a crash can't leave a half file
    } catch (err) {
      console.error("[store] write failed:", err.message);
    }
  }, 30);
}

export function flush() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  try {
    mkdirSync(dirname(dbPath()), { recursive: true });
    writeFileSync(dbPath(), JSON.stringify(db, null, 2));
  } catch (err) {
    console.error("[store] flush failed:", err.message);
  }
}

export const id = () => randomUUID();
export const now = () => Date.now();
