/**
 * What the secret linked to a `bedrock` or `vertex` provider holds, and the
 * Bedrock credentials it resolves to.
 */
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

import { DomainError } from '../errors';
import { assertNoConfigCredential } from './aiProviderConfigSecrets';
import { readUrlConfigValue } from './aiProviderConfigValidation';
import {
  type AmbientCredentialUser,
  assertAmbientCredentialsAllowed,
} from './ambientCredentials';

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

const readNonEmptyString = (value: unknown): string | undefined => {
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...parsed };
    }
  } catch {
    // Not JSON — the caller reads the bare value.
  }
  return null;
};

export const parseBedrockSecret = (
  secretValue: string | null
): BedrockSecret => {
  if (!secretValue) return {};
  const parsed = parseJsonObject(secretValue);
  if (parsed) {
    return {
      apiKey: readNonEmptyString(parsed.apiKey),
      accessKeyId: readNonEmptyString(parsed.accessKeyId),
      secretAccessKey: readNonEmptyString(parsed.secretAccessKey),
      sessionToken: readNonEmptyString(parsed.sessionToken),
    };
  }
  // Plain ABSK bearer token stored directly as the secret value
  if (secretValue.startsWith('ABSK')) {
    return { apiKey: secretValue };
  }
  return {};
};

/**
 * A record that links a secret declared a credential of its own, so one whose
 * value holds none is misconfigured: the deployment's credentials are a
 * fallback only for a record that links nothing, whatever the operator allows.
 */
export const refuseUnusableLinkedSecret = (args: {
  provider: 'bedrock' | 'vertex';
  secretValue: string | null;
}): void => {
  if (args.secretValue === null) return;
  throw new DomainError(
    'AI_PROVIDER_MISCONFIGURED',
    args.provider === 'bedrock'
      ? "The secret linked to this 'bedrock' AI provider holds no usable credential: store a JSON object with `apiKey`, or with `accessKeyId` and `secretAccessKey`, or a bare `ABSK…` bearer token."
      : "The secret linked to this 'vertex' AI provider holds no usable credential: store a service-account key file (with `client_email` and `private_key`), a JSON object with `apiKey`, or a bare API key."
  );
};

/**
 * Resolves the Bedrock credential precedence: a secret-linked apiKey wins over
 * a complete access-key/secret-key pair. Apart from `buildBedrockModel` so
 * the rules can be asserted directly rather than through the opaque model
 * object they configure.
 *
 * A record that links no secret falls back to the AWS default credential chain (`fromNodeProviderChain`) so role-based auth works.
 * `@ai-sdk/amazon-bedrock` does NOT walk that chain on its own (vercel/ai#2216)
 * — passing no credentials makes it throw a SigV4 error instead.
 *
 * That chain resolves the *deployment's* credentials, so for a tenant-written
 * provider record it is gated on the operator's opt-in for that project.
 * `{ operator: true }` is for the embedding stack alone, whose region and key
 * are operator settings no tenant writes — an instance role is the intended
 * credential there.
 */
export const resolveBedrockCredentials = (args: {
  secretValue: string | null;
  config?: Record<string, unknown>;
  ambientFor: AmbientCredentialUser;
}): BedrockCredentials => {
  assertNoConfigCredential({
    config: args.config,
    code: 'AI_PROVIDER_MISCONFIGURED',
  });
  const secret = parseBedrockSecret(args.secretValue);
  const region =
    readUrlConfigValue({
      provider: 'bedrock',
      key: 'region',
      value: args.config?.region,
    }) ?? 'us-east-1';
  if (secret.apiKey) {
    return { region, apiKey: secret.apiKey };
  }
  if (secret.accessKeyId && secret.secretAccessKey) {
    return {
      region,
      accessKeyId: secret.accessKeyId,
      secretAccessKey: secret.secretAccessKey,
      sessionToken: secret.sessionToken,
    };
  }
  if ('project' in args.ambientFor) {
    refuseUnusableLinkedSecret({
      provider: 'bedrock',
      secretValue: args.secretValue,
    });
    assertAmbientCredentialsAllowed({
      provider: 'bedrock',
      project: args.ambientFor.project,
    });
  }
  return { region, credentialProvider: fromNodeProviderChain() };
};

/**
 * A linked secret for a `vertex` provider is either a GCP service-account key
 * file pasted verbatim (hence the snake_case field names — they are Google's,
 * not ours) or an express-mode API key.
 */
export type VertexSecret = {
  apiKey?: string;
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

const KEY_FILE_FIELDS = ['project_id', 'client_email', 'private_key'] as const;

export const parseVertexSecret = (secretValue: string | null): VertexSecret => {
  if (!secretValue) return {};
  const parsed = parseJsonObject(secretValue);
  if (parsed) {
    // The key file's own field names are Google's, read verbatim.
    const keyFile = Object.fromEntries(
      KEY_FILE_FIELDS.map((field) => {
        return [field, readNonEmptyString(parsed[field])];
      })
    );
    return { ...keyFile, apiKey: readNonEmptyString(parsed.apiKey) };
  }
  // Every other API-key provider stores the bare key as the secret value, so
  // a non-object secret is read the same way here.
  return { apiKey: secretValue };
};
