// Tiny JSON store: in-memory data with atomic writes to disk.
// No native modules, no database to install — the file is the database.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const dbPath = () =>
  process.env.DB_PATH ||
  // Vercel and friends give you a read-only project directory; /tmp is the only
  // writable spot, and it is wiped between cold starts. Fine for a demo, not for
  // real accounts — point DB_PATH at a mounted disk or move to Postgres for that.
  (process.env.VERCEL ? join(tmpdir(), "technova", "db.json") : join(process.cwd(), "data", "db.json"));

const empty = () => ({ users: [], sessions: [], conversations: [], messages: [] });

let db = empty();
let writeTimer = null;
let lastStat = null; // file stamp of the last read/write

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
  try { const i = statSync(dbPath()); lastStat = `${i.mtimeMs}:${i.size}`; } catch { lastStat = null; }
  return db;
}

export function data() {
  return db;
}

/**
 * Reloads the file if something else (the CLI, another process) has written to it.
 * The store is in-memory for speed, so without this an account created by
 * `scripts/create-user.mjs` would be invisible until a restart.
 */
export function reloadIfChanged() {
  try {
    const info = statSync(dbPath());
    const stamp = `${info.mtimeMs}:${info.size}`;
    if (stamp === lastStat) return false;
    lastStat = stamp;
    const parsed = JSON.parse(readFileSync(dbPath(), "utf8"));
    db = { ...empty(), ...parsed };
    for (const key of Object.keys(empty())) if (!Array.isArray(db[key])) db[key] = [];
    return true;
  } catch {
    return false;
  }
}

function writeNow() {
  try {
    mkdirSync(dirname(dbPath()), { recursive: true });
    const tmp = `${dbPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(db, null, 2));
    renameSync(tmp, dbPath()); // atomic swap, so a crash can't leave a half file
    try { const i = statSync(dbPath()); lastStat = `${i.mtimeMs}:${i.size}`; } catch {}
  } catch (err) {
    console.error("[store] write failed:", err.message);
  }
}

export function save() {
  // serverless runtimes freeze the process as soon as the response is sent, so a
  // debounced write would be lost: write synchronously there
  if (process.env.VERCEL) return writeNow();
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeNow();
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
