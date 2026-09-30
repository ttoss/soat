import { Op } from '@ttoss/postgresdb';

import { db } from '../db';

/**
 * The converter's own project's ingestion rules converting with it, other than
 * those in `excludingPublicIds` — deleted alongside by a formation teardown.
 * Another project's rules never block: they convert through a share.
 */
export const countConverterRules = (args: {
  converter: { agentId: number } | { toolId: number };
  projectId: number;
  excludingPublicIds: ReadonlySet<string>;
}): Promise<number> => {
  return db.IngestionRule.count({
    where: {
      ...args.converter,
      projectId: args.projectId,
      ...(args.excludingPublicIds.size > 0
        ? { publicId: { [Op.notIn]: [...args.excludingPublicIds] } }
        : {}),
    },
  });
};
