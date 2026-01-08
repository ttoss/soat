import * as ollamaProvider from './providers/ollama.js';
import * as openaiProvider from './providers/openai.js';
import type {
  EmbeddingConfig,
  EmbeddingResult,
  OllamaConfig,
  OpenAIConfig,
} from './types.js';

const getProvider = (args: { config: EmbeddingConfig }) => {
  const { config } = args;
  switch (config.provider) {
    case 'ollama':
      return ollamaProvider;
    case 'openai':
      return openaiProvider;
    default:
      throw new Error(`Unsupported embedding provider: ${config.provider}`);
  }
};

const getProviderConfig = (args: { config: EmbeddingConfig }) => {
  const { config } = args;
  switch (config.provider) {
    case 'ollama':
      if (!config.ollama) {
        throw new Error('Ollama config is required for ollama provider');
      }
      return config.ollama;
    case 'openai':
      if (!config.openai) {
        throw new Error('OpenAI config is required for openai provider');
      }
      return config.openai;
    default:
      throw new Error(`Unsupported embedding provider: ${config.provider}`);
  }
};

export const generateEmbedding = async (args: {
  config: EmbeddingConfig;
  text: string;
}): Promise<EmbeddingResult> => {
  const { config, text } = args;
  const provider = getProvider({ config });
  const providerConfig = getProviderConfig({ config });

  return provider.generateEmbedding({
    config: providerConfig as OllamaConfig & OpenAIConfig,
    text,
  });
};

export const generateEmbeddings = async (args: {
  config: EmbeddingConfig;
  texts: string[];
}): Promise<EmbeddingResult[]> => {
  const { config, texts } = args;
  const provider = getProvider({ config });
  const providerConfig = getProviderConfig({ config });

  return provider.generateEmbeddings({
    config: providerConfig as OllamaConfig & OpenAIConfig,
    texts,
  });
};

/**
 * Creates an embedding config from environment variables.
 * Supports:
 * - EMBEDDINGS_OLLAMA_MODEL: Ollama model name (uses Ollama provider)
 * - EMBEDDINGS_OLLAMA_HOST: Optional Ollama host URL
 * - EMBEDDINGS_OPENAI_KEY: OpenAI API key (uses OpenAI provider)
 * - EMBEDDINGS_OPENAI_MODEL: Optional OpenAI model name
 *
 * Priority: Ollama > OpenAI (if multiple are configured)
 */
export const getConfigFromEnv = (): EmbeddingConfig => {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const ollamaModel = process.env.EMBEDDINGS_OLLAMA_MODEL;
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const ollamaHost = process.env.EMBEDDINGS_OLLAMA_HOST;
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const openaiKey = process.env.EMBEDDINGS_OPENAI_KEY;
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const openaiModel = process.env.EMBEDDINGS_OPENAI_MODEL;

  if (ollamaModel) {
    return {
      provider: 'ollama',
      ollama: {
        model: ollamaModel,
        host: ollamaHost,
      },
    };
  }

  if (openaiKey) {
    return {
      provider: 'openai',
      openai: {
        apiKey: openaiKey,
        model: openaiModel,
      },
    };
  }

  throw new Error(
    'No embedding provider configured. Set EMBEDDINGS_OLLAMA_MODEL or EMBEDDINGS_OPENAI_KEY'
  );
};
