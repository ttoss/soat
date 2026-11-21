import type { AiProviderSlug } from '@soat/postgresdb';
import { buildModel } from 'src/lib/agentModel';

/** `buildModel` for a provider row that declares no `model_aliases`. */
export const buildUnaliasedModel = (args: {
  provider: AiProviderSlug;
  secretValue: string | null;
  model: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
  projectPublicId?: string;
}) => {
  return buildModel({
    aiProvider: {
      projectPublicId: 'proj_tenant',
      ...args,
      publicId: 'aip_unaliased',
      modelAliases: null,
      modelAliasesOnly: false,
      grantee: null,
    },
    model: args.model,
  });
};
