// Answer provider: the live model when a key is configured, otherwise the local skills.
import { answerFor, fallbackAnswer } from "./skills.js";

const upstreamUrl = () => process.env.MODEL_ENDPOINT || "https://integrate.api.nvidia.com/v1/chat/completions";
const modelMap = () => ({
  "Technova 1.0 Flash": process.env.MODEL_FAST || "meta/llama-3.1-8b-instruct",
  "Technova 1.5 Pro": process.env.MODEL_PRO || "meta/llama-3.3-70b-instruct",
});

export const hasKey = () => Boolean(process.env.NVIDIA_API_KEY);
export const upstreamModel = (label) => modelMap()[label] || modelMap()["Technova 1.0 Flash"];

const SYSTEM_PROMPT =
  "You are Technova AI, a helpful assistant. Answer in the user's language. Be accurate and concise: " +
  "a few sentences, or a short list when steps are involved. If you are unsure, say so.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Streams an answer.
 * @returns {Promise<{text:string, source:string}>}
 */
export async function streamAnswer({ text, modelLabel, systemPrompt, deepThink = false, search = null, onStep, onDelta, onReason, signal }) {
  onStep?.("Read your message");

  // Deterministic skills always win: they are exact and instant.
  const local = answerFor(text);
  if (local) {
    onStep?.(`Matched the ${local.label} skill`);
    await emitChunks(local.markdown, onDelta);
    return { text: local.markdown, source: local.label };
  }
  onStep?.("No skill matched — this needs the model");

  if (!hasKey()) {
    onStep?.("No model key on the server, so answering locally");
    const answer = fallbackAnswer();
    await emitChunks(answer, onDelta);
    return { text: answer, source: "Local" };
  }

  const model = upstreamModel(modelLabel);
  const thinkBlock = deepThink
    ? "Think carefully before answering: outline the steps, check each assumption, then give a short, direct answer. " +
      "Put your reasoning first, then a line with 'Answer:' before the final response."
    : "";
  const searchBlock = search && search.ok && search.results.length
    ? "Web results you may use (cite the URL when you rely on one):\n" +
      search.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n")
    : "";

  onStep?.(`Calling ${modelLabel} (${model})${deepThink ? " in deep-think mode" : ""}`);

  try {
    const res = await fetch(upstreamUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: [SYSTEM_PROMPT, systemPrompt ? `User instructions: ${systemPrompt}` : "", thinkBlock, searchBlock]
              .filter(Boolean).join("\n\n"),
          },
          { role: "user", content: text },
        ],
        temperature: deepThink ? 0.3 : 0.5,
        max_tokens: deepThink ? 1600 : 700,
        stream: true,
      }),
      signal,
    });

    if (!res.ok) throw new Error(`upstream returned HTTP ${res.status}`);

    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/event-stream")) {
      const json = await res.json();
      const message = json?.choices?.[0]?.message;
      if (message?.reasoning_content) onReason?.(message.reasoning_content);
      const body = message?.content || json?.choices?.[0]?.text || "";
      if (!body) throw new Error("empty response from upstream");
      onStep?.("Received the full reply");
      await emitChunks(body, onDelta);
      return { text: body, source: modelLabel };
    }

    let full = "", reasoning = "", buf = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta || json?.choices?.[0]?.message || {};
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            onReason?.(delta.reasoning_content);
          }
          if (delta.content) {
            if (!full) onStep?.("Streaming the reply");
            full += delta.content;
            onDelta?.(delta.content);
          }
        } catch {
          /* keep-alive or a partial frame — ignore */
        }
      }
    }

    if (!full) throw new Error("upstream sent no content");
    return { text: full, source: modelLabel };
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    const note = `**Live model unavailable** (${err.message}) — answering from the local skills instead.\n\n`;
    const answer = note + fallbackAnswer();
    onStep?.("Falling back to local answers");
    await emitChunks(answer, onDelta);
    return { text: answer, source: "Local" };
  }
}

/** Sends text to the client in small pieces so the UI streams even for instant answers. */
async function emitChunks(text, onDelta, size = 18) {
  if (!onDelta) return;
  for (let i = 0; i < text.length; i += size) {
    onDelta(text.slice(i, i + size));
    await sleep(6);
  }
}

/* ---------------- model catalogue ---------------- */
const BUILT_IN = [
  { id: "Technova 1.0 Flash", label: "Technova 1.0 Flash", upstream: upstreamModel("Technova 1.0 Flash"), builtin: true },
  { id: "Technova 1.5 Pro", label: "Technova 1.5 Pro", upstream: upstreamModel("Technova 1.5 Pro"), builtin: true },
];

let cache = { at: 0, models: null };

/** Lists every model the configured key can see, falling back to the built-ins. */
export async function listModels() {
  if (!hasKey()) return { source: "builtin", models: BUILT_IN };
  if (cache.models && Date.now() - cache.at < 10 * 60_000) {
    return { source: "upstream", cached: true, models: cache.models };
  }
  const base = upstreamUrl().replace(/\/chat\/completions\/?$/, "");
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const upstream = (json.data || json.models || [])
      .map((m) => m.id || m.name)
      .filter(Boolean)
      .sort();
    if (!upstream.length) throw new Error("empty catalogue");
    const models = upstream.map((id) => ({ id, label: id, upstream: id, builtin: false }));
    cache = { at: Date.now(), models };
    return { source: "upstream", models };
  } catch (err) {
    return { source: "builtin", error: err.message, models: BUILT_IN };
  }
}
