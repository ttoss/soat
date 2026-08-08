import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { paginatedList } from './pagination';

const log = createDebug('soat:triggers');

type TriggerFiringInstance = InstanceType<(typeof db)['TriggerFiring']> & {
  trigger?: InstanceType<(typeof db)['Trigger']>;
  project?: InstanceType<(typeof db)['Project']>;
};

export const mapTriggerFiring = (instance: TriggerFiringInstance) => {
  return {
    id: instance.publicId,
    trigger_id: instance.trigger?.publicId,
    project_id: instance.project?.publicId,
    source: instance.source,
    status: instance.status,
    input: instance.input,
    result: instance.result,
    error: instance.error,
    started_at: instance.startedAt,
    completed_at: instance.completedAt,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

const firingIncludes = () => {
  return [
    { model: db.Trigger, as: 'trigger' },
    { model: db.Project, as: 'project' },
  ];
};

/**
 * Creates a firing record in the `pending` state with the effective input
 * snapshot. The dispatcher transitions it to `running` and then a terminal
 * state. Returns the raw instance so the dispatcher can finalize it.
 */
export const createFiringRecord = async (args: {
  triggerId: number;
  projectId: number;
  source: string;
  input: Record<string, unknown> | null;
}): Promise<InstanceType<(typeof db)['TriggerFiring']>> => {
  const firing = await db.TriggerFiring.create({
    triggerId: args.triggerId,
    projectId: args.projectId,
    source: args.source,
    status: 'pending',
    input: args.input,
    result: null,
    error: null,
    startedAt: null,
    completedAt: null,
  });
  log('createFiringRecord: id=%s source=%s', firing.publicId, args.source);
  return firing;
};

export const finalizeFiringSucceeded = async (args: {
  firing: InstanceType<(typeof db)['TriggerFiring']>;
  result: Record<string, unknown>;
}) => {
  args.firing.status = 'succeeded';
  args.firing.result = args.result;
  args.firing.completedAt = new Date();
  await args.firing.save();
};

export const finalizeFiringFailed = async (args: {
  firing: InstanceType<(typeof db)['TriggerFiring']>;
  error: Record<string, unknown>;
}) => {
  args.firing.status = 'failed';
  args.firing.error = args.error;
  args.firing.completedAt = new Date();
  await args.firing.save();
};

/**
 * Re-reads a firing the caller already holds, with the associations
 * `mapTriggerFiring` needs to resolve the trigger/project public ids.
 *
 * A `reload` rather than a lookup by id, because the caller has the instance:
 * there is no "not found" case to branch on — Sequelize throws if the row is
 * gone, and the one caller re-reads a row it just wrote inside a `try` that
 * falls back to the in-memory instance. A lookup returning `null` only added a
 * branch no entry point can reach.
 */
export const reloadFiring = async (args: {
  firing: InstanceType<(typeof db)['TriggerFiring']>;
}) => {
  await args.firing.reload({ include: firingIncludes() });
  return mapTriggerFiring(args.firing);
};

/**
 * Firings of one trigger, scoped by the trigger's public id through the join it
 * already needs for `mapTriggerFiring`.
 *
 * It deliberately does not re-resolve the trigger first: the only caller is the
 * route, which resolves it through `getTrigger` to authorize against its project
 * — so a second lookup here restated the "trigger not found" rule in a branch no
 * request could reach. An unknown id simply yields an empty page.
 */
export const listTriggerFirings = async (args: {
  triggerPublicId: string;
  limit?: number;
  offset?: number;
}) => {
  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.TriggerFiring.findAndCountAll({
        include: [
          {
            model: db.Trigger,
            as: 'trigger',
            where: { publicId: args.triggerPublicId },
            required: true,
          },
          { model: db.Project, as: 'project' },
        ],
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (row) => {
      return mapTriggerFiring(row);
    },
  });
};

export const getTriggerFiring = async (args: { id: string }) => {
  const firing = await db.TriggerFiring.findOne({
    where: { publicId: args.id },
    include: firingIncludes(),
  });
  if (!firing) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Trigger firing '${args.id}' not found.`
    );
  }
  return mapTriggerFiring(firing);
};
