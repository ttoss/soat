import { readFileSync } from 'node:fs';

import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import createDebug from 'debug';
import type { AuthClient } from 'google-auth-library';
import { AwsClient } from 'google-auth-library';

import { DomainError } from '../errors';

const log = createDebug('soat:vertex-aws');

/**
 * A Google credential configuration that federates an AWS identity — what
 * `gcloud iam workload-identity-pools create-cred-config --aws` writes. The
 * snake_case names are Google's, not ours.
 */
export type AwsExternalAccountConfig = {
  type: 'external_account';
  audience: string;
  subject_token_type: string;
  token_url: string;
  credential_source: { environment_id: string };
  service_account_impersonation_url?: string;
  universe_domain?: string;
};

export type AwsSecurityCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  token?: string;
};

/**
 * The shape `@aws-sdk/credential-providers` resolves to. Injectable so the
 * mapping below can be asserted without reaching for real AWS credentials.
 */
export type AwsCredentialProvider = () => Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}>;

export type AwsSecurityCredentialsSupplier = {
  getAwsRegion: () => Promise<string>;
  getAwsSecurityCredentials: () => Promise<AwsSecurityCredentials>;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

/**
 * Narrows a parsed credential configuration to the AWS-federated kind.
 *
 * Only `environment_id: aws1` qualifies: a file- or URL-sourced external
 * account, and Azure's, are external accounts too, but the AWS provider chain
 * has nothing to say about their subject tokens.
 */
export const isAwsExternalAccountConfig = (
  value: unknown
): value is AwsExternalAccountConfig => {
  const record = asRecord(value);
  if (!record || record.type !== 'external_account') {
    return false;
  }
  const source = asRecord(record.credential_source);
  if (!source || source.environment_id !== 'aws1') {
    return false;
  }
  return (
    typeof record.audience === 'string' &&
    typeof record.subject_token_type === 'string' &&
    typeof record.token_url === 'string'
  );
};

/**
 * Adapts the AWS default credential chain to the supplier interface
 * google-auth-library accepts in place of a `credential_source`.
 *
 * This exists because google-auth-library resolves AWS credentials from
 * exactly two places on its own: the `AWS_ACCESS_KEY_ID` family of
 * environment variables, or EC2 IMDS. Neither is how ECS delivers a task
 * role — that arrives on the container credentials endpoint
 * (`169.254.170.2`, named by `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`) — so a
 * stock configuration running on ECS either finds nothing or, where IMDS is
 * reachable, silently authenticates as the *instance* role instead. A pool
 * provider scoped to the task role rejects that with `unauthorized_client`.
 *
 * `fromNodeProviderChain` already walks every one of those sources in AWS's
 * own precedence order, and it is already a dependency here for Bedrock.
 */
export const createAwsSecurityCredentialsSupplier = (args: {
  credentialProvider?: AwsCredentialProvider;
  region?: string;
}): AwsSecurityCredentialsSupplier => {
  const resolveCredentials = args.credentialProvider ?? fromNodeProviderChain();

  return {
    getAwsRegion: async () => {
      const region =
        args.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      if (!region) {
        throw new DomainError(
          'AI_PROVIDER_MISCONFIGURED',
          'Federating an AWS identity to Google needs a region: set AWS_REGION (or AWS_DEFAULT_REGION) on the process. It signs the GetCallerIdentity call that proves the identity.'
        );
      }
      return region;
    },
    getAwsSecurityCredentials: async () => {
      const credentials = await resolveCredentials();
      // `token` is Google's name for what AWS calls `sessionToken`. Session
      // credentials without it produce a signature STS rejects.
      if (!credentials.sessionToken) {
        return {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
        };
      }
      return {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        token: credentials.sessionToken,
      };
    },
  };
};

/**
 * Builds an auth client for an AWS-federated configuration, sourcing the AWS
 * half from the provider chain rather than from the configuration's own
 * `credential_source`.
 *
 * `AwsClient` is constructed directly rather than through
 * `ExternalAccountClient.fromJSON`, which selects its subclass by looking for
 * `credential_source.environment_id` and therefore cannot dispatch on a
 * supplier alone — it would hand back an `IdentityPoolClient` that rejects the
 * configuration outright. The `credential_source` is left out on purpose:
 * carrying both it and a supplier is an error.
 */
export const buildAwsExternalAccountAuthClient = (args: {
  credentialConfig: AwsExternalAccountConfig;
  credentialProvider?: AwsCredentialProvider;
  region?: string;
}): AuthClient => {
  const { credentialConfig } = args;
  return new AwsClient({
    audience: credentialConfig.audience,
    subject_token_type: credentialConfig.subject_token_type,
    token_url: credentialConfig.token_url,
    service_account_impersonation_url:
      credentialConfig.service_account_impersonation_url,
    universe_domain: credentialConfig.universe_domain,
    aws_security_credentials_supplier: createAwsSecurityCredentialsSupplier({
      credentialProvider: args.credentialProvider,
      region: args.region,
    }),
  });
};

/**
 * Reads the ADC file named by `GOOGLE_APPLICATION_CREDENTIALS` and, when it
 * federates an AWS identity, returns a client that sources AWS credentials
 * from the provider chain.
 *
 * Returns `undefined` for every other case — no file configured, a
 * service-account key, a non-AWS external account, unreadable or malformed
 * JSON — so the caller falls back to stock Application Default Credentials
 * and nothing changes for deployments that were already working.
 *
 * The result is memoized: the file does not change under a running process,
 * and this is on the path of every model build.
 */
let cachedAuthClient: AuthClient | null | undefined;

export const loadAwsExternalAccountAuthClient = (args?: {
  credentialsPath?: string;
  reload?: boolean;
}): AuthClient | undefined => {
  if (!args?.reload && cachedAuthClient !== undefined) {
    return cachedAuthClient ?? undefined;
  }

  const path =
    args?.credentialsPath ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) {
    cachedAuthClient = null;
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    log('loadAwsExternalAccountAuthClient: unreadable credentials at %s', path);
    cachedAuthClient = null;
    return undefined;
  }

  if (!isAwsExternalAccountConfig(parsed)) {
    log('loadAwsExternalAccountAuthClient: %s is not AWS-federated', path);
    cachedAuthClient = null;
    return undefined;
  }

  log(
    'loadAwsExternalAccountAuthClient: federating AWS identity from %s',
    path
  );
  cachedAuthClient = buildAwsExternalAccountAuthClient({
    credentialConfig: parsed,
  });
  return cachedAuthClient;
};

/** Test seam: drops the memoized client so a later call re-reads the file. */
export const resetAwsExternalAccountAuthClientCache = () => {
  cachedAuthClient = undefined;
};
