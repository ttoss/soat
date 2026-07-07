import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';

const log = createDebug('soat:triggers');

type TriggerFiringInstance = InstanceType<(typeof db)['TriggerFiring']> & {
  trigger?: InstanceType<(typeof db)['Trigger']>;
  project?: InstanceType<(typeof db)['Project']>;
};

export const mapTriggerFiring = (instance: TriggerFiringInstance) => {
  return {
    id: instance.publicId,
    triggerId: instance.trigger?.publicId,
    projectId: instance.project?.publicId,
    source: instance.source,
    status: instance.status,
    input: instance.input,
    result: instance.result,
    error: instance.error,
    startedAt: instance.startedAt,
    completedAt: instance.completedAt,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
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
 * Returns a firing record by public id, re-fetched with associations so
 * `mapTriggerFiring` can resolve the trigger/project public ids.
 */
export const getFiringById = async (args: { internalId: number }) => {
  const firing = await db.TriggerFiring.findOne({
    where: { id: args.internalId },
    include: firingIncludes(),
  });
  return firing ? mapTriggerFiring(firing) : null;
};

export const listTriggerFirings = async (args: {
  triggerPublicId: string;
  limit?: number;
  offset?: number;
}) => {
  const trigger = await db.Trigger.findOne({
    where: { publicId: args.triggerPublicId },
  });
  if (!trigger) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Trigger '${args.triggerPublicId}' not found.`
    );
  }

  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  const { rows, count } = await db.TriggerFiring.findAndCountAll({
    where: { triggerId: trigger.id as number },
    include: firingIncludes(),
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return {
    data: rows.map((r) => {
      return mapTriggerFiring(r);
    }),
    total: count,
    limit,
    offset,
  };
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
