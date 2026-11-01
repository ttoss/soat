import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';
import { SENSITIVE_PLACEHOLDER } from './sensitivePlaceholder';

/**
 * `config` keys that would carry a credential. A provider's credential is its
 * linked secret alone: these are refused, never stripped, because a `bedrock`
 * or `vertex` record left without one signs with the deployment's identity.
 */
const CONFIG_CREDENTIAL_KEYS = ['apiKey'] as const;

const findConfigCredentialKey = (config: unknown): string | undefined => {
  if (!isPlainObject(config)) return undefined;
  return CONFIG_CREDENTIAL_KEYS.find((key) => {
    return Object.hasOwn(config, key);
  });
};

const refusal = (key: string): string => {
  return `config.${key} is not accepted: store the credential in a secret and link it with secret_id.`;
};

/**
 * The write-time refusal (`VALIDATION_FAILED`), or the message a formation
 * template check reports, for a `config` carrying a credential.
 */
export const configCredentialError = (
  config: unknown
): { field: string; message: string } | undefined => {
  const key = findConfigCredentialKey(config);
  return key ? { field: `config.${key}`, message: refusal(key) } : undefined;
};

export const assertNoConfigCredential = (args: {
  config: unknown;
  code: 'VALIDATION_FAILED' | 'AI_PROVIDER_MISCONFIGURED';
}): void => {
  const error = configCredentialError(args.config);
  if (!error) return;
  throw new DomainError(
    args.code,
    error.message,
    args.code === 'VALIDATION_FAILED' ? { field: error.field } : undefined
  );
};

/**
 * Masks a credential a stored row carries in `config`: the writes refuse one,
 * but a row is not re-checked until it is written. Never applied in
 * `mapAiProvider`: a formation diffs the live record against its template.
 */
export const redactAiProviderSecrets = <T extends { config?: unknown }>(
  provider: T
): T => {
  const { config } = provider;
  if (!isPlainObject(config)) return provider;
  const masked: Record<string, unknown> = { ...config };
  for (const key of CONFIG_CREDENTIAL_KEYS) {
    if (Object.hasOwn(masked, key)) masked[key] = SENSITIVE_PLACEHOLDER;
  }
  return { ...provider, config: masked };
};
