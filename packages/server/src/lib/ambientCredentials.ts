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
const PROJECTS_SETTING = 'AI_PROVIDER_AMBIENT_CREDENTIAL_PROJECTS';

/**
 * Who a credential-less record would sign for: a tenant project, by public id,
 * or the operator's own stack (the embedding settings), which no tenant writes.
 */
export type AmbientCredentialUser = { project: string } | { operator: true };

/**
 * An `anthropic` record with a `base_url` names a tenant's endpoint, which must
 * never receive the deployment's federated token, so it is never ambient.
 */
export const usesAnthropicTenantEndpoint = (args: {
  baseUrl?: string | null;
}): boolean => {
  return Boolean(args.baseUrl);
};

const namedProjects = (): string[] => {
  return (process.env[PROJECTS_SETTING] ?? '')
    .split(',')
    .map((id) => {
      return id.trim();
    })
    .filter(Boolean);
};

/**
 * Whether a project's provider record may authenticate with the deployment's
 * own cloud credentials. Off unless the operator says otherwise, and read per
 * call so a deployment's setting is what answers rather than whatever the
 * process held when this module was first imported.
 *
 * A provider record is tenant-written, so the credential-less shape is a tenant
 * generating on the operator's cloud account: spend on the operator's bill,
 * quota against the operator's limits, and whatever IAM the deployment's role
 * holds. `AI_PROVIDER_AMBIENT_CREDENTIAL_PROJECTS` narrows the opt-in to the
 * projects the operator names; unset or empty, it covers every project.
 */
const ambientCredentialsAllowed = (args: { project: string }): boolean => {
  if (process.env[SETTING] !== 'true') return false;
  const named = namedProjects();
  return named.length === 0 || named.includes(args.project);
};

const notAllowedBecause = (args: { project: string }): string => {
  return process.env[SETTING] === 'true'
    ? `${PROJECTS_SETTING} does not name project '${args.project}'`
    : `${SETTING} is not 'true'`;
};

/**
 * The build-time half: refuses at the point a provider SDK would be handed the
 * deployment's credentials. Placed there rather than at the write alone because
 * the settings can change while credential-less rows already exist — the write
 * refused none of them — so the credential is checked where it is used.
 */
export const assertAmbientCredentialsAllowed = (args: {
  provider: AmbientProvider;
  project: string;
}): void => {
  if (ambientCredentialsAllowed(args)) return;
  throw new DomainError(
    'AI_PROVIDER_MISCONFIGURED',
    `A '${args.provider}' AI provider that links no credential of its own would sign with ${AMBIENT_CREDENTIAL_SOURCE[args.provider]} — the deployment's credentials, not the record's — which this deployment does not allow for this project (${notAllowedBecause(args)}). Link a secret carrying this provider's credentials.`
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
  project: string;
}): void => {
  // A credential-less `anthropic` record is accepted so a secret can be linked
  // after create; it is refused only where it would sign.
  if (!isAmbientProvider(args.provider) || args.provider === 'anthropic') {
    return;
  }
  if (args.secretId) return;
  if (ambientCredentialsAllowed(args)) return;

  throw new DomainError(
    'VALIDATION_FAILED',
    `A '${args.provider}' AI provider needs a credential of its own: link a secret holding one. Without it the record would sign with ${AMBIENT_CREDENTIAL_SOURCE[args.provider]} — the deployment's credentials — which this deployment does not allow for this project (${notAllowedBecause(args)}).`,
    { field: 'secret_id' }
  );
};
