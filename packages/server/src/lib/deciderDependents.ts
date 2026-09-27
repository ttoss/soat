import { Op } from '@ttoss/postgresdb';

import { db } from '../db';

/**
 * The deciders whose backend is this agent or tool, other than those named in
 * `excludingPublicIds` — the ones a formation teardown deletes alongside it,
 * which therefore block nothing.
 */
export const countBackendDeciders = (args: {
  backend: { agentId: number } | { toolId: number };
  excludingPublicIds: ReadonlySet<string>;
}): Promise<number> => {
  return db.Decider.count({
    where: {
      ...args.backend,
      ...(args.excludingPublicIds.size > 0
        ? { publicId: { [Op.notIn]: [...args.excludingPublicIds] } }
        : {}),
    },
  });
};
