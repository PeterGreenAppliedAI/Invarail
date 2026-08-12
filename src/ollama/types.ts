export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  /** Base64-encoded images for vision models */
  images?: string[];
  /** Separated reasoning from thinking models (returned when `think` is enabled;
   *  requires gateway >= f0dfb63 which forwards it on non-streaming responses) */
  thinking?: string;
}

/** Ollama tool definition (OpenAI-compatible format) */
export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required?: string[];
    };
  };
}

export interface OllamaChatParams {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  /** Structured output: 'json' for free-form JSON mode, or a JSON schema object
   *  for grammar-constrained decoding (Ollama 0.5+; translated to response_format
   *  /guided_json for OpenAI-compatible backends). */
  format?: 'json' | Record<string, unknown>;
  /** Thinking control for reasoning models: true = separated thinking channel,
   *  false = suppress reasoning, unset = model default. Ollama returns 400 on
   *  models without thinking support — callers gate via config/model-caps. */
  think?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    stop?: string[];
    top_k?: number;
    top_p?: number;
    repeat_penalty?: number;
  };
  keep_alive?: string;
  stream?: boolean;
}

export interface OllamaChatResponse {
  model: string;
  message: OllamaMessage & { tool_calls?: OllamaToolCall[] };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

export interface OllamaGenerateParams {
  model: string;
  prompt: string;
  system?: string;
  /** Structured output: 'json' or a JSON schema object (see OllamaChatParams.format) */
  format?: 'json' | Record<string, unknown>;
  options?: {
    temperature?: number;
    num_predict?: number;
    stop?: string[];
    top_k?: number;
    top_p?: number;
    repeat_penalty?: number;
  };
  keep_alive?: string;
  stream?: false;
}

export interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export interface OllamaEmbedParams {
  model: string;
  input: string | string[];
  keep_alive?: string;
}

export interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
}
