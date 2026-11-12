// Deterministic skills that run on the server: exact, instant, no model needed.
// Each returns { label, markdown } or null when it doesn't apply.

const fmt = (n) =>
  !isFinite(n) ? String(n) : Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : String(Math.round(n * 1e6) / 1e6);

/* ---------- calculator ---------- */
function evalExpr(src) {
  const toks = String(src).replace(/\s+/g, "").match(/(\d+\.?\d*|\.\d+|[+\-*/%^()])/g);
  if (!toks) return null;
  const out = [], ops = [], prec = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };
  const apply = () => {
    const op = ops.pop();
    if (op === "u-") { if (!out.length) return false; out.push(-out.pop()); return true; }
    const b = out.pop(), a = out.pop();
    if (a === undefined || b === undefined) return false;
    if (op === "+") out.push(a + b);
    else if (op === "-") out.push(a - b);
    else if (op === "*") out.push(a * b);
    else if (op === "/") out.push(a / b);
    else if (op === "%") out.push(a % b);
    else if (op === "^") out.push(Math.pow(a, b));
    return true;
  };
  let prev = "start";
  for (const t of toks) {
    if (/^[\d.]/.test(t)) { out.push(parseFloat(t)); prev = "num"; }
    else if (t === "(") { ops.push(t); prev = "op"; }
    else if (t === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") if (!apply()) return null;
      ops.pop(); prev = "num";
    } else {
      if (t === "-" && (prev === "start" || prev === "op")) { ops.push("u-"); continue; }
      while (ops.length && prec[ops[ops.length - 1]] >= prec[t]) if (!apply()) return null;
      ops.push(t); prev = "op";
    }
  }
  while (ops.length) if (!apply()) return null;
  return out.length === 1 && isFinite(out[0]) ? out[0] : null;
}

function math(text) {
  const pct = text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s*of\s*(\d+(?:\.\d+)?)/i);
  if (pct) {
    const v = (parseFloat(pct[1]) * parseFloat(pct[2])) / 100;
    return { label: "Calculator", markdown: `**${pct[1]}% of ${pct[2]}** = **${fmt(v)}**` };
  }
  const m = text.match(/(\d+(?:\.\d+)?\s*(?:[+\-*/%^]\s*\d+(?:\.\d+)?\s*)+)/);
  if (!m) return null;
  const v = evalExpr(m[1]);
  if (v === null) return null;
  return { label: "Calculator", markdown: `**${m[1].replace(/\s+/g, "")}** = **${fmt(v)}**` };
}

/* ---------- units ---------- */
const UNITS = {
  len: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, ft: 0.3048, in: 0.0254, yd: 0.9144 },
  mass: { kg: 1, g: 0.001, mg: 1e-6, lb: 0.45359237, oz: 0.028349523125, t: 1000 },
  data: { b: 1, kb: 1024, mb: 1048576, gb: 1073741824, tb: 1099511627776 },
};
const ALIAS = {
  metre: "m", metres: "m", meter: "m", meters: "m", kilometre: "km", kilometres: "km", kilometer: "km",
  kilometers: "km", mile: "mi", miles: "mi", foot: "ft", feet: "ft", inch: "in", inches: "in", yard: "yd",
  yards: "yd", kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg", gram: "g", grams: "g", pound: "lb",
  pounds: "lb", lbs: "lb", ounce: "oz", ounces: "oz", tonne: "t", tonnes: "t", byte: "b", bytes: "b",
  kilobyte: "kb", kilobytes: "kb", megabyte: "mb", megabytes: "mb", gigabyte: "gb", gigabytes: "gb",
  terabyte: "tb", terabytes: "tb",
};
const norm = (u) => {
  const s = String(u).toLowerCase().replace(/[°.]/g, "").trim();
  if (["c", "celsius", "centigrade"].includes(s)) return "c";
  if (["f", "fahrenheit"].includes(s)) return "f";
  if (["k", "kelvin"].includes(s)) return "k";
  return ALIAS[s] || s;
};
const dimOf = (u) => Object.keys(UNITS).find((k) => UNITS[k][u]) || null;

function units(text) {
  const l = text.toLowerCase();
  if (/(rupee|rupees|inr|₹|lakh|crore)/.test(l) && /\d/.test(l)) {
    const cr = l.match(/(\d+(?:\.\d+)?)\s*crore/);
    const lk = l.match(/(\d+(?:\.\d+)?)\s*lakh/);
    const num = cr ? parseFloat(cr[1]) * 1e7 : lk ? parseFloat(lk[1]) * 1e5 : parseFloat((l.match(/\d+(?:\.\d+)?/) || [0])[0]);
    if (num) {
      const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(num);
      const words = num >= 1e7 ? `${fmt(num / 1e7)} crore` : num >= 1e5 ? `${fmt(num / 1e5)} lakh` : fmt(num);
      return { label: "Unit converter", markdown: `**${inr}** — ${words}, written the Indian way (lakh / crore grouping).` };
    }
  }
  const m = l.match(/(-?\d+(?:\.\d+)?)\s*(?:degrees?\s*)?([a-z°]+)\s+(?:to|in|into|as|=)\s+(?:degrees?\s*)?([a-z°]+)/);
  if (!m) return null;
  const val = parseFloat(m[1]), a = norm(m[2]), b = norm(m[3]);
  if (a === b) return null;
  const temps = { c: 1, f: 1, k: 1 };
  if (temps[a] && temps[b]) {
    const c = a === "c" ? val : a === "f" ? ((val - 32) * 5) / 9 : val - 273.15;
    const r = b === "c" ? c : b === "f" ? (c * 9) / 5 + 32 : c + 273.15;
    return { label: "Unit converter", markdown: `**${fmt(val)}°${a.toUpperCase()}** = **${fmt(r)}°${b.toUpperCase()}**` };
  }
  const da = dimOf(a), db = dimOf(b);
  if (!da || da !== db) return null;
  const base = val * UNITS[da][a];
  return { label: "Unit converter", markdown: `**${fmt(val)} ${a}** = **${fmt(base / UNITS[db][b])} ${b}**` };
}

