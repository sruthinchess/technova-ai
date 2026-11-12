// Tools the assistant can call before answering: web search and page reading.
// Search needs a provider (Tavily key, or a SearxNG JSON endpoint). Page reading needs nothing.

const TIMEOUT_MS = 9000;

export const searchProvider = () =>
  process.env.TAVILY_API_KEY ? "tavily" : process.env.SEARCH_URL ? "searxng" : "none";

/** Returns { ok, provider, results: [{title,url,snippet}], reason? } */
export async function searchWeb(query, limit = 4) {
  const q = String(query || "").trim().slice(0, 300);
  if (!q) return { ok: false, provider: "none", results: [], reason: "empty query" };

  try {
    if (process.env.TAVILY_API_KEY) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query: q,
          max_results: limit,
          search_depth: "basic",
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`tavily HTTP ${res.status}`);
      const json = await res.json();
      const results = (json.results || []).slice(0, limit).map((r) => ({
        title: r.title || r.url, url: r.url, snippet: (r.content || "").slice(0, 400),
      }));
      return { ok: true, provider: "tavily", results };
    }

    if (process.env.SEARCH_URL) {
      const url = new URL(process.env.SEARCH_URL);
      url.searchParams.set("q", q);
      url.searchParams.set("format", "json");
      const headers = { Accept: "application/json" };
      if (process.env.SEARCH_API_KEY) headers.Authorization = `Bearer ${process.env.SEARCH_API_KEY}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`search HTTP ${res.status}`);
      const json = await res.json();
      const results = (json.results || []).slice(0, limit).map((r) => ({
        title: r.title || r.url, url: r.url, snippet: (r.content || "").slice(0, 400),
      }));
      return { ok: true, provider: "searxng", results };
    }
  } catch (err) {
    return { ok: false, provider: searchProvider(), results: [], reason: err.message };
  }

  return {
    ok: false,
    provider: "none",
    results: [],
    reason: "no search provider configured — set TAVILY_API_KEY or SEARCH_URL on the server",
  };
}

/** Fetches a page and returns readable text. Works with no key. */
export async function fetchPage(rawUrl, maxChars = 4000) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, reason: "that isn't a valid URL" };
  }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, reason: "only http and https are allowed" };
  // don't let a user-supplied URL reach loopback or private addresses (SSRF guard).
  // ALLOW_LOCAL_FETCH=1 relaxes it for local development and tests only.
  const host = url.hostname;
  const isPrivate = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[?::1\]?$)/i.test(host);
  if (isPrivate && process.env.ALLOW_LOCAL_FETCH !== "1") {
    return { ok: false, reason: "that address is not reachable from here" };
  }

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "TechnovaAI/1.0 (+page reader)", Accept: "text/html,text/plain" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, reason: `the page returned HTTP ${res.status}` };
    const type = res.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|application\/json/i.test(type)) {
      return { ok: false, reason: `unsupported content type: ${type.split(";")[0]}` };
    }
    const body = await res.text();
    const text = type.includes("html") ? htmlToText(body) : body;
    return {
      ok: true,
      url: res.url || url.toString(),
      title: (body.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || [])[1] || url.hostname,
      text: text.slice(0, maxChars),
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
