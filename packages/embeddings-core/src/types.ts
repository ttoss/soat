export type EmbeddingProvider = 'ollama' | 'openai';

export interface OllamaConfig {
  model: string;
  host?: string;
}

export interface OpenAIConfig {
  apiKey: string;
  model?: string;
}

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  ollama?: OllamaConfig;
  openai?: OpenAIConfig;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  provider: EmbeddingProvider;
}
