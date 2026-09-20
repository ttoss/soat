import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { nonSystemPathWhere } from './systemPathScope';

/**
 * Which documents a knowledge search may reach: the projects in scope, the
 * paths it asked for, and — unless it asked for something inside it — not the
 * reserved root, so a conversation turn does not rank against the knowledge a
 * project deliberately uploaded.
 */
/**
 * Spelled out rather than inferred: Sequelize's model types cannot be named
 * across a module boundary, and the three chunk queries only need these four
 * fields.
 */
export type KnowledgeFileInclude = {
  model: (typeof db)['File'];
  as: string;
  where: Record<string, unknown> | undefined;
  include: Array<{ model: (typeof db)['Project']; as: string }>;
};

export const buildFileInclude = (args: {
  projectIds?: number[];
  paths?: string[];
  /** A search naming documents by id reaches them wherever they are filed. */
  namesDocuments?: boolean;
  /**
   * A `system.*` tag filter has said which conversation, actor or role it
   * wants, so it reaches the reserved root a bare query is kept out of.
   */
  namesSystemTags?: boolean;
}): KnowledgeFileInclude => {
  const conditions: unknown[] = [];
  if (args.projectIds !== undefined) {
    conditions.push({ projectId: args.projectIds });
  }
  const namesPaths = Boolean(args.paths && args.paths.length > 0);
  if (!namesPaths && !args.namesDocuments && !args.namesSystemTags) {
    conditions.push(nonSystemPathWhere());
  }
  if (namesPaths) {
    conditions.push({
      [Op.or]: args.paths!.map((p) => {
        // Stored paths are leading-slash normalized, so a prefix without one
        // must be too or the `LIKE` never fires. The trailing slash stays, to
        // keep folder-prefix semantics.
        const prefix = p.startsWith('/') ? p : `/${p}`;
        return { path: { [Op.like]: `${prefix}%` } };
      }),
    });
  }
  const where = conditions.length > 0 ? { [Op.and]: conditions } : undefined;
  return {
    model: db.File,
    as: 'file',
    where: where as Record<string, unknown> | undefined,
    include: [{ model: db.Project, as: 'project' }],
  };
};
