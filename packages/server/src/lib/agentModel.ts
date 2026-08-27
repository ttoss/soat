import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { GoogleVertexProviderSettings } from '@ai-sdk/google-vertex';
import { createVertex } from '@ai-sdk/google-vertex';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AiProviderSlug } from '@soat/postgresdb';
import type { LanguageModel } from 'ai';

import { DomainError } from '../errors';
import { loadAwsExternalAccountAuthClient } from './vertexAwsCredentials';

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
 * Resolves the Bedrock credential precedence: a secret-linked apiKey wins over
 * `config.apiKey`, which wins over a complete access-key/secret-key pair.
 * Pulled out of `buildBedrockModel` so the rules can be asserted directly
 * rather than through the opaque model object they configure.
 *
 * With no bearer token and no complete static pair it falls back to the AWS
 * default credential chain (`fromNodeProviderChain`) so role-based auth works.
 * `@ai-sdk/amazon-bedrock` does NOT walk that chain on its own (vercel/ai#2216)
 * — passing no credentials makes it throw a SigV4 error instead.
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

/**
 * Vertex serves models from a regional endpoint, so a location is always part
 * of the URL. `us-central1` carries the widest model availability and is the
 * region Google's own quickstarts use, mirroring how `bedrock` defaults to
 * `us-east-1` rather than making every provider record spell it out.
 */
const DEFAULT_VERTEX_LOCATION = 'us-central1';

/**
 * A linked secret for a `vertex` provider is either a GCP service-account key
 * file pasted verbatim (hence the snake_case field names — they are Google's,
 * not ours) or an express-mode API key.
 */
type VertexSecret = {
  apiKey?: string;
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

export type VertexSettings =
  | { apiKey: string }
  | {
      project: string;
      location: string;
      googleAuthOptions?: GoogleVertexProviderSettings['googleAuthOptions'];
    };

const parseVertexSecret = (secretValue: string | null): VertexSecret => {
  if (!secretValue) return {};
  try {
    const parsed: unknown = JSON.parse(secretValue);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as VertexSecret;
    }
  } catch {
    // Not JSON — fall through to the plain-API-key reading below.
  }
  // Every other API-key provider stores the bare key as the secret value, so
  // a non-object secret is read the same way here.
  return { apiKey: secretValue };
};

const readServiceAccountAuth = (
  secret: VertexSecret
): GoogleVertexProviderSettings['googleAuthOptions'] | undefined => {
  if (!secret.client_email || !secret.private_key) {
    return undefined;
  }
  return {
    credentials: {
      client_email: secret.client_email,
      private_key: secret.private_key,
    },
  };
};

/**
 * Resolves which of Vertex's three authentication modes a provider record asks
 * for. Pulled out of `buildVertexModel` for the same reason as
 * `resolveBedrockCredentials`: the model object the AI SDK returns does not
 * reveal which credential branch it took.
 *
 * An API key selects Vertex "express mode", which talks to a project-less
 * global endpoint, so `project` and `location` are meaningless there and are
 * left out of the returned settings. Otherwise the request is signed with the
 * linked service account, or with Application Default Credentials when none is
 * linked, which `google-auth-library` resolves on its own.
 */
export const resolveVertexSettings = (args: {
  secretValue: string | null;
  config?: Record<string, unknown>;
}): VertexSettings => {
  const secret = parseVertexSecret(args.secretValue);
  // config.apiKey is accepted as a credential fallback when no secret is linked
  const apiKey = secret.apiKey ?? (args.config?.apiKey as string | undefined);
  if (apiKey) {
    return { apiKey };
  }

  // A service-account key file names its own project, so linking one is
  // enough — config.project only has to be set to override it or when
  // authenticating through ADC.
  const project =
    (args.config?.project as string | undefined) ?? secret.project_id;
  if (!project) {
    throw new DomainError(
      'AI_PROVIDER_MISCONFIGURED',
      "A 'vertex' AI provider needs a Google Cloud project: set config.project, or link a secret holding the service-account key file."
    );
  }

  const location =
    (args.config?.location as string | undefined) ?? DEFAULT_VERTEX_LOCATION;

  const googleAuthOptions = readServiceAccountAuth(secret);
  return googleAuthOptions
    ? { project, location, googleAuthOptions }
    : { project, location };
};

/**
 * Attaches an AWS-federated auth client when Application Default Credentials
 * are in play and the configured ADC file federates an AWS identity.
 *
 * Kept out of `resolveVertexSettings` so that stays a pure function of the
 * provider record: this branch depends on the process environment and the file
 * it names.
 *
 * Only the ADC case is touched. Express mode carries no `project`, and a linked
 * service-account key already produced its own `googleAuthOptions` — both
 * explicit choices the provider record made.
 */
const withAwsWorkloadIdentity = (settings: VertexSettings): VertexSettings => {
  if (!('project' in settings) || settings.googleAuthOptions) {
    return settings;
  }
  const authClient = loadAwsExternalAccountAuthClient();
  if (!authClient) {
    return settings;
  }
  return { ...settings, googleAuthOptions: { authClient } };
};

const buildVertexModel = (args: BuildModelArgs): LanguageModel => {
  return createVertex(withAwsWorkloadIdentity(resolveVertexSettings(args)))(
    args.model
  );
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
  vertex: buildVertexModel,
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
