import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AiProviderSlug } from '@soat/postgresdb';
import type { LanguageModel } from 'ai';

type BuildModelArgs = {
  provider: AiProviderSlug;
  secretValue: string | null;
  model: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
};

type BedrockSecret = {
  apiKey?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

export type BedrockCredentials =
  | { region: string; apiKey: string }
  | {
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    }
  | {
      region: string;
      credentialProvider: ReturnType<typeof fromNodeProviderChain>;
    };

const parseBedrockSecret = (secretValue: string | null): BedrockSecret => {
  if (!secretValue) return {};
  try {
    return JSON.parse(secretValue) as BedrockSecret;
  } catch {
    // Plain ABSK bearer token stored directly as the secret value
    if (secretValue.startsWith('ABSK')) {
      return { apiKey: secretValue };
    }
    return {};
  }
};

/**
 * Resolves the Bedrock credential precedence: a secret-linked apiKey wins
 * over `config.apiKey`, which wins over a complete access-key/secret-key
 * pair. Pulled out of `buildBedrockModel` so the precedence rules can be
 * asserted directly instead of only through the opaque model object they
 * configure.
 *
 * When no bearer token and no complete static key pair is available, this
 * falls back to the AWS default credential chain (`fromNodeProviderChain`)
 * so role-based auth works (ECS task role, EC2 instance profile, SSO, env
 * vars). `@ai-sdk/amazon-bedrock` does NOT walk that chain on its own
 * (vercel/ai#2216) — passing no credentials at all makes it throw a SigV4
 * error instead of resolving role credentials itself.
 */
export const resolveBedrockCredentials = (args: {
  secretValue: string | null;
  config?: Record<string, unknown>;
}): BedrockCredentials => {
  const secret = parseBedrockSecret(args.secretValue);
  const region = (args.config?.region as string | undefined) ?? 'us-east-1';
  // config.apiKey is accepted as a credential fallback when no secret is linked
  const configApiKey = args.config?.apiKey as string | undefined;
  const resolvedApiKey = secret.apiKey ?? configApiKey;
  if (resolvedApiKey) {
    return { region, apiKey: resolvedApiKey };
  }
  if (secret.accessKeyId && secret.secretAccessKey) {
    return {
      region,
      accessKeyId: secret.accessKeyId,
      secretAccessKey: secret.secretAccessKey,
      sessionToken: secret.sessionToken,
    };
  }
  return { region, credentialProvider: fromNodeProviderChain() };
};

const buildBedrockModel = (args: BuildModelArgs): LanguageModel => {
  const options = resolveBedrockCredentials(args);
  return createAmazonBedrock(options)(args.model);
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
