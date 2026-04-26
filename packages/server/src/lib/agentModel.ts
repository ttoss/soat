import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { AiProviderSlug } from '@soat/postgresdb';
import type { LanguageModel } from 'ai';

type BuildModelArgs = {
  provider: AiProviderSlug;
  secretValue: string | null;
  model: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
};

const buildBedrockModel = (args: BuildModelArgs): LanguageModel => {
  const apiKey = args.secretValue ?? '';
  let parsedCredentials:
    | { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string }
    | undefined;
  if (apiKey) {
    try {
      parsedCredentials = JSON.parse(apiKey);
    } catch {
      // fall back to default AWS credential chain
    }
  }
  const region = (args.config?.region as string | undefined) ?? 'us-east-1';
  return createAmazonBedrock({
    region,
    accessKeyId: parsedCredentials?.accessKeyId,
    secretAccessKey: parsedCredentials?.secretAccessKey,
    sessionToken: parsedCredentials?.sessionToken,
  })(args.model);
};

const buildOllamaModel = (args: BuildModelArgs): LanguageModel => {
  const base =
    args.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  return createOpenAI({ apiKey: 'ollama', baseURL: `${base}/v1` }).chat(
    args.model
  );
};

const buildAzureModel = (args: BuildModelArgs): LanguageModel => {
  const apiKey = args.secretValue ?? '';
  const resourceName = (args.config?.resourceName as string | undefined) ?? '';
  return createAzure({ apiKey, resourceName })(args.model);
};

const buildSimpleOpenAiCompatModel = (args: BuildModelArgs): LanguageModel => {
  const apiKey = args.secretValue ?? '';
  return createOpenAI({ apiKey, baseURL: args.baseUrl }).chat(args.model);
};

type ProviderBuilder = (args: BuildModelArgs) => LanguageModel;

const PROVIDER_BUILDERS: Partial<Record<AiProviderSlug, ProviderBuilder>> = {
  openai: (a) => {
    return createOpenAI({ apiKey: a.secretValue ?? '', baseURL: a.baseUrl })(
      a.model
    );
  },
  anthropic: (a) => {
    return createAnthropic({ apiKey: a.secretValue ?? '', baseURL: a.baseUrl })(
      a.model
    );
  },
  google: (a) => {
    return createGoogleGenerativeAI({ apiKey: a.secretValue ?? '' })(a.model);
  },
  xai: (a) => {
    return createXai({ apiKey: a.secretValue ?? '' })(a.model);
  },
  groq: (a) => {
    return createGroq({ apiKey: a.secretValue ?? '' })(a.model);
  },
  azure: buildAzureModel,
  bedrock: buildBedrockModel,
  ollama: buildOllamaModel,
  gateway: buildSimpleOpenAiCompatModel,
  custom: buildSimpleOpenAiCompatModel,
};

export const buildModel = (args: BuildModelArgs): LanguageModel => {
  const builder = PROVIDER_BUILDERS[args.provider];
  if (!builder) {
    throw new Error(`Unsupported AI provider: ${args.provider}`);
  }
  return builder(args);
};
