import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { offeredAliases } from './aiProviderModelAliases';
import {
  enumerateProviderModels,
  type ProviderModel,
} from './aiProviderModels';
import { resolveAiProviderSecret } from './aiProviders';
import { type Page, pageOf } from './pagination';

const log = createDebug('soat:provider-model-listing');

/** `q` as a case-insensitive substring of a model's id or display name. */
const filterModels = (args: {
  models: ProviderModel[];
  q?: string;
}): ProviderModel[] => {
  const needle = args.q?.trim().toLowerCase();
  if (!needle) return args.models;
  return args.models.filter((model) => {
    return [model.id, model.display_name].some((value) => {
      return value?.toLowerCase().includes(needle);
    });
  });
};

/**
 * The models a provider record runs: a closed catalog's aliases, else what the
 * vendor answers through the record's own credentials and configuration.
 */
const providerCatalogue = async (args: {
  aiProviderId: string;
}): Promise<ProviderModel[]> => {
  // The provider is this route's subject rather than something another
  // project's record points at, and the caller was authorized against the
  // provider's own project — so that project is the scope.
  const owner = await db.AiProvider.findOne({
    where: { publicId: args.aiProviderId },
    attributes: ['projectId', 'modelAliases', 'modelAliasesOnly'],
  });
  if (!owner) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found');
  }

  // A closed catalog refuses every other id with MODEL_NOT_OFFERED, and one
  // whose every alias forwards holds no credential to ask a vendor with.
  const aliases = offeredAliases(owner);
  if (aliases) {
    log('providerCatalogue: %s answers its aliases', args.aiProviderId);
    return aliases.map((id) => {
      return { id };
    });
  }

  const resolved = await resolveAiProviderSecret({
    aiProviderId: args.aiProviderId,
    projectId: owner.projectId,
    reach: 'project',
  });
  /* istanbul ignore next -- the row was just read; only a delete racing this
     call resolves it away. */
  if (!resolved) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found');
  }

  return enumerateProviderModels({
    project: resolved.projectPublicId,
    provider: resolved.provider,
    baseUrl: resolved.baseUrl,
    config: resolved.config,
    secretValue: resolved.secretValue,
  });
};

/**
 * Asks an existing AI provider record which models it can run.
 *
 * The provider record is the unit of authorization and of credentials, which is
 * why this hangs off a provider rather than off a slug: two providers of the
 * same slug in the same project can legitimately see different catalogues.
 */
export const listAiProviderModels = async (args: {
  aiProviderId: string;
  q?: string;
  limit?: number;
  cursor?: string;
}): Promise<Page<ProviderModel>> => {
  const catalogue = await providerCatalogue({
    aiProviderId: args.aiProviderId,
  });
  // The whole catalogue arrives in one answer, so the filter and the page
  // apply to it rather than to the upstream request.
  return pageOf({
    items: filterModels({ models: catalogue, q: args.q }),
    limit: args.limit,
    cursor: args.cursor,
    filters: { aiProviderId: args.aiProviderId, q: args.q },
  });
};
