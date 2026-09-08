import type { AiProviderSlug } from '@soat/postgresdb';

import { DomainError } from '../errors';

/**
 * The two provider slugs whose SDK signs with a credential nobody put on the
 * record: `bedrock` walks the AWS default credential chain, `vertex` resolves
 * Application Default Credentials (an AWS-federated ADC file included). Every
 * other slug carries its key in the record or takes none at all.
 */
const AMBIENT_CREDENTIAL_SOURCE = {
  bedrock: 'the AWS default credential chain',
  vertex: 'Application Default Credentials',
} as const;

type AmbientProvider = keyof typeof AMBIENT_CREDENTIAL_SOURCE;

const isAmbientProvider = (
  provider: AiProviderSlug
): provider is AmbientProvider => {
  return provider in AMBIENT_CREDENTIAL_SOURCE;
};

const SETTING = 'AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS';

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
 * deployment's credentials. Placed there rather than at the write alone so a
 * record created before this rule existed fails closed instead of signing with
 * them on the next generation.
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
 * A linked secret is taken at face value here: whether its value parses into a
 * usable credential is only knowable when the credential is resolved, and that
 * is what the build-time half above answers.
 */
export const assertAiProviderCarriesCredential = (args: {
  provider: AiProviderSlug;
  secretId?: number | null;
  config?: Record<string, unknown> | null;
}): void => {
  if (!isAmbientProvider(args.provider)) return;
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
