// Answer provider: the live model when a key is configured, otherwise the local skills.
import { answerFor, fallbackAnswer } from "./skills.js";
import { TOOL_SPECS, runTool } from "./tools.js";
import * as settings from "./settings.js";

const upstreamUrl = () => process.env.MODEL_ENDPOINT || "https://integrate.api.nvidia.com/v1/chat/completions";
const modelMap = () => ({
  "Technova 1.0 Flash": process.env.MODEL_FAST || "meta/llama-3.1-8b-instruct",
  "Technova 1.5 Pro": process.env.MODEL_PRO || "meta/llama-3.3-70b-instruct",
});

export const hasKey = () => settings.hasKey();
export const upstreamModel = (label) => modelMap()[label] || modelMap()["Technova 1.0 Flash"];

const SYSTEM_PROMPT =
  "You are Technova AI, a helpful assistant. Answer in the user's language. Be accurate and concise: " +
  "a few sentences, or a short list when steps are involved. If you are unsure, say so.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Streams an answer.
 * @returns {Promise<{text:string, source:string}>}
 */
export async function streamAnswer({ text, modelLabel, systemPrompt, deepThink = false, search = null, tools = true, onStep, onDelta, onReason, signal }) {
  onStep?.("Read your message");

  const local = answerFor(text);
  const exact = local && /^(Calculator|Unit converter|Dates & time)$/.test(local.label);

  // arithmetic, units and dates are exact and instant: never spend a model call on them
  if (exact) {
    onStep?.(`Matched the ${local.label} skill`);
    await emitChunks(local.markdown, onDelta);
    return { text: local.markdown, source: local.label };
  }

  // everything else goes to the agent, which can search, browse and calculate
  if (tools && hasKey()) {
    try {
      return await streamAgent({ text, modelLabel, systemPrompt, deepThink, onStep, onDelta, onReason, signal });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      onStep?.(`Agent failed: ${err.message}`);
      const answer = local ? local.markdown : fallbackAnswer();
      await emitChunks(answer, onDelta);
      return { text: answer, source: local ? local.label : "Local" };
    }
  }

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
        Authorization: `Bearer ${settings.apiKey()}`,
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


/* ---------------- agent: tool-calling loop ---------------- */
const MAX_STEPS = 4;

function toolLabel(call) {
  let args = {};
  try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
  const detail = args.query || args.url || args.expression || "";
  return `${call.function.name}(${detail ? String(detail).slice(0, 60) : ""})`;
}

/**
 * Runs the model with tools until it produces an answer.
 * Non-streaming on purpose: tool calls arrive whole, and the UI still sees every step.
 */
export async function streamAgent({ text, modelLabel, systemPrompt, deepThink, onStep, onDelta, onReason, signal }) {
  const model = upstreamModel(modelLabel);
  const messages = [
    {
      role: "system",
      content: [
        SYSTEM_PROMPT,
        "You can call tools. Prefer them over guessing: search for current facts, open pages to read them, " +
        "and calculate rather than doing arithmetic in your head. Cite URLs you used. When you have enough, answer.",
        deepThink ? "Think step by step before answering, then give a short final answer." : "",
        systemPrompt ? `User instructions: ${systemPrompt}` : "",
      ].filter(Boolean).join("\n\n"),
    },
    { role: "user", content: text },
  ];

  const used = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    onStep?.(step === 0 ? `Calling ${modelLabel} (${model}) with tools` : `Continuing with the tool results (step ${step + 1})`);

    const res = await fetch(upstreamUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey()}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: deepThink ? 0.3 : 0.5,
        max_tokens: deepThink ? 1600 : 900,
        tools: TOOL_SPECS,
        tool_choice: "auto",
      }),
      signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`upstream returned HTTP ${res.status}${detail ? ": " + detail.slice(0, 160) : ""}`);
    }

    const json = await res.json();
    const message = json?.choices?.[0]?.message;
    if (!message) throw new Error("upstream sent no message");
    if (message.reasoning_content) onReason?.(message.reasoning_content);

    const calls = message.tool_calls || [];
    if (!calls.length) {
      const answer = message.content || "";
      if (!answer) throw new Error("upstream sent an empty answer");
      onStep?.("Writing the answer");
      await emitChunks(answer, onDelta);
      return { text: answer, source: modelLabel, tools: used };
    }

    messages.push({ role: "assistant", content: message.content || "", tool_calls: calls });
    for (const call of calls) {
      const label = toolLabel(call);
      onStep?.(`Running ${label}`);
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
      const result = await runTool(call.function.name, args);
      used.push({ tool: call.function.name, args, ok: !result.error });
      onStep?.(result.error ? `${call.function.name} failed: ${result.error}` : `${call.function.name} returned`);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 6000),
      });
    }
  }

  // ran out of steps: answer from what we gathered
  messages.push({ role: "user", content: "Stop calling tools. Answer now with what you have." });
  const res = await fetch(upstreamUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
    body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: 900 }),
    signal,
  });
  if (!res.ok) throw new Error(`upstream returned HTTP ${res.status}`);
  const json = await res.json();
  const answer = json?.choices?.[0]?.message?.content || "";
  if (!answer) throw new Error("upstream sent an empty answer");
  onStep?.("Summarising what the tools found");
  await emitChunks(answer, onDelta);
  return { text: answer, source: modelLabel, tools: used };
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
      headers: { Authorization: `Bearer ${settings.apiKey()}` },
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
