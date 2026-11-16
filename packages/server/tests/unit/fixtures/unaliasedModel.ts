import type { AiProviderSlug } from '@soat/postgresdb';
import { buildModel } from 'src/lib/agentModel';

/** `buildModel` for a provider row that declares no `model_aliases`. */
export const buildUnaliasedModel = (args: {
  provider: AiProviderSlug;
  secretValue: string | null;
  model: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
}) => {
  return buildModel({
    aiProvider: { ...args, modelAliases: null, modelAliasesOnly: false },
    model: args.model,
  });
};
