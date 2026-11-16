// Model-agnostic provider adapter (OpenAI-compatible chat completions).
// Works with OpenAI, OpenRouter, Together, Groq, vLLM, llama.cpp server, Ollama (/v1), etc.
// This is prompt + retrieval customisation only. It does NOT change model weights.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatProvider {
  readonly id: string;
  chat(messages: ChatMessage[]): Promise<string>;
}

export interface OpenAICompatibleConfig {
  baseUrl: string; // e.g. https://api.openai.com/v1 or http://127.0.0.1:8080/v1
  model: string;
  apiKey?: string; // read from env by caller; never written to disk
  timeoutMs?: number;
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly id: string;
  constructor(private readonly cfg: OpenAICompatibleConfig) {
    this.id = `openai-compatible:${cfg.model}@${new URL(cfg.baseUrl).host}`;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 60_000);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.cfg.model, messages, temperature: 0 }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`provider HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("provider returned no message content");
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Build a provider from env, or return null when not configured (fail closed, no silent mock). */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): ChatProvider | null {
  const baseUrl = env.FE_PROVIDER_BASE_URL;
  const model = env.FE_PROVIDER_MODEL;
  if (!baseUrl || !model) return null;
  return new OpenAICompatibleProvider({ baseUrl, model, apiKey: env.FE_PROVIDER_API_KEY });
}

// ---------- selectable models (the presenter's "brain assist"; the engine still validates every answer) ----------

export interface ModelOption {
  id: "gemini" | "openai" | "claude" | "local";
  name: string;
  configured: boolean;
  missing: string[];
  model: string | null;
}

// Each vendor's OpenAI-compatible endpoint. Model ids are never guessed: they must be set explicitly.
const MODEL_ENDPOINTS: Record<Exclude<ModelOption["id"], "local">, { name: string; base: string; key: string; model: string }> = {
  gemini: { name: "Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", key: "GEMINI_API_KEY", model: "FE_MODEL_GEMINI" },
  openai: { name: "OpenAI", base: "https://api.openai.com/v1", key: "OPENAI_API_KEY", model: "FE_MODEL_OPENAI" },
  claude: { name: "Claude", base: "https://api.anthropic.com/v1", key: "ANTHROPIC_API_KEY", model: "FE_MODEL_CLAUDE" },
};

export function listModels(env: NodeJS.ProcessEnv = process.env): ModelOption[] {
  const out: ModelOption[] = Object.entries(MODEL_ENDPOINTS).map(([id, e]) => {
    const missing = [e.key, e.model].filter((k) => !env[k]);
    return { id: id as ModelOption["id"], name: e.name, configured: missing.length === 0, missing, model: env[e.model] ?? null };
  });
  const localMissing = ["FE_PROVIDER_BASE_URL", "FE_PROVIDER_MODEL"].filter((k) => !env[k]);
  out.push({ id: "local", name: "Local / other OpenAI-compatible", configured: localMissing.length === 0, missing: localMissing, model: env.FE_PROVIDER_MODEL ?? null });
  return out;
}

/** The selected model, or null (evidence-retrieval answers only). Never falls back to a different vendor silently. */
export function providerFor(id: string | undefined, env: NodeJS.ProcessEnv = process.env): ChatProvider | null {
  if (!id || id === "none") return null;
  if (id === "local") return providerFromEnv(env);
  const e = MODEL_ENDPOINTS[id as keyof typeof MODEL_ENDPOINTS];
  if (!e || !env[e.key] || !env[e.model]) return null;
  return new OpenAICompatibleProvider({ baseUrl: e.base, model: env[e.model]!, apiKey: env[e.key] });
}
