import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { paginatedList } from './pagination';
import { caseDefinition, caseSnapshot, playbookCases } from './playbookCases';
import { conformsToInputSchema } from './playbookCaseState';
import { nodesByKey } from './playbookGraph';
import { playbookMissingInputs } from './playbookMissing';

const log = createDebug('soat:playbookCases');

/**
 * The manual inputs still to fill before `node` can be reached, in waves: an
 * agent asks for the first wave first, since nothing later can run before it.
 */
export const getPlaybookCaseMissing = async (args: {
  projectIds?: number[];
  id: string;
  node: unknown;
}) => {
  log('getPlaybookCaseMissing: id=%s', args.id);
  const row = await playbookCases.getByPublicId(args);
  const definition = await caseDefinition({ row });

  if (
    typeof args.node !== 'string' ||
    !nodesByKey({ definition }).has(args.node)
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `node must name a node of the case's playbook version.`,
      { node: args.node }
    );
  }

  const waves = playbookMissingInputs({
    definition,
    snapshot: await caseSnapshot({ caseDbId: row.id as number }),
    node: args.node,
    conforms: conformsToInputSchema,
  });

  return { case_id: row.publicId, node: args.node, waves };
};

type EntryRow = InstanceType<(typeof db)['PlaybookEntry']> & {
  createdBy: { publicId: string } | null;
};

const mapEntry = (row: EntryRow) => {
  return {
    id: row.publicId,
    revision: row.revision,
    node: row.node,
    kind: row.kind,
    input: row.field,
    value: row.value,
    basis: row.basis,
    playbook_version: row.playbookVersion,
    created_by: row.createdBy?.publicId ?? null,
    created_at: row.createdAt,
  };
};

/** A case's entries, newest first: every value each field has held. */
export const listPlaybookCaseEntries = async (args: {
  projectIds?: number[];
  id: string;
  node?: string;
  limit?: number;
  offset?: number;
}) => {
  log('listPlaybookCaseEntries: id=%s node=%s', args.id, args.node);
  const row = await playbookCases.getByPublicId(args);
  const where: Record<string, unknown> = { caseId: row.id as number };
  if (args.node !== undefined) where.node = args.node;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['revision', 'DESC']],
    query: ({ limit, offset, order }) => {
      return db.PlaybookEntry.findAndCountAll({
        where,
        include: [{ model: db.User, as: 'createdBy' }],
        distinct: true,
        order,
        limit,
        offset,
      });
    },
    map: (entry) => {
      return mapEntry(entry as EntryRow);
    },
  });
};
