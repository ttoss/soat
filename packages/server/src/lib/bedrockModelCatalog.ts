import createDebug from 'debug';

import type { BedrockCredentials } from './agentModel';

const log = createDebug('soat:provider-models');

/** A Bedrock `ListFoundationModels` summary, as the AWS SDK returns one. */
export type BedrockModelSummary = {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  responseStreamingSupported?: boolean;
  modelLifecycle?: { status?: string };
  inferenceTypesSupported?: string[];
};

/**
 * What the Bedrock control-plane call needs. `credentials` carries whichever
 * mode the provider record selected — the same resolution generation uses — so
 * the listing signs as the record does rather than as the server happens to.
 */
export type BedrockListArgs = {
  region: string;
  credentials: BedrockCredentials;
};

/**
 * The subset of the Bedrock client's configuration this module sets. Written
 * out rather than inferred: inferring it names an internal type from
 * `@aws-sdk/credential-provider-node`, which TypeScript rejects as
 * unportable — and importing that type eagerly would defeat the lazy SDK
 * import below.
 */
type BedrockClientConfig = {
  region: string;
  token?: { token: string };
  credentials?:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | Extract<
        BedrockCredentials,
        { credentialProvider: unknown }
      >['credentialProvider'];
};

/**
 * Maps our resolved credential union onto the AWS client's own configuration
 * shape. Kept separate from the call below so the branch that decides *how* a
 * request is signed can be read (and reasoned about) without the SDK import.
 *
 * A Bedrock API key authenticates the control plane as a **bearer token**
 * rather than through SigV4, so it is passed as `token`, not `credentials` —
 * putting it in `credentials` yields a signing error, not an auth error.
 */
export const toBedrockClientConfig = (
  args: BedrockListArgs
): BedrockClientConfig => {
  const { credentials, region } = args;

  if ('apiKey' in credentials) {
    return { region, token: { token: credentials.apiKey } };
  }
  if ('accessKeyId' in credentials) {
    return {
      region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    };
  }
  return { region, credentials: credentials.credentialProvider };
};

/**
 * The AWS control-plane call, imported lazily so the Bedrock client is only
 * loaded by a deployment that actually lists Bedrock models.
 */
/* istanbul ignore next -- calling the real AWS control plane cannot run in CI;
   the mapping it feeds is driven through `listFoundationModels`, and the
   credential branch through `toBedrockClientConfig`. */
export const defaultListFoundationModels = async (
  args: BedrockListArgs
): Promise<BedrockModelSummary[]> => {
  const { BedrockClient, ListFoundationModelsCommand } =
    await import('@aws-sdk/client-bedrock');

  log('listFoundationModels: region=%s', args.region);
  const client = new BedrockClient(toBedrockClientConfig(args));
  const response = await client.send(new ListFoundationModelsCommand({}));
  return response.modelSummaries ?? [];
};
