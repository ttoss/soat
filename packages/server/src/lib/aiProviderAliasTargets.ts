import createDebug from 'debug';
import { db } from 'src/db';
import { DomainError } from 'src/errors';

import {
  forwardedProviderIds,
  type ModelAliases,
} from './aiProviderModelAliases';
import { aiProviderReferences } from './resourceReferences';

const log = createDebug('soat:aiProviderAliasTargets');

const refuse = (message: string): never => {
  throw new DomainError('VALIDATION_FAILED', message, {
    field: 'model_aliases',
  });
};

/** The public ids of the providers of `projectId` whose aliases forward to `targetPublicId`. */
export const findProvidersForwardingTo = async (args: {
  projectId: number;
  targetPublicId: string;
}): Promise<string[]> => {
  const rows = await db.AiProvider.findAll({
    where: { projectId: args.projectId },
    attributes: ['publicId', 'modelAliases'],
  });
  return rows
    .filter((row) => {
      return forwardedProviderIds(row.modelAliases).includes(
        args.targetPublicId
      );
    })
    .map((row) => {
      return row.publicId;
    });
};

/**
 * Refuses forwards that would not resolve at the call: a target outside the
 * provider's project, the provider itself, a target that forwards, or a
 * provider other providers already forward to. One hop keeps the endpoint a
 * call reaches a single lookup away from the alias it names.
 */
export const assertAliasTargets = async (args: {
  projectId: number;
  publicId?: string;
  modelAliases: ModelAliases | null | undefined;
}): Promise<void> => {
  const ids = forwardedProviderIds(args.modelAliases ?? null);
  if (ids.length === 0) return;
  log('assertAliasTargets: projectId=%d targets=%o', args.projectId, ids);

  if (args.publicId && ids.includes(args.publicId)) {
    refuse('model_aliases may not forward to the provider that holds them.');
  }

  const targets = await aiProviderReferences.findMany({
    ids,
    projectId: args.projectId,
    reach: 'project',
  });
  for (const id of ids) {
    const target = targets.get(id);
    if (!target) {
      refuse(
        `model_aliases forwards to AI provider '${id}', which is not a provider of this project.`
      );
    } else if (forwardedProviderIds(target.modelAliases).length > 0) {
      refuse(
        `model_aliases forwards to AI provider '${id}', which itself forwards; a forward targets a provider that serves its own models.`
      );
    }
  }

  if (!args.publicId) return;
  const forwarding = await findProvidersForwardingTo({
    projectId: args.projectId,
    targetPublicId: args.publicId,
  });
  if (forwarding.length > 0) {
    refuse(
      `Other AI providers forward to this one (${forwarding.join(', ')}), so its model_aliases may not forward.`
    );
  }
};
