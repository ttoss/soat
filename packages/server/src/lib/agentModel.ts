import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { GoogleVertexProviderSettings } from '@ai-sdk/google-vertex';
import { createVertex } from '@ai-sdk/google-vertex';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { AiProviderSlug } from '@soat/postgresdb';
import type { LanguageModel } from 'ai';
import { wrapLanguageModel } from 'ai';

import { DomainError } from '../errors';
import { assertNoConfigCredential } from './aiProviderConfigSecrets';
import { readUrlConfigValue } from './aiProviderConfigValidation';
import {
  answeringAs,
  buildForwardedModel,
  type ModelEndpoint,
  type ModelProvider,
  resolveServedModel,
} from './aiProviderModelAliases';
import {
  assertAmbientCredentialsAllowed,
  usesAnthropicTenantEndpoint,
} from './ambientCredentials';
import {
  ANTHROPIC_API_URL,
  requireAnthropicFederationSettings,
  withAnthropicFederatedToken,
} from './anthropicFederation';
import { egressGuardedFetch } from './egressFetch';
import {
  parseBedrockSecret,
  parseVertexSecret,
  refuseUnusableLinkedSecret,
  resolveBedrockCredentials,
  type VertexSecret,
} from './linkedProviderSecret';
import { bedrockModelCaches, withoutBedrockCachePoints } from './promptCaching';
import { loadAwsExternalAccountAuthClient } from './vertexAwsCredentials';

type BuildModelArgs = {
  /** The public id of the project the provider record belongs to. */
  project: string;
  provider: AiProviderSlug;
  secretValue: string | null;
  model: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
};

/**
 * Converse, for every vendor Bedrock serves. Anthropic-only features (tool
 * search, model betas) are InvokeModel-only and would need the SDK's separate
 * Bedrock-Anthropic path — see `modules/ai-providers.md`, Bedrock request path.
 */
const buildBedrockModel = (args: BuildModelArgs): LanguageModel => {
  const options = resolveBedrockCredentials({
    ...args,
    ambientFor: { project: args.project },
  });
  const model = createAmazonBedrock({ ...options, fetch: egressGuardedFetch })(
    args.model
  );
  if (bedrockModelCaches({ modelId: args.model })) return model;
  return wrapLanguageModel({ model, middleware: withoutBedrockCachePoints });
};

/**
 * Vertex serves models from a regional endpoint, so a location is always part
 * of the URL. `us-central1` carries the widest model availability and is the
 * region Google's own quickstarts use, mirroring how `bedrock` defaults to
 * `us-east-1` rather than making every provider record spell it out.
 */
const DEFAULT_VERTEX_LOCATION = 'us-central1';

