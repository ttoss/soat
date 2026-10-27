import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';
import { SENSITIVE_PLACEHOLDER } from './sensitivePlaceholder';

/** The `config` keys whose value is the credential itself. */
const CONFIG_CREDENTIAL_KEYS = ['apiKey'] as const;

/**
 * Masks the credentials in an AI provider's `config`, wherever a provider or
 * its declared properties leave the API. Never applied in `mapAiProvider`: a
 * formation diffs the live record against its template, so `fetch` needs the
 * real value.
 */
export const redactAiProviderSecrets = <T extends { config?: unknown }>(
  provider: T
): T => {
  const { config } = provider;
  if (!isPlainObject(config)) return provider;
  const masked: Record<string, unknown> = { ...config };
  for (const key of CONFIG_CREDENTIAL_KEYS) {
    if (typeof masked[key] === 'string' && masked[key] !== '') {
      masked[key] = SENSITIVE_PLACEHOLDER;
    }
  }
  return { ...provider, config: masked };
};

/**
 * Refuses a credential that is not a string, so a read-edit-write round trip
 * that sends the mask back fails instead of replacing the stored key.
 */
export const assertConfigCredentialsAreStrings = (
  config: Record<string, unknown> | null | undefined
): void => {
  if (!config) return;
  for (const key of CONFIG_CREDENTIAL_KEYS) {
    const value = config[key];
    if (value === undefined || value === null || typeof value === 'string') {
      continue;
    }
    throw new DomainError(
      'VALIDATION_FAILED',
      `config.${key} must be the credential as a string. A read returns it masked, so a write that sends config sends the credential again.`,
      { field: `config.${key}` }
    );
  }
};
