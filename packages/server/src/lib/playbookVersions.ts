import createDebug from 'debug';

import type { PlaybookAuthor } from './playbookAuthor';
import { type MappedPlaybook, playbooks, updatePlaybook } from './playbooks';
import { playbookVersionStore } from './playbookVersionSnapshot';
import {
  type ArchivedVersionRow,
  makeVersionArchive,
  mapArchivedVersionFields,
  toResourceRef,
} from './resourceVersions';

const log = createDebug('soat:playbooks');

/**
 * A playbook's definition history. Versions are archived by the write path in
 * `playbooks.ts`, never from here; a restore is an ordinary update carrying an
 * archived definition, so it is validated and versioned like any other.
 */

export const mapPlaybookVersion = (
  version: ArchivedVersionRow,
  playbookPublicId: string
) => {
  return {
    playbook_id: playbookPublicId,
    ...mapArchivedVersionFields(version),
  };
};

/** The archive, with the author a restore writes the new version as. */
const playbookVersionArchive = (author?: PlaybookAuthor) => {
  return makeVersionArchive({
    store: playbookVersionStore,
    loadResource: async (args) => {
      return toResourceRef(await playbooks.getByPublicId(args));
    },
    mapVersion: mapPlaybookVersion,
    applyConfig: async (args): Promise<MappedPlaybook> => {
      return updatePlaybook({
        projectIds: args.projectIds,
        id: args.id,
        definition: args.config.definition,
        versionLabel: args.label,
        createdByUserId: args.createdByUserId,
        author: author!,
      });
    },
  });
};

export const listPlaybookVersions = async (args: {
  projectIds?: number[];
  playbookId: string;
  limit?: number;
  offset?: number;
}) => {
  log('listPlaybookVersions: id=%s', args.playbookId);
  return playbookVersionArchive().listVersions({
    projectIds: args.projectIds,
    resourceId: args.playbookId,
    limit: args.limit,
    offset: args.offset,
  });
};

export const getPlaybookVersion = async (args: {
  projectIds?: number[];
  playbookId: string;
  version: number;
}) => {
  log('getPlaybookVersion: id=%s version=%d', args.playbookId, args.version);
  return playbookVersionArchive().getVersion({
    projectIds: args.projectIds,
    resourceId: args.playbookId,
    version: args.version,
  });
};

/** Appends the archived definition as a new version. */
export const restorePlaybookVersion = async (args: {
  projectIds?: number[];
  playbookId: string;
  version: number;
  label?: string | null;
  createdByUserId: number | null;
  author: PlaybookAuthor;
}): Promise<MappedPlaybook> => {
  log(
    'restorePlaybookVersion: id=%s version=%d',
    args.playbookId,
    args.version
  );
  return playbookVersionArchive(args.author).restoreVersion({
    projectIds: args.projectIds,
    resourceId: args.playbookId,
    version: args.version,
    label: args.label,
    createdByUserId: args.createdByUserId,
  });
};
