// Server-side settings: a place to paste the API key once, without editing files.
// Precedence: real environment variable > value saved through the app.
import { data, save } from "./store.js";

const FIELDS = ["nvidiaApiKey", "tavilyApiKey", "searchUrl"];

function bucket() {
  const db = data();
  if (!db.settings || typeof db.settings !== "object") db.settings = {};
  return db.settings;
}

export function get(field) {
  return bucket()[field] || "";
}

export function set(fields) {
  const store = bucket();
  for (const field of FIELDS) {
    if (!(field in fields)) continue;
    const value = String(fields[field] || "").trim();
    if (value) store[field] = value.slice(0, 400);
    else delete store[field];
  }
  save();
  return store;
}

/** Environment wins, so a host's variables always override anything pasted in the UI. */
export const apiKey = () => process.env.NVIDIA_API_KEY || get("nvidiaApiKey");
export const tavilyKey = () => process.env.TAVILY_API_KEY || get("tavilyApiKey");
export const searxUrl = () => process.env.SEARCH_URL || get("searchUrl");

export const hasKey = () => Boolean(apiKey());

const mask = (value) => (value ? `••••${value.slice(-4)}` : "");

export function summary() {
  return {
    hasKey: hasKey(),
    keyHint: mask(apiKey()),
    keyFromEnv: Boolean(process.env.NVIDIA_API_KEY),
    search: tavilyKey() ? "tavily" : searxUrl() ? "searxng" : "none",
    searchHint: mask(tavilyKey()),
    searchUrl: searxUrl(),
    searchFromEnv: Boolean(process.env.TAVILY_API_KEY || process.env.SEARCH_URL),
  };
}
