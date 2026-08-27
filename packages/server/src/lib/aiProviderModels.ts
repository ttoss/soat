import type { AiProviderSlug } from '@soat/postgresdb';
import createDebug from 'debug';
import { GoogleAuth } from 'google-auth-library';

import { DomainError } from '../errors';
import type { VertexSettings } from './agentModel';
import { resolveBedrockCredentials, resolveVertexSettings } from './agentModel';
import { resolveAiProviderSecret } from './aiProviders';
import type {
  BedrockListArgs,
  BedrockModelSummary,
} from './bedrockModelCatalog';
import { defaultListFoundationModels } from './bedrockModelCatalog';
import { loadAwsExternalAccountAuthClient } from './vertexAwsCredentials';

const log = createDebug('soat:provider-models');

const ANTHROPIC_VERSION = '2023-06-01';
const GOOGLE_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * A model a provider says it can run, in the vocabulary the wire uses. Every
 * field beyond `id` is optional because no two providers describe their
 * catalogues alike — Bedrock reports modalities and a lifecycle, an
 * OpenAI-compatible endpoint reports an id and little else.
 */
export type ProviderModel = {
  id: string;
  display_name?: string;
  vendor?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  streaming?: boolean;
  lifecycle?: 'active' | 'legacy' | 'deprecated';
  inference_types?: string[];
};

/**
 * The slice of `fetch` this module uses. Narrow on purpose: it is the seam the
 * tests replace, and a narrow shape is one a fake can satisfy without pulling
 * in the whole `Response` surface.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

// Re-exported so a caller enumerating models needs only this module, while the
// AWS SDK adapter itself stays in a file that can be read without it.
export type { BedrockListArgs, BedrockModelSummary };

/**
 * The Google auth options a Vertex access token is minted from. Derived from
 * `VertexSettings` rather than restated, so the two cannot drift.
 */
export type VertexAccessTokenArgs = {
  googleAuthOptions?: Extract<
    VertexSettings,
    { project: string }
  >['googleAuthOptions'];
};

export type EnumerateProviderModelsArgs = {
  provider: AiProviderSlug;
  baseUrl?: string;
  config?: Record<string, unknown>;
  secretValue?: string | null;
  /** Injectable HTTP boundary. */
  fetchImpl?: FetchLike;
  /** Injectable Google access token, so Vertex is testable without GCP. */
  accessTokenProvider?: (args?: VertexAccessTokenArgs) => Promise<string>;
  /** Injectable AWS control-plane call, so Bedrock is testable without AWS. */
  listFoundationModels?: (
    args: BedrockListArgs
  ) => Promise<BedrockModelSummary[]>;
};

/** Adapts the platform `fetch` to the narrow shape above. */
const nodeFetch: FetchLike = (url, init) => {
  return globalThis.fetch(url, init);
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const asArray = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value : [];
};

