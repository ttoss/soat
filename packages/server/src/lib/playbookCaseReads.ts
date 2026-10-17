import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { paginatedList } from './pagination';
import { caseDefinition, caseNodeStates, playbookCases } from './playbookCases';
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
      `node_id must name a node of the case's playbook version.`,
      { node_id: args.node }
    );
  }

  const { views } = await caseNodeStates({
    caseDbId: row.id as number,
    definition,
  });
  const waves = playbookMissingInputs({ definition, views, node: args.node });

  return { case_id: row.publicId, node_id: args.node, waves };
};

const mapEntry = (row: InstanceType<(typeof db)['PlaybookEntry']>) => {
  return {
    id: row.publicId,
    revision: row.revision,
    node_id: row.node,
    kind: row.kind,
    input: row.field,
    value: row.value,
    basis: row.basis,
    playbook_version: row.playbookVersion,
    created_by_principal_type: row.createdByPrincipalType,
    created_by_principal_id: row.createdByPrincipalId,
    on_behalf_of: row.onBehalfOf ?? null,
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
        order,
        limit,
        offset,
      });
    },
    map: (entry) => {
      return mapEntry(entry);
    },
  });
};
