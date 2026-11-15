// Server-side settings: a place to paste the API key once, without editing files.
// Precedence: real environment variable > value saved through the app.
import { data, save } from "./store.js";

const FIELDS = ["provider", "sarvamApiKey", "nvidiaApiKey", "tavilyApiKey", "searchUrl"];

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
export const sarvamKey = () => process.env.SARVAM_API_KEY || get("sarvamApiKey");
export const nvidiaKey = () => process.env.NVIDIA_API_KEY || get("nvidiaApiKey");

/** Which provider to use: an explicit choice, else whichever has a key, else local. */
export function provider() {
  const chosen = get("provider");
  if (chosen === "sarvam" && sarvamKey()) return "sarvam";
  if (chosen === "nvidia" && nvidiaKey()) return "nvidia";
  if (sarvamKey()) return "sarvam";
  if (nvidiaKey()) return "nvidia";
  return "local";
}

export const apiKey = () => (provider() === "nvidia" ? nvidiaKey() : sarvamKey());
export const tavilyKey = () => process.env.TAVILY_API_KEY || get("tavilyApiKey");
export const searxUrl = () => process.env.SEARCH_URL || get("searchUrl");

export const hasKey = () => provider() !== "local";

const mask = (value) => (value ? `••••${value.slice(-4)}` : "");

export function summary() {
  const active = provider();
  return {
    hasKey: hasKey(),
    provider: active,
    sarvamHint: mask(sarvamKey()),
    nvidiaHint: mask(nvidiaKey()),
    sarvamFromEnv: Boolean(process.env.SARVAM_API_KEY),
    nvidiaFromEnv: Boolean(process.env.NVIDIA_API_KEY),
    keyHint: mask(active === "nvidia" ? nvidiaKey() : sarvamKey()),
    keyFromEnv: Boolean(active === "nvidia" ? process.env.NVIDIA_API_KEY : process.env.SARVAM_API_KEY),
    search: tavilyKey() ? "tavily" : searxUrl() ? "searxng" : "none",
    searchHint: mask(tavilyKey()),
    searchUrl: searxUrl(),
    searchFromEnv: Boolean(process.env.TAVILY_API_KEY || process.env.SEARCH_URL),
  };
}
