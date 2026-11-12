// Real browser automation, used by the agent's open_browser tool.
// playwright-core is optional: if it isn't installed, the tool says so instead of crashing.
import { existsSync } from "node:fs";

const CANDIDATES = [
  process.env.BROWSER_PATH,
  "/usr/local/bin/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

let cached = null;

async function getChromium() {
  if (cached) return cached;
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    return { error: "playwright-core is not installed — run: npm i playwright-core" };
  }
  const executablePath = CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) return { error: "no Chromium found — set BROWSER_PATH to a Chrome/Chromium binary" };
  cached = { chromium, executablePath };
  return cached;
}

/**
 * Opens a page in a real browser and returns what it rendered.
 * @param {{url:string, waitFor?:string, screenshot?:boolean}} args
 */
export async function openBrowser({ url, waitFor = "body", timeout = 15000 } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, reason: "that isn't a valid URL" };
  }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, reason: "only http and https are allowed" };

  const host = parsed.hostname;
  const isPrivate = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[?::1\]?$)/i.test(host);
  if (isPrivate && process.env.ALLOW_LOCAL_FETCH !== "1") {
    return { ok: false, reason: "that address is not reachable from here" };
  }

  const got = await getChromium();
  if (got.error) return { ok: false, reason: got.error };

  let browser;
  try {
    browser = await got.chromium.launch({
      executablePath: got.executablePath,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const response = await page.goto(parsed.toString(), { waitUntil: "domcontentloaded", timeout });
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 5000 }).catch(() => {});
    const title = await page.title();
    const text = await page.evaluate(() => {
      const body = document.body ? document.body.innerText : "";
      return body.replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
    });
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .slice(0, 15)
        .map((a) => ({ text: a.innerText.trim().slice(0, 80), href: a.href }))
        .filter((l) => l.text),
    );
    return {
      ok: true,
      url: page.url(),
      status: response ? response.status() : null,
      title,
      text: text.slice(0, 4000),
      links,
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
