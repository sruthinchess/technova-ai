// Model providers behind one interface. Sarvam is the primary; NVIDIA is optional.
// Keys come from the environment or the settings panel — never from the browser.

export const PROVIDERS = {
  sarvam: {
    label: "Sarvam AI",
    endpoint: "https://api.sarvam.ai/v1/chat/completions",
    envKey: "SARVAM_API_KEY",
    // the product's two model names map onto whatever the provider actually serves
    models: [
      { id: "sarvam-105b", label: "Infinity 1.0 Flash", hint: "Sarvam 105B · 128K context" },
      { id: "sarvam-105b-conversations", label: "Infinity 1.5 Pro", hint: "Sarvam 105B Conversations" },
    ],
  },
  nvidia: {
    label: "NVIDIA",
    endpoint: process.env.MODEL_ENDPOINT || "https://integrate.api.nvidia.com/v1/chat/completions",
    envKey: "NVIDIA_API_KEY",
    models: [
      { id: process.env.MODEL_FAST || "meta/llama-3.1-8b-instruct", label: "Infinity 1.0 Flash", hint: "NVIDIA · Llama 3.1 8B" },
      { id: process.env.MODEL_PRO || "meta/llama-3.3-70b-instruct", label: "Infinity 1.5 Pro", hint: "NVIDIA · Llama 3.3 70B" },
    ],
  },
};

/** Sarvam wants `api-subscription-key`; it also accepts Bearer. NVIDIA uses Bearer. */
export function authHeaders(provider, key) {
  if (provider === "sarvam") return { "api-subscription-key": key, Authorization: `Bearer ${key}` };
  return { Authorization: `Bearer ${key}` };
}

export function modelsFor(provider) {
  return (PROVIDERS[provider] || PROVIDERS.sarvam).models;
}

/** Maps a label from the UI back to the provider's model id. */
export function resolveModel(provider, wanted) {
  const list = modelsFor(provider);
  const hit = list.find((m) => m.id === wanted) || list.find((m) => m.label === wanted);
  return (hit || list[0]).id;
}
