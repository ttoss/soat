import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { DomainError } from '../errors';

/**
 * The tools a caller scoped to `projectIds` may reference by id: its own, plus
 * every published tool. The one rule each by-id reference site reads, so a
 * published tool is reachable from all of them or none. `undefined` is an
 * unscoped caller, who reaches every tool.
 */
export const referenceableToolWhere = (args: {
  projectIds?: number[];
}): Record<string | symbol, unknown> => {
  if (args.projectIds === undefined) return {};
  return {
    [Op.or]: [{ projectId: args.projectIds }, { published: true }],
  };
};

/**
 * Whether a call made from `callingProjectId` reaches a tool it does not own.
 * Such a call resolves secrets in the tool's project but is gated by the
 * calling project's guardrails alone: the tool's own `guardrail_ids` name the
 * owner's guardrails.
 */
export const isForeignTool = (args: {
  toolProjectId: number;
  callingProjectId: number;
}): boolean => {
  return args.toolProjectId !== args.callingProjectId;
};

/** What a project that does not own a published tool reads of it. */
export type PublishedToolView = {
  id: string;
  name: string;
  description: string | null;
  parameters: object | null;
  published: true;
};

export const getPublishedToolView = async (args: {
  id: string;
}): Promise<PublishedToolView> => {
  const tool = await db.Tool.findOne({
    where: { publicId: args.id, published: true },
  });
  if (!tool) {
    throw new DomainError('RESOURCE_NOT_FOUND', `Tool '${args.id}' not found.`);
  }
  return {
    id: tool.publicId,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    published: true,
  };
};

/** Whether `id` names a published tool, for a route choosing how to authorize. */
export const isPublishedTool = async (args: {
  id: string;
}): Promise<boolean> => {
  const tool = await db.Tool.findOne({
    where: { publicId: args.id, published: true },
    attributes: ['id'],
  });
  return tool !== null;
};
