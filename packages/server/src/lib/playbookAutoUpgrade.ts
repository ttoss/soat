import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { advancePlaybookCase } from './playbookCascade';
import { playbookCases } from './playbookCaseStore';
import { moveCaseToVersion } from './playbookCaseUpgrades';
import type { RequestPrincipal } from './principals';
import { INTERNAL_FAILURE, toStoredError } from './storedError';

const log = createDebug('soat:playbookAutoUpgrade');

/**
 * When a write moved a playbook whose `auto_upgrade` is on past
 * `previousVersion`, moves every case behind its version to it, as an upgrade
 * would, except that a stored manual input the version's schema refuses, or
 * an upstream it declares and the case does not bind, holds the case back. A
 * case left behind records why in its `upgradeError`; the others cascade on
 * the new version.
 */
export const autoUpgradePlaybookCases = async (args: {
  playbook: { id?: unknown; version: number; autoUpgrade: boolean };
  previousVersion: number;
  createdBy: RequestPrincipal | null;
}): Promise<void> => {
  const { playbook } = args;
  if (!playbook.autoUpgrade || playbook.version === args.previousVersion) {
    return;
  }
  const behind = await db.PlaybookCase.findAll({
    where: {
      playbookId: playbook.id as number,
      playbookVersion: { [Op.lt]: playbook.version },
    },
    attributes: ['id'],
    order: [['id', 'ASC']],
  });
  log(
    'autoUpgradePlaybookCases: playbook=%d version=%d cases=%d',
    playbook.id,
    playbook.version,
    behind.length
  );

  for (const found of behind) {
    const row = await playbookCases.reload(found);
    try {
      await moveCaseToVersion({
        row,
        target: playbook.version,
        upstreams: null,
        refuseNonconformingInputs: true,
        createdBy: args.createdBy,
        onBehalfOf: null,
      });
    } catch (error) {
      const upgradeError = toStoredError({
        error,
        opaque: INTERNAL_FAILURE,
        label: 'autoUpgradePlaybookCases',
      });
      log('autoUpgradePlaybookCases: case=%s held back', row.publicId);
      await db.PlaybookCase.update(
        { upgradeError },
        { where: { id: row.id as number } }
      );
      continue;
    }
    await advancePlaybookCase({ caseDbId: row.id as number });
  }
};
