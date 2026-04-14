import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { AiProviderSlug } from '@soat/postgresdb';
import type { LanguageModel, ModelMessage } from 'ai';
import { generateText, streamText } from 'ai';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

const buildModel = (args: {
  provider: AiProviderSlug;
  secretValue: string | null;
  model: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
}): LanguageModel => {
  const { provider, secretValue, model, baseUrl, config } = args;
  const apiKey = secretValue ?? '';

  switch (provider) {
    case 'openai':
      return createOpenAI({ apiKey, baseURL: baseUrl })(model);

    case 'anthropic':
      return createAnthropic({ apiKey, baseURL: baseUrl })(model);

    case 'google':
      return createGoogleGenerativeAI({ apiKey })(model);

    case 'xai':
      return createXai({ apiKey })(model);

    case 'groq':
      return createGroq({ apiKey })(model);

    case 'azure': {
      const resourceName = (config?.resourceName as string | undefined) ?? '';
      return createAzure({ apiKey, resourceName })(model);
    }

    case 'bedrock': {
      let parsedCredentials:
        | {
            accessKeyId?: string;
            secretAccessKey?: string;
            sessionToken?: string;
          }
        | undefined;

      if (apiKey) {
        try {
          parsedCredentials = JSON.parse(apiKey);
        } catch {
          // fall back to default AWS credential chain
        }
      }

      const region = (config?.region as string | undefined) ?? 'us-east-1';

      return createAmazonBedrock({
        region,
        accessKeyId: parsedCredentials?.accessKeyId,
        secretAccessKey: parsedCredentials?.secretAccessKey,
        sessionToken: parsedCredentials?.sessionToken,
      })(model);
    }

    case 'ollama':
      return createOpenAI({
        apiKey: 'ollama',
        baseURL: baseUrl ? `${baseUrl}/v1` : undefined,
      })(model);

    case 'gateway':
    case 'custom':
      return createOpenAI({ apiKey, baseURL: baseUrl })(model);
  }
};

const resolveModel = async (args: {
  aiProviderId?: string;
  model?: string;
}): Promise<LanguageModel> => {
  if (args.aiProviderId) {
    const resolved = await resolveAiProviderSecret({
      aiProviderId: args.aiProviderId,
    });

    if (!resolved) {
      throw new Error('AI provider not found');
    }

    return buildModel({
      provider: resolved.provider,
      secretValue: resolved.secretValue,
      model: args.model ?? resolved.defaultModel,
      baseUrl: resolved.baseUrl,
      config: resolved.config as Record<string, unknown> | undefined,
    });
  }

  const fallbackModel = args.model ?? process.env.CHAT_MODEL ?? 'qwen2.5:0.5b';
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

  return createOpenAI({ apiKey: 'ollama', baseURL: `${ollamaBaseUrl}/v1` })(
    fallbackModel
  );
};

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export const createChatCompletion = async (args: {
  aiProviderId?: string;
  model?: string;
  messages: ChatMessage[];
}) => {
  const model = await resolveModel({
    aiProviderId: args.aiProviderId,
    model: args.model,
  });

  const result = await generateText({
    model,
    messages: args.messages as ModelMessage[],
  });

  return {
    model: result.response?.modelId ?? args.model ?? '',
    content: result.text,
    finishReason: result.finishReason,
  };
};

export const streamChatCompletion = async (args: {
  aiProviderId?: string;
  model?: string;
  messages: ChatMessage[];
}) => {
  const model = await resolveModel({
    aiProviderId: args.aiProviderId,
    model: args.model,
  });

  const result = streamText({
    model,
    messages: args.messages as ModelMessage[],
  });

  return result.textStream;
};
