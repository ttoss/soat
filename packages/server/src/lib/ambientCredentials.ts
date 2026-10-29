import type { AiProviderSlug } from '@soat/postgresdb';

import { DomainError } from '../errors';

/**
 * The provider slugs whose SDK signs with a credential nobody put on the
 * record: `bedrock` walks the AWS default credential chain, `vertex` resolves
 * Application Default Credentials (an AWS-federated ADC file included), and
 * `anthropic` exchanges the deployment's identity through Anthropic workload
 * identity federation. Every other slug carries its key in the record or takes
 * none at all.
 */
const AMBIENT_CREDENTIAL_SOURCE = {
  bedrock: 'the AWS default credential chain',
  vertex: 'Application Default Credentials',
  anthropic: 'Anthropic workload identity federation',
} as const;

type AmbientProvider = keyof typeof AMBIENT_CREDENTIAL_SOURCE;

const isAmbientProvider = (
  provider: AiProviderSlug
): provider is AmbientProvider => {
  return provider in AMBIENT_CREDENTIAL_SOURCE;
};

const SETTING = 'AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS';

/**
 * An `anthropic` record with a `base_url` names a tenant's endpoint, which must
 * never receive the deployment's federated token, so it is never ambient.
 */
export const usesAnthropicTenantEndpoint = (args: {
  baseUrl?: string | null;
}): boolean => {
  return Boolean(args.baseUrl);
};

/**
 * Whether a provider record may authenticate with the deployment's own cloud
 * credentials. Off unless the operator says otherwise, and read per call so a
 * deployment's setting is what answers rather than whatever the process held
 * when this module was first imported.
 *
 * A provider record is tenant-written, so the credential-less shape is a tenant
 * generating on the operator's cloud account: spend on the operator's bill,
 * quota against the operator's limits, and whatever IAM the deployment's role
 * holds. Only the operator knows whether their deployment is one where that is
 * intended — a single-tenant install running on an instance role is exactly
 * that, which is why this is a setting and not a refusal.
 */
const ambientCredentialsAllowed = (): boolean => {
  return process.env[SETTING] === 'true';
};

/**
 * The build-time half: refuses at the point a provider SDK would be handed the
 * deployment's credentials. Placed there rather than at the write alone because
 * the setting can be turned off while credential-less rows already exist — the
 * write refused none of them — so the credential is checked where it is used.
 */
export const assertAmbientCredentialsAllowed = (args: {
  provider: AmbientProvider;
}): void => {
  if (ambientCredentialsAllowed()) return;
  throw new DomainError(
    'AI_PROVIDER_MISCONFIGURED',
    `A '${args.provider}' AI provider that links no credential of its own would sign with ${AMBIENT_CREDENTIAL_SOURCE[args.provider]} — the deployment's credentials, not the record's. Link a secret carrying this provider's credentials, or set ${SETTING}=true on the deployment to let a record use the deployment's own.`
  );
};

/**
 * The write-time half, so the caller is refused where they can still fix the
 * record rather than at the generation it would otherwise sign.
 *
 * This answers only whether the record carries a credential at all; whether a
 * linked secret's value parses into a usable one is `assertLinkedSecretUsable`,
 * which the write runs beside it.
 */
export const assertAiProviderCarriesCredential = (args: {
  provider: AiProviderSlug;
  secretId?: number | null;
  config?: Record<string, unknown> | null;
}): void => {
  // A credential-less `anthropic` record is accepted so a secret can be linked
  // after create; it is refused only where it would sign.
  if (!isAmbientProvider(args.provider) || args.provider === 'anthropic') {
    return;
  }
  if (args.secretId) return;
  // Both slugs accept `config.apiKey` as a credential fallback for a record
  // that links no secret, so one is a credential the record carries.
  if (args.config?.apiKey) return;
  if (ambientCredentialsAllowed()) return;

  throw new DomainError(
    'VALIDATION_FAILED',
    `A '${args.provider}' AI provider needs a credential of its own: link a secret holding one. Without it the record would sign with ${AMBIENT_CREDENTIAL_SOURCE[args.provider]} — the deployment's credentials — which this deployment does not allow (${SETTING}).`,
    { field: 'secret_id' }
  );
};
