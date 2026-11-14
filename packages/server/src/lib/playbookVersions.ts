import createDebug from 'debug';

import { type MappedPlaybook, playbooks, updatePlaybook } from './playbooks';
import { playbookVersionStore } from './playbookVersionSnapshot';
import type { RequestPrincipal } from './principals';
import {
  type ArchivedVersionRow,
  makeVersionArchive,
  mapArchivedVersionFields,
  toResourceRef,
} from './resourceVersions';
import type { Writer } from './writerRule';

const log = createDebug('soat:playbooks');

/**
 * A playbook's definition history. Versions are archived by the write path in
 * `playbooks.ts`, never from here; a restore is an ordinary update carrying an
 * archived definition, so it is validated and versioned like any other.
 */

/** A version archived without a grant restores under the playbook's own. */
const archivedPolicyIds = (value: unknown): string[] | undefined => {
  return Array.isArray(value) ? value.map(String) : undefined;
};

export const mapPlaybookVersion = (
  version: ArchivedVersionRow,
  playbookPublicId: string
) => {
  return {
    playbook_id: playbookPublicId,
    ...mapArchivedVersionFields(version),
  };
};

const playbookVersionArchive = () => {
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
        policyIds: archivedPolicyIds(args.config.policy_ids),
        versionLabel: args.label,
        createdBy: args.createdBy,
        writer: args.writer,
      });
    },
  });
};

export const listPlaybookVersions = async (args: {
  projectIds?: number[];
  playbookId: string;
  limit?: number;
  cursor?: string;
}) => {
  log('listPlaybookVersions: id=%s', args.playbookId);
  return playbookVersionArchive().listVersions({
    projectIds: args.projectIds,
    resourceId: args.playbookId,
    limit: args.limit,
    cursor: args.cursor,
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
  createdBy: RequestPrincipal | null;
  writer: Writer;
}): Promise<MappedPlaybook> => {
  log(
    'restorePlaybookVersion: id=%s version=%d',
    args.playbookId,
    args.version
  );
  return playbookVersionArchive().restoreVersion({
    projectIds: args.projectIds,
    resourceId: args.playbookId,
    version: args.version,
    label: args.label,
    createdBy: args.createdBy,
    writer: args.writer,
  });
};
