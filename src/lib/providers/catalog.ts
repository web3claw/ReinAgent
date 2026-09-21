export type ProviderType = "deepseek" | "openai" | "anthropic" | "gemini" | "ollama" | "custom";

export interface ProviderMeta {
  id: ProviderType;
  name: string;
  defaultBaseUrl: string;
  defaultModelId: string;
  api: "openai-completions" | "anthropic-messages" | "google-generative-ai";
  models: { id: string; name: string }[];
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModelId: "deepseek-chat",
    api: "openai-completions",
    models: [
      { id: "deepseek-chat", name: "DeepSeek-V3 (Chat)" },
      { id: "deepseek-reasoner", name: "DeepSeek-R1 (Reasoner)" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModelId: "gpt-4o",
    api: "openai-completions",
    models: [
      { id: "gpt-4o", name: "GPT-4o (Omni)" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      { id: "o1", name: "o1 (Reasoning)" },
      { id: "o3-mini", name: "o3-mini" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModelId: "claude-3-7-sonnet-latest",
    api: "anthropic-messages",
    models: [
      { id: "claude-3-7-sonnet-latest", name: "Claude 3.7 Sonnet" },
      { id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet" },
      { id: "claude-3-5-haiku-latest", name: "Claude 3.5 Haiku" },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModelId: "gemini-2.5-flash",
    api: "google-generative-ai",
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultModelId: "qwen2.5-coder",
    api: "openai-completions",
    models: [
      { id: "qwen2.5-coder", name: "Qwen 2.5 Coder" },
      { id: "deepseek-r1", name: "DeepSeek-R1 (Local)" },
      { id: "llama3.3", name: "Llama 3.3" },
    ],
  },
  {
    id: "custom",
    name: "Custom (OpenAI Compatible)",
    defaultBaseUrl: "http://localhost:8000/v1",
    defaultModelId: "custom-model",
    api: "openai-completions",
    models: [
      { id: "custom-model", name: "Custom Model" },
    ],
  },
];

export const DEFAULT_PROVIDER: ProviderType = "deepseek";
export const DEFAULT_MODEL_ID = "deepseek-chat";

export function getProviderMeta(provider: ProviderType): ProviderMeta {
  return PROVIDERS.find((p) => p.id === provider) || PROVIDERS[0];
}

export function getAllModelsForProvider(provider: ProviderType) {
  const meta = getProviderMeta(provider);
  return meta.models;
}