/* ---------- dates ---------- */
const ist = (d) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", weekday: "long", day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
};

function dates(text) {
  const l = text.toLowerCase();
  const now = new Date();
  const p = ist(now);
  const arith = l.match(/(\d+)\s*(day|days|week|weeks|month|months)\s*(from now|from today|later|after|ahead)/);
  if (arith) {
    const n = parseInt(arith[1], 10), unit = arith[2], d = new Date(now);
    if (unit.startsWith("day")) d.setDate(d.getDate() + n);
    else if (unit.startsWith("week")) d.setDate(d.getDate() + n * 7);
    else d.setMonth(d.getMonth() + n);
    const q = ist(d);
    return { label: "Dates & time", markdown: `**${n} ${unit} from today** is **${q.weekday}, ${q.day} ${q.month} ${q.year}**.` };
  }
  if (/\b(today|what.*date|date is it|which date)\b/.test(l))
    return { label: "Dates & time", markdown: `Today is **${p.weekday}, ${p.day} ${p.month} ${p.year}** (IST).` };
  if (/\b(time is it|current time|what.*time now|time now)\b/.test(l))
    return { label: "Dates & time", markdown: `It's **${p.hour}:${p.minute}** in India (IST, UTC+5:30).` };
  return null;
}

/* ---------- product knowledge ---------- */
const KB = [
  {
    id: "models", k: ["models", "model list", "what models", "which model", "1.0 flash", "1.5 pro", "which ai"],
    a: "There are two models in this build:\n\n- **Technova 1.0 Flash** — the fast default, built for quick answers and streaming.\n- **Technova 1.5 Pro** — the larger model, better at longer reasoning and multi-step questions.\n\nSwitch between them with the dropdown at the top of the chat.",
  },
  {
    id: "skills", k: ["skills", "what can you do", "capabilities", "features"],
    a: "**What this assistant can do:**\n\n- Arithmetic and percentages, computed exactly\n- Unit conversion and rupee formatting\n- Dates and time in IST\n- Questions about Technova AI — models, pricing, deployment\n\nWith a model key configured on the server it also answers open-ended questions; without one it stays on these deterministic skills.",
  },
  {
    id: "pricing", boost: 1.8, k: ["price", "pricing", "cost", "how much", "rate", "per minute"],
    a: "**Voice agent pricing** is per minute:\n\n- Pay as you go — **₹3.50 / min**\n- Pro — **₹3.25 / min**\n- Growth — **₹3.15 / min**\n- Business — **₹3.00 / min**\n- Enterprise — custom, on committed volume",
  },
  {
    id: "voice", k: ["voice agent", "calling", "phone", "samvaad"],
    a: "**Voice Agents** answer calls in the caller's language. The runtime handles barge-in, silences, voicemail detection and mid-call language switching, with telephony included when you rent an Indian number.",
  },
  {
    id: "api", k: ["api", "sdk", "endpoint", "developer", "integration"],
    a: "The platform exposes REST and WebSocket endpoints behind one key, with official Python and JavaScript SDKs. This app's own API is documented in the README — `POST /api/chat` streams answers as server-sent events.",
  },
  {
    id: "deploy", k: ["deploy", "hosting", "self host", "docker", "environment"],
    a: "It runs on plain Node 20 with no dependencies: `npm start`. Set `NVIDIA_API_KEY` for live model answers, and `PORT`, `DB_PATH` and `SESSION_SECRET` as needed. Any host that runs Node works — Vercel, Railway, Fly, or a VPS behind nginx.",
  },
];

function knowledge(text) {
  const lower = text.toLowerCase();
  let best = null, score = 0;
  for (const entry of KB) {
    let s = 0;
    for (const kw of entry.k) if (lower.includes(kw)) s += Math.min(kw.length, 18);
    s *= entry.boost || 1;
    if (s > score) { score = s; best = entry; }
  }
  return best && score >= 8 ? { label: "Product knowledge", markdown: best.a } : null;
}

export function answerFor(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  return math(t) || units(t) || dates(t) || knowledge(t);
}

export const fallbackAnswer = () =>
  "I can help with arithmetic, unit conversion, dates, and questions about Technova AI. " +
  "For open-ended answers, the server needs a model key — set `NVIDIA_API_KEY` and restart.";