const asString = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const configString = (
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined => {
  return asString(config?.[key]);
};

/** Provider vocabulary is SHOUTING; ours is not. */
const lowercaseAll = (values: unknown): string[] | undefined => {
  const mapped = asArray(values)
    .map((value) => {
      return asString(value)?.toLowerCase();
    })
    .filter((value): value is string => {
      return value !== undefined;
    });
  return mapped.length > 0 ? mapped : undefined;
};

const readJson = async (args: {
  fetchImpl: FetchLike;
  url: string;
  headers: Record<string, string>;
  provider: AiProviderSlug;
}): Promise<Record<string, unknown>> => {
  const response = await args.fetchImpl(args.url, {
    method: 'GET',
    headers: args.headers,
  });
  const body = await response.text();

  if (!response.ok) {
    // The provider's own message is the only useful part of this failure, so it
    // is carried through rather than flattened into a generic "listing failed".
    throw new DomainError(
      'MODEL_LISTING_FAILED',
      `The ${args.provider} provider rejected the model listing request (HTTP ${response.status}): ${body.slice(0, 500)}`
    );
  }

  try {
    return asRecord(JSON.parse(body)) ?? {};
  } catch {
    throw new DomainError(
      'MODEL_LISTING_FAILED',
      `The ${args.provider} provider answered the model listing request with a body that is not JSON.`
    );
  }
};

const requireSecret = (args: {
  secretValue?: string | null;
  provider: AiProviderSlug;
}): string => {
  if (!args.secretValue) {
    throw new DomainError(
      'AI_PROVIDER_MISCONFIGURED',
      `Listing models from a ${args.provider} provider needs its API key: link a secret to the provider first.`
    );
  }
  return args.secretValue;
};

/**
 * Every OpenAI-compatible endpoint answers `GET {base}/models` with a
 * `{ data: [{ id }] }` payload — which is why one enumerator serves openai,
 * groq, xai and any gateway or self-hosted endpoint reached through `base_url`.
 */
const enumerateOpenAiCompatible = async (
  args: EnumerateProviderModelsArgs & { fetchImpl: FetchLike }
): Promise<ProviderModel[]> => {
  const base = args.baseUrl ?? 'https://api.openai.com/v1';
  const payload = await readJson({
    fetchImpl: args.fetchImpl,
    url: `${base.replace(/\/$/, '')}/models`,
    headers: {
      authorization: `Bearer ${requireSecret(args)}`,
    },
    provider: args.provider,
  });

  return asArray(payload.data).flatMap((entry) => {
    const record = asRecord(entry);
    const id = asString(record?.id);
    if (!id) return [];
    const vendor = asString(record?.owned_by);
    return [
      {
        id,
        ...(vendor ? { vendor } : {}),
        streaming: true,
      },
    ];
  });
};

const enumerateAnthropic = async (
  args: EnumerateProviderModelsArgs & { fetchImpl: FetchLike }
): Promise<ProviderModel[]> => {
  const base = args.baseUrl ?? 'https://api.anthropic.com/v1';
  const payload = await readJson({
    fetchImpl: args.fetchImpl,
    url: `${base.replace(/\/$/, '')}/models`,
    headers: {
      // Anthropic authenticates on its own header and requires a pinned API
      // version; a Bearer token here comes back as an unhelpful 401.
      'x-api-key': requireSecret(args),
      'anthropic-version': ANTHROPIC_VERSION,
    },
    provider: args.provider,
  });

  return asArray(payload.data).flatMap((entry) => {
    const record = asRecord(entry);
    const id = asString(record?.id);
    if (!id) return [];
    const displayName = asString(record?.display_name);
    return [
      {
        id,
        ...(displayName ? { display_name: displayName } : {}),
        vendor: 'anthropic',
        streaming: true,
      },
    ];
  });
};

const enumerateGoogleAiStudio = async (
  args: EnumerateProviderModelsArgs & { fetchImpl: FetchLike }
): Promise<ProviderModel[]> => {
  const base =
    args.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  const payload = await readJson({
    fetchImpl: args.fetchImpl,
    url: `${base.replace(/\/$/, '')}/models`,
    headers: { 'x-goog-api-key': requireSecret(args) },
    provider: args.provider,
  });

  return asArray(payload.models).flatMap((entry) => {
    const record = asRecord(entry);
    // Google names a model `models/gemini-2.5-flash`; the id an agent sets is
    // the bare trailing segment.
    const id = asString(record?.name)?.replace(/^models\//, '');
    if (!id) return [];
    const displayName = asString(record?.displayName);
    const methods = lowercaseAll(record?.supportedGenerationMethods) ?? [];
    return [
      {
        id,
        ...(displayName ? { display_name: displayName } : {}),
        vendor: 'google',
        streaming: methods.includes('streamgeneratecontent'),
      },
    ];
  });
};

/**
 * Builds a Google access token the same way model building resolves Vertex
 * credentials: an AWS-federated ADC file when one is configured, otherwise
 * stock Application Default Credentials.
 */
/* istanbul ignore next -- resolving real Google credentials cannot run in CI;
   every caller-visible branch around it is driven through
   `accessTokenProvider`. */
const defaultVertexAccessToken = async (
  args?: VertexAccessTokenArgs
): Promise<string> => {
  // A linked service-account key is an explicit choice by the provider record
  // and outranks anything ambient, exactly as it does when building a model.
  if (args?.googleAuthOptions) {
    const auth = new GoogleAuth({
      ...args.googleAuthOptions,
      scopes: GOOGLE_CLOUD_SCOPE,
    });
    const token = await auth.getAccessToken();
    if (!token) {
      throw new DomainError(
        'AI_PROVIDER_MISCONFIGURED',
        'Listing Vertex models with the linked service account produced no access token.'
      );
    }
    return token;
  }

  const authClient = loadAwsExternalAccountAuthClient();
  const auth = authClient
    ? new GoogleAuth({ authClient, scopes: GOOGLE_CLOUD_SCOPE })
    : new GoogleAuth({ scopes: GOOGLE_CLOUD_SCOPE });
  const token = await auth.getAccessToken();
  if (!token) {
    throw new DomainError(
      'AI_PROVIDER_MISCONFIGURED',
      'Listing Vertex models needs Google credentials, and Application Default Credentials resolved to none.'
    );
  }
  return token;
};

/**
 * Vertex's `launchStage` enum is `LAUNCH_STAGE_UNSPECIFIED | EXPERIMENTAL |
 * PRIVATE_PREVIEW | PUBLIC_PREVIEW | GA` — `DEPRECATED` is not in it, so the
 * branch that used to look for it was dead and every model fell through to
 * `active`, preview and experimental ones included (#1089).
 *
 * Only `GA` maps: it is the one stage that means what `active` means. Nothing
 * in the enum means `legacy` or `deprecated`, and a preview stage is not
 * `active`, so the remaining stages report no lifecycle at all rather than a
 * wrong one — a caller reads "the provider did not say" instead of a claim
 * the listing cannot support.
 */
const readVertexLifecycle = (
  launchStage: string | undefined
): ProviderModel['lifecycle'] | undefined => {
  if (launchStage === 'GA') return 'active';
  return undefined;
};

const readBedrockLifecycle = (
  status: string | undefined
): ProviderModel['lifecycle'] => {
  if (status === 'LEGACY') return 'legacy';
  if (status === 'DEPRECATED') return 'deprecated';
  return 'active';
};

/**
 * The host `publisherModels.list` is served from for a location.
 *
 * A region prefixes the host with its own name, but three of Vertex's location
 * values are not regions and take a different host shape each:
 *
 * | `location`    | host                                      |
 * | ------------- | ----------------------------------------- |
 * | `global`      | `aiplatform.googleapis.com`               |
 * | `eu` / `us`   | `aiplatform.<eu\|us>.rep.googleapis.com`   |
 * | anything else | `<location>-aiplatform.googleapis.com`    |
 *
 * Interpolating those three into the regional shape builds a host that does
 * not exist, and Google answers a non-host with the same generic HTML 404 that
 * #1080 chased — so listing failed with `MODEL_LISTING_FAILED` for every
 * provider configured that way (#1087). Confirmed with #1080's unauthenticated
 * probe, which separates the two: a real endpoint answers `401 UNAUTHENTICATED`,
 * a non-endpoint answers the HTML 404.
 *
 * ```
 * aiplatform.googleapis.com          401   global-aiplatform.googleapis.com  404
 * aiplatform.eu.rep.googleapis.com   401   eu-aiplatform.googleapis.com      404
 * ```
 *
 * `global` is not a corner case: several current Gemini models are served
 * there and 404 in a region, so it is the location those providers have to be
 * configured with. This mirrors the mapping the AI SDK applies when it builds
 * generation's `baseURL`, which is why the same record could generate and yet
 * fail to list — keep the two in step if Google adds a fourth host shape.
 */
const vertexListingHost = (location: string): string => {
  if (location === 'global') return 'https://aiplatform.googleapis.com';
  return location === 'eu' || location === 'us'
    ? `https://aiplatform.${location}.rep.googleapis.com`
    : `https://${location}-aiplatform.googleapis.com`;
};

/**
 * Vertex is the one provider where enumeration earns its keep on its own:
 * which Gemini versions a project can actually reach varies by project and
 * location, and a model the catalogue merely assumes exists fails at generation
 * time with a 404 that reads like an auth problem.
 */
const enumerateVertex = async (
  args: EnumerateProviderModelsArgs & { fetchImpl: FetchLike }
): Promise<ProviderModel[]> => {
  // The same resolution model building uses, so a record that generates can
  // list: the project may come from the service-account key file, and the
  // linked key signs the call instead of whatever ADC the server holds.
  const settings = resolveVertexSettings({
    secretValue: args.secretValue ?? null,
    config: args.config,
  });

  if ('apiKey' in settings) {
    // `publisherModels.list` answers an API key with `401 UNAUTHENTICATED`, and
    // express mode holds no other credential to list with.
    throw new DomainError(
      'MODEL_LISTING_UNSUPPORTED',
      'A Vertex provider in express mode (API key) cannot list models: the publisher-model listing rejects API keys and needs a credential that asserts a principal. Link a service-account key, or authenticate through Application Default Credentials, to list.'
    );
  }

  const { location } = settings;
  const token = await (args.accessTokenProvider ?? defaultVertexAccessToken)({
    googleAuthOptions: settings.googleAuthOptions,
  });

  const payload = await readJson({
    fetchImpl: args.fetchImpl,
    // Rooted at `publishers/*`, not the project-scoped path generation's
    // `baseURL` uses — that shape is one Google does not serve, and its HTML
    // 404 surfaced as MODEL_LISTING_FAILED for every vertex caller (#1080).
    // `project` stays required by `resolveVertexSettings` even though it no
    // longer reaches the URL: it selects the branch that mints the token and is
    // what the token is billed against. `PUBLISHER_MODEL_VIEW_FULL` is what
    // populates `launchStage`; `pageSize` stays unsent because the bare call
    // answers the whole regional catalogue and 500 is rejected with a `400`.
    url: `${vertexListingHost(location)}/v1beta1/publishers/google/models?view=PUBLISHER_MODEL_VIEW_FULL`,
    headers: { authorization: `Bearer ${token}` },
    provider: args.provider,
  });

  return asArray(payload.publisherModels).flatMap((entry) => {
    const record = asRecord(entry);
    const id = asString(record?.name)?.replace(
      /^publishers\/google\/models\//,
      ''
    );
    if (!id) return [];
    const lifecycle = readVertexLifecycle(asString(record?.launchStage));
    return [
      {
        id,
        vendor: 'google',
        // The listing carries no streaming field and serves embedding, TTS and
        // classification models too, so asserting `streaming: true` for every
        // entry was wrong for a good share of them (#1089).
        ...(lifecycle ? { lifecycle } : {}),
      },
    ];
  });
};

const enumerateBedrock = async (
  args: EnumerateProviderModelsArgs
): Promise<ProviderModel[]> => {
  const region =
    configString(args.config, 'region') ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new DomainError(
      'AI_PROVIDER_MISCONFIGURED',
      'Listing Bedrock models needs a region: set config.region on the provider, or AWS_REGION on the process.'
    );
  }

  // `resolveBedrockCredentials` defaults the region to us-east-1; listing
  // deliberately refuses to guess one (above), so the region resolved here
  // wins and only the credential half of that resolution is taken.
  const credentials = {
    ...resolveBedrockCredentials({
      secretValue: args.secretValue ?? null,
      config: args.config,
    }),
    region,
  };

  const summaries = await (
    args.listFoundationModels ?? defaultListFoundationModels
  )({ region, credentials });

  return summaries.flatMap((summary) => {
    if (!summary.modelId) return [];
    return [
      {
        id: summary.modelId,
        ...(summary.modelName ? { display_name: summary.modelName } : {}),
        ...(summary.providerName ? { vendor: summary.providerName } : {}),
        ...(lowercaseAll(summary.inputModalities)
          ? { input_modalities: lowercaseAll(summary.inputModalities) }
          : {}),
        ...(lowercaseAll(summary.outputModalities)
          ? { output_modalities: lowercaseAll(summary.outputModalities) }
          : {}),
        ...(summary.responseStreamingSupported === undefined
          ? {}
          : { streaming: summary.responseStreamingSupported }),
        lifecycle: readBedrockLifecycle(summary.modelLifecycle?.status),
        ...(lowercaseAll(summary.inferenceTypesSupported)
          ? { inference_types: lowercaseAll(summary.inferenceTypesSupported) }
          : {}),
      },
    ];
  });
};

type ModelEnumerator = (
  args: EnumerateProviderModelsArgs & { fetchImpl: FetchLike }
) => Promise<ProviderModel[]>;

/**
 * Which providers can be asked what they run, mirroring `PROVIDER_BUILDERS` in
 * `agentModel.ts`. Adding a provider is one entry here.
 *
 * `azure` and `ollama` are deliberately absent: Azure lists *deployments* an
 * operator named, and Ollama lists whatever was pulled onto that host, so
 * neither answers "which models can this provider run" in a way a shared
 * catalogue can use.
 */
const MODEL_ENUMERATORS: Partial<Record<AiProviderSlug, ModelEnumerator>> = {
  openai: enumerateOpenAiCompatible,
  groq: enumerateOpenAiCompatible,
  xai: enumerateOpenAiCompatible,
  gateway: enumerateOpenAiCompatible,
  custom: enumerateOpenAiCompatible,
  anthropic: enumerateAnthropic,
  google: enumerateGoogleAiStudio,
  vertex: enumerateVertex,
  bedrock: enumerateBedrock,
};

/**
 * Which providers can be asked what they run.
 */
export const isModelListingSupported = (provider: AiProviderSlug): boolean => {
  return MODEL_ENUMERATORS[provider] !== undefined;
};

export const listModelListingProviders = (): AiProviderSlug[] => {
  return Object.keys(MODEL_ENUMERATORS) as AiProviderSlug[];
};

/**
 * Asks a provider which models it can run.
 *
 * Returns provider-native ids — the same strings an agent's `model` or a
 * provider's `default_model` carries — so a caller can act on the answer
 * without translating it.
 */
export const enumerateProviderModels = async (
  args: EnumerateProviderModelsArgs
): Promise<ProviderModel[]> => {
  const enumerator = MODEL_ENUMERATORS[args.provider];
  if (!enumerator) {
    throw new DomainError(
      'MODEL_LISTING_UNSUPPORTED',
      `The ${args.provider} provider cannot enumerate models. Providers that can: ${listModelListingProviders().join(', ')}.`
    );
  }

  log('enumerateProviderModels: listing %s models', args.provider);
  const models = await enumerator({
    ...args,
    fetchImpl: args.fetchImpl ?? nodeFetch,
  });
  log(
    'enumerateProviderModels: %s returned %d models',
    args.provider,
    models.length
  );
  return models;
};

/**
 * Asks an existing AI provider record which models it can run, using that
 * provider's own stored credentials and configuration.
 *
 * The provider record is the unit of authorization and of credentials, which is
 * why this hangs off a provider rather than off a slug: two providers of the
 * same slug in the same project can legitimately see different catalogues.
 */
export const listAiProviderModels = async (args: {
  aiProviderId: string;
}): Promise<{ provider: AiProviderSlug; models: ProviderModel[] }> => {
  const resolved = await resolveAiProviderSecret({
    aiProviderId: args.aiProviderId,
  });
  if (!resolved) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found');
  }

  return {
    provider: resolved.provider,
    models: await enumerateProviderModels({
      provider: resolved.provider,
      baseUrl: resolved.baseUrl,
      config: resolved.config,
      secretValue: resolved.secretValue,
    }),
  };
};
