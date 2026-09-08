import type { AiProviderSlug } from '@soat/postgresdb';

import { DomainError } from '../errors';
import { assertTenantHttpUrl } from './tenantUrl';

/**
 * The `config` keys a provider SDK splices into the URL it requests.
 *
 * A provider record is tenant-written, and for these providers the SDK builds
 * its endpoint out of the record rather than taking one: Vertex from
 * `<location>-aiplatform.googleapis.com/v1beta1/projects/<project>/...`,
 * Bedrock from `bedrock-runtime.<region>.amazonaws.com`, Azure from
 * `<resourceName>.openai.azure.com`. A value carrying a dot, a slash or an `@`
 * therefore names a **different server**, and the request that lands there
 * carries whatever credential the record authenticates with — including the
 * deployment's own, where the record links no secret and the SDK falls back to
 * an ambient one.
 *
 * The egress guard cannot catch this: the attacker's host is publicly routable,
 * which is exactly what the guard allows. So the value itself has to be
 * confined, and one hostname label is the confinement — it is what every one of
 * these fields legitimately is.
 */
const URL_CONFIG_KEYS: Partial<Record<AiProviderSlug, readonly string[]>> = {
  vertex: ['location', 'project'],
  bedrock: ['region'],
  azure: ['resourceName'],
};

/** A single DNS label: what a region, a location or a resource name is. */
const URL_SAFE_VALUE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

const refusal = (args: { provider: AiProviderSlug; key: string }): string => {
  return `A '${args.provider}' AI provider's config.${args.key} is part of the hostname the request is sent to, so it must be a single name: letters, digits and hyphens only.`;
};

/**
 * The value of a `config` key that reaches a URL, or `undefined` when the
 * record sets none. Throws `AI_PROVIDER_MISCONFIGURED` for anything else.
 *
 * This is the build-time half, so a record written before the rule existed
 * fails closed rather than reaching the host it names. The create/update routes
 * refuse the same values earlier, as `VALIDATION_FAILED`.
 */
export const readUrlConfigValue = (args: {
  provider: AiProviderSlug;
  key: string;
  value: unknown;
}): string | undefined => {
  if (args.value === undefined || args.value === null) return undefined;
  if (typeof args.value !== 'string' || !URL_SAFE_VALUE.test(args.value)) {
    throw new DomainError(
      'AI_PROVIDER_MISCONFIGURED',
      refusal({ provider: args.provider, key: args.key })
    );
  }
  return args.value;
};

/**
 * The create/update check for an AI provider record's `base_url` and `config`.
 * Keeps the refusal at the write, where the caller can still fix the value,
 * rather than leaving it to the generation that would otherwise be sent to the
 * host the record names.
 */
export const assertAiProviderConfig = (args: {
  provider: AiProviderSlug;
  baseUrl?: string | null;
  config?: Record<string, unknown> | null;
}): void => {
  // `base_url` names the endpoint outright rather than being spliced into one,
  // so it is checked for shape and left to the request-time guard for the rest.
  if (args.baseUrl)
    assertTenantHttpUrl({ url: args.baseUrl, field: 'base_url' });

  const keys = URL_CONFIG_KEYS[args.provider];
  if (!keys || !args.config) return;

  for (const key of keys) {
    try {
      readUrlConfigValue({
        provider: args.provider,
        key,
        value: args.config[key],
      });
    } catch {
      throw new DomainError(
        'VALIDATION_FAILED',
        refusal({ provider: args.provider, key }),
        { field: `config.${key}` }
      );
    }
  }
};