export type VertexSettings =
  | { apiKey: string }
  | {
      project: string;
      location: string;
      googleAuthOptions?: GoogleVertexProviderSettings['googleAuthOptions'];
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
 * A service-account key file names its own project, so linking one is enough —
 * `config.project` only has to be set to override it, or where the deployment
 * lets a record authenticate with its own credentials.
 */
const resolveVertexProject = (args: {
  secret: VertexSecret;
  config?: Record<string, unknown>;
}): string => {
  const project =
    readUrlConfigValue({
      provider: 'vertex',
      key: 'project',
      value: args.config?.project,
    }) ?? args.secret.project_id;
  if (!project) {
    throw new DomainError(
      'AI_PROVIDER_MISCONFIGURED',
      "A 'vertex' AI provider needs a Google Cloud project: set config.project, or link a secret holding the service-account key file."
    );
  }
  return project;
};

/**
 * Resolves which of Vertex's three authentication modes a provider record asks
 * for. Apart from `buildVertexModel` for the same reason as
 * `resolveBedrockCredentials`: the model object the AI SDK returns does not
 * reveal which credential branch it took.
 *
 * An API key selects Vertex "express mode", which talks to a project-less
 * global endpoint, so `project` and `location` are meaningless there and are
 * left out of the returned settings. Otherwise the request is signed with the
 * linked service account, or — where the operator allows a record to use the
 * deployment's own credentials — with Application Default Credentials, which
 * `google-auth-library` resolves on its own.
 */
export const resolveVertexSettings = (args: {
  project: string;
  secretValue: string | null;
  config?: Record<string, unknown>;
}): VertexSettings => {
  assertNoConfigCredential({
    config: args.config,
    code: 'AI_PROVIDER_MISCONFIGURED',
  });
  const secret = parseVertexSecret(args.secretValue);
  if (secret.apiKey) {
    return { apiKey: secret.apiKey };
  }

  const googleAuthOptions = readServiceAccountAuth(secret);
  if (!googleAuthOptions) {
    // Neither an express-mode key nor a service-account key file: whatever
    // signs this request comes from the deployment, not from the record.
    refuseUnusableLinkedSecret({
      provider: 'vertex',
      secretValue: args.secretValue,
    });
    assertAmbientCredentialsAllowed({
      provider: 'vertex',
      project: args.project,
    });
  }

  const project = resolveVertexProject({ secret, config: args.config });

  const location =
    readUrlConfigValue({
      provider: 'vertex',
      key: 'location',
      value: args.config?.location,
    }) ?? DEFAULT_VERTEX_LOCATION;

  return googleAuthOptions
    ? { project, location, googleAuthOptions }
    : { project, location };
};

const SECRET_HOLDS_CREDENTIAL = {
  bedrock: (secretValue: string) => {
    const secret = parseBedrockSecret(secretValue);
    return Boolean(
      secret.apiKey || (secret.accessKeyId && secret.secretAccessKey)
    );
  },
  vertex: (secretValue: string) => {
    const secret = parseVertexSecret(secretValue);
    return Boolean(secret.apiKey || readServiceAccountAuth(secret));
  },
};

/**
 * The write-time half of {@link refuseUnusableLinkedSecret}, so the caller is
 * refused where they can still fix the record. `secretValue` is the linked
 * secret's value, `null` when the record links none.
 */
export const assertLinkedSecretUsable = (args: {
  provider: AiProviderSlug;
  secretValue: string | null;
}): void => {
  if (args.secretValue === null) return;
  if (args.provider !== 'bedrock' && args.provider !== 'vertex') return;
  if (SECRET_HOLDS_CREDENTIAL[args.provider](args.secretValue)) return;
  refuseUnusableLinkedSecret({
    provider: args.provider,
    secretValue: args.secretValue,
  });
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
  return createVertex({
    ...withAwsWorkloadIdentity(resolveVertexSettings(args)),
    fetch: egressGuardedFetch,
  })(args.model);
};

/**
 * The guard applies to the destination a **tenant** named, not to the one the
 * deployment did: `OLLAMA_BASE_URL` — and the loopback it defaults to — is an
 * operator's own decision about their own network, already made when they set
 * it. A `base_url` on the provider record is the tenant-written half, and that
 * is what an allowlist has to answer for.
 */
/**
 * A record that links no secret and names no endpoint of its own signs with
 * the deployment's federated identity, on the operator's opt-in.
 */
const buildAnthropicModel = (args: BuildModelArgs): LanguageModel => {
  if (args.secretValue !== null || usesAnthropicTenantEndpoint(args)) {
    return createAnthropic({
      apiKey: args.secretValue ?? '',
      baseURL: args.baseUrl,
      fetch: egressGuardedFetch,
    })(args.model);
  }
  assertAmbientCredentialsAllowed({
    provider: 'anthropic',
    project: args.project,
  });
  requireAnthropicFederationSettings();
  return createAnthropic({
    apiKey: '',
    // Pinned: the token is minted for Anthropic, so no setting may redirect it.
    baseURL: `${ANTHROPIC_API_URL}/v1`,
    fetch: withAnthropicFederatedToken({ fetchImpl: egressGuardedFetch }),
  })(args.model);
};

const buildOllamaModel = (args: BuildModelArgs): LanguageModel => {
  const base =
    args.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  return createOpenAI({
    apiKey: 'ollama',
    baseURL: `${base}/v1`,
    ...(args.baseUrl ? { fetch: egressGuardedFetch } : {}),
  }).chat(args.model);
};

const buildAzureModel = (args: BuildModelArgs): LanguageModel => {
  const apiKey = args.secretValue ?? '';
  const resourceName =
    readUrlConfigValue({
      provider: 'azure',
      key: 'resourceName',
      value: args.config?.resourceName,
    }) ?? '';
  return createAzure({ apiKey, resourceName, fetch: egressGuardedFetch })(
    args.model
  );
};

const buildSimpleOpenAiCompatModel = (args: BuildModelArgs): LanguageModel => {
  const apiKey = args.secretValue ?? '';
  return createOpenAI({
    apiKey,
    baseURL: args.baseUrl,
    fetch: egressGuardedFetch,
  }).chat(args.model);
};

type ProviderBuilder = (args: BuildModelArgs) => LanguageModel;

/** A vendor whose only credential is the record's API key. */
const keyedBuilder = (
  create: (settings: {
    apiKey: string;
    fetch: typeof egressGuardedFetch;
  }) => (model: string) => LanguageModel
): ProviderBuilder => {
  return (a) => {
    return create({ apiKey: a.secretValue ?? '', fetch: egressGuardedFetch })(
      a.model
    );
  };
};

const PROVIDER_BUILDERS: Partial<Record<AiProviderSlug, ProviderBuilder>> = {
  openai: (a) => {
    return createOpenAI({
      apiKey: a.secretValue ?? '',
      baseURL: a.baseUrl,
      fetch: egressGuardedFetch,
    })(a.model);
  },
  anthropic: buildAnthropicModel,
  google: keyedBuilder(createGoogleGenerativeAI),
  xai: keyedBuilder(createXai),
  groq: keyedBuilder(createGroq),
  azure: buildAzureModel,
  bedrock: buildBedrockModel,
  vertex: buildVertexModel,
  ollama: buildOllamaModel,
  gateway: buildSimpleOpenAiCompatModel,
  custom: buildSimpleOpenAiCompatModel,
};

const buildVendorModel = (args: {
  endpoint: ModelEndpoint;
  vendorModel: string;
}): LanguageModel => {
  const { endpoint } = args;
  const builder = PROVIDER_BUILDERS[endpoint.provider];
  if (!builder) {
    throw new Error(`Unsupported AI provider: ${endpoint.provider}`);
  }
  return builder({
    project: endpoint.projectPublicId,
    provider: endpoint.provider,
    secretValue: endpoint.secretValue,
    model: args.vendorModel,
    baseUrl: endpoint.baseUrl,
    config: endpoint.config,
  });
};

/**
 * The one place a model name reaches a vendor client
 * (`tests/harness/vendorModelChokepoint.test.mjs`): `model` is the name stored
 * beside the provider, an alias resolves here to its vendor id (and, when it
 * forwards, its target's endpoint), and the built model answers the alias.
 */
export const buildModel = (args: {
  aiProvider: ModelProvider;
  model: string;
}): LanguageModel => {
  const { aiProvider } = args;
  const { vendorModel, forwardedTo } = resolveServedModel(args);
  if (forwardedTo !== null) {
    return buildForwardedModel({
      aiProvider,
      alias: args.model,
      targetId: forwardedTo,
      vendorModel,
      build: buildVendorModel,
    });
  }
  const model = buildVendorModel({ endpoint: aiProvider, vendorModel });
  if (vendorModel === args.model) return model;
  if (typeof model === 'string') return model;
  return wrapLanguageModel({
    model,
    middleware: answeringAs(args.model),
    modelId: args.model,
  });
};
