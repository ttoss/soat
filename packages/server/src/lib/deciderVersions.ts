import createDebug from 'debug';

import { deciders, type MappedDecider, updateDecider } from './deciders';
import { deciderVersionStore } from './deciderVersionSnapshot';
import {
  type ArchivedVersionRow,
  makeVersionArchive,
  mapArchivedVersionFields,
  toResourceRef,
} from './resourceVersions';

const log = createDebug('soat:deciders');

/**
 * A decider's question-set history. Versions are archived by the write path in
 * `deciders.ts`, never from here; a restore is an ordinary update carrying an
 * archived question set, so it is validated and versioned like any other.
 */

export const mapDeciderVersion = (
  version: ArchivedVersionRow,
  deciderPublicId: string
) => {
  return {
    decider_id: deciderPublicId,
    ...mapArchivedVersionFields(version),
  };
};

const deciderVersionArchive = makeVersionArchive({
  store: deciderVersionStore,
  loadResource: async (args) => {
    return toResourceRef(await deciders.getByPublicId(args));
  },
  mapVersion: mapDeciderVersion,
  applyConfig: async (args): Promise<MappedDecider> => {
    return updateDecider({
      projectIds: args.projectIds,
      id: args.id,
      questions: args.config.questions,
      versionLabel: args.label,
      createdByUserId: args.createdByUserId,
    });
  },
});

export const listDeciderVersions = async (args: {
  projectIds?: number[];
  deciderId: string;
  limit?: number;
  offset?: number;
}) => {
  log('listDeciderVersions: id=%s', args.deciderId);
  return deciderVersionArchive.listVersions({
    projectIds: args.projectIds,
    resourceId: args.deciderId,
    limit: args.limit,
    offset: args.offset,
  });
};

export const getDeciderVersion = async (args: {
  projectIds?: number[];
  deciderId: string;
  version: number;
}) => {
  log('getDeciderVersion: id=%s version=%d', args.deciderId, args.version);
  return deciderVersionArchive.getVersion({
    projectIds: args.projectIds,
    resourceId: args.deciderId,
    version: args.version,
  });
};

/** Appends the archived question set as a new version. */
export const restoreDeciderVersion = async (args: {
  projectIds?: number[];
  deciderId: string;
  version: number;
  label?: string | null;
  createdByUserId: number | null;
}): Promise<MappedDecider> => {
  log('restoreDeciderVersion: id=%s version=%d', args.deciderId, args.version);
  return deciderVersionArchive.restoreVersion({
    projectIds: args.projectIds,
    resourceId: args.deciderId,
    version: args.version,
    label: args.label,
    createdByUserId: args.createdByUserId,
  });
};
