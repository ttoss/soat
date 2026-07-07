import crypto from 'node:crypto';

import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import {
  assertTriggerConfigValid,
  computeNextFireAt,
} from './triggerValidation';

export type { TriggerTargetType, TriggerType } from './triggerValidation';
export {
  targetStartAction,
  TRIGGER_TARGET_TYPES,
  TRIGGER_TYPES,
  validateCronExpression,
  validateTriggerShape,
} from './triggerValidation';

const log = createDebug('soat:triggers');

const generateSecret = () => {
  return crypto.randomBytes(32).toString('hex');
};

type TriggerInstance = InstanceType<(typeof db)['Trigger']> & {
  project?: InstanceType<(typeof db)['Project']>;
  policy?: InstanceType<(typeof db)['Policy']> | null;
  createdBy?: InstanceType<(typeof db)['User']> | null;
};

const mapTrigger = (
  instance: TriggerInstance,
  args?: { includeSecret?: boolean }
) => {
  return {
    id: instance.publicId,
    projectId: instance.project?.publicId,
    name: instance.name,
    description: instance.description,
    type: instance.type,
    targetType: instance.targetType,
    targetId: instance.targetId,
    action: instance.action,
    input: instance.input,
    cron: instance.cron,
    active: instance.active,
    policyId: instance.policy?.publicId ?? null,
    nextFireAt: instance.nextFireAt,
    ...(args?.includeSecret ? { secret: instance.secret } : {}),
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

const triggerIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Policy, as: 'policy' },
    { model: db.User, as: 'createdBy' },
  ];
};

const assertNameAvailable = async (args: {
  projectId: number;
  name: string;
}): Promise<void> => {
  const existing = await db.Trigger.findOne({
    where: { projectId: args.projectId, name: args.name },
  });
  if (existing) {
    throw new DomainError(
      'NAME_CONFLICT',
      `Trigger '${args.name}' already exists in this project.`,
      { name: args.name }
    );
  }
};

const findTriggerOrThrow = async (args: { id: string }) => {
  const trigger = await db.Trigger.findOne({
    where: { publicId: args.id },
    include: triggerIncludes(),
  });
  if (!trigger) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Trigger '${args.id}' not found.`
    );
  }
  return trigger;
};

// ── CRUD ───────────────────────────────────────────────────────────────────

export const listTriggers = async (args: {
  projectIds: number[];
  type?: string;
  targetType?: string;
}) => {
  log(
    'listTriggers: projectIds=%o type=%s targetType=%s',
    args.projectIds,
    args.type,
    args.targetType
  );
  const where: Record<string, unknown> = { projectId: args.projectIds };
  if (args.type) where.type = args.type;
  if (args.targetType) where.targetType = args.targetType;

  const triggers = await db.Trigger.findAll({
    where,
    include: triggerIncludes(),
    order: [['createdAt', 'DESC']],
  });
  return triggers.map((t) => {
    return mapTrigger(t);
  });
};

export const findTrigger = async (args: { id: string }) => {
  const trigger = await db.Trigger.findOne({
    where: { publicId: args.id },
    include: triggerIncludes(),
  });
  return trigger ? mapTrigger(trigger) : null;
};

export const getTrigger = async (args: { id: string }) => {
  const trigger = await findTrigger({ id: args.id });
  if (!trigger) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Trigger '${args.id}' not found.`
    );
  }
  return trigger;
};

/**
 * Returns a webhook trigger's signing secret. Throws `RESOURCE_NOT_FOUND` when
 * the trigger does not exist, and `TRIGGER_ACTION_NOT_ALLOWED` when it is not a
 * webhook trigger (only webhook triggers have a secret).
 */
export const getTriggerSecret = async (args: { id: string }) => {
  const trigger = await db.Trigger.findOne({ where: { publicId: args.id } });
  if (!trigger) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Trigger '${args.id}' not found.`
    );
  }
  if (trigger.type !== 'webhook') {
    throw new DomainError(
      'TRIGGER_ACTION_NOT_ALLOWED',
      'Only webhook triggers have a secret.'
    );
  }
  return { secret: trigger.secret as string };
};

type CreateTriggerArgs = {
  projectId: number;
  createdByUserId?: number | null;
  policyId?: number | null;
  name: string;
  description?: string | null;
  type: string;
  targetType: string;
  targetId: string;
  action?: string | null;
  input?: Record<string, unknown> | null;
  cron?: string | null;
  active?: boolean;
};

/** Derives the type-dependent fields: a secret for webhooks, next fire for schedules. */
const deriveTypeFields = (args: { type: string; cron?: string | null }) => {
  return {
    secret: args.type === 'webhook' ? generateSecret() : null,
    nextFireAt:
      args.type === 'schedule' && args.cron
        ? computeNextFireAt(args.cron)
        : null,
  };
};

const buildCreateAttributes = (args: CreateTriggerArgs) => {
  return {
    projectId: args.projectId,
    createdByUserId: args.createdByUserId ?? null,
    policyId: args.policyId ?? null,
    name: args.name,
    description: args.description ?? null,
    type: args.type,
    targetType: args.targetType,
    targetId: args.targetId,
    action: args.action ?? null,
    input: args.input ?? null,
    cron: args.cron ?? null,
    active: args.active ?? true,
    ...deriveTypeFields({ type: args.type, cron: args.cron }),
  };
};

export const createTrigger = async (args: CreateTriggerArgs) => {
  log(
    'createTrigger: projectId=%d name=%s type=%s targetType=%s',
    args.projectId,
    args.name,
    args.type,
    args.targetType
  );

  await assertTriggerConfigValid({
    type: args.type,
    targetType: args.targetType,
    targetId: args.targetId,
    projectId: args.projectId,
    action: args.action,
    cron: args.cron,
  });
  await assertNameAvailable({ projectId: args.projectId, name: args.name });

  const trigger = await db.Trigger.create(buildCreateAttributes(args));
  log('createTrigger: created id=%s', trigger.publicId);

  const created = await db.Trigger.findOne({
    where: { id: trigger.id },
    include: triggerIncludes(),
  });
  return mapTrigger(created!, { includeSecret: args.type === 'webhook' });
};

type UpdateTriggerArgs = {
  id: string;
  policyId?: number | null;
  name?: string;
  description?: string | null;
  targetType?: string;
  targetId?: string;
  action?: string | null;
  input?: Record<string, unknown> | null;
  cron?: string | null;
  active?: boolean;
};

const applyCronUpdate = (
  trigger: InstanceType<(typeof db)['Trigger']>,
  cron: string | null
): void => {
  trigger.cron = cron;
  trigger.nextFireAt =
    trigger.type === 'schedule' && cron ? computeNextFireAt(cron) : null;
};

/** Applies the provided update fields onto the trigger instance in place. */
const applyUpdateFields = (
  trigger: InstanceType<(typeof db)['Trigger']>,
  args: UpdateTriggerArgs
): void => {
  if (args.name !== undefined) trigger.name = args.name;
  if (args.description !== undefined) trigger.description = args.description;
  if (args.policyId !== undefined) trigger.policyId = args.policyId;
  if (args.targetType !== undefined) trigger.targetType = args.targetType;
  if (args.targetId !== undefined) trigger.targetId = args.targetId;
  if (args.action !== undefined) trigger.action = args.action;
  if (args.input !== undefined) trigger.input = args.input;
  if (args.active !== undefined) trigger.active = args.active;
  if (args.cron !== undefined) applyCronUpdate(trigger, args.cron);
};

export const updateTrigger = async (args: UpdateTriggerArgs) => {
  log('updateTrigger: id=%s', args.id);

  const trigger = await findTriggerOrThrow({ id: args.id });

  const targetChanged =
    args.targetType !== undefined ||
    args.targetId !== undefined ||
    args.action !== undefined;

  await assertTriggerConfigValid({
    type: trigger.type as string,
    targetType: args.targetType ?? (trigger.targetType as string),
    targetId: args.targetId ?? (trigger.targetId as string),
    projectId: trigger.projectId as number,
    action: args.action !== undefined ? args.action : trigger.action,
    cron: args.cron !== undefined ? args.cron : trigger.cron,
    validateTarget: targetChanged,
  });

  if (args.name !== undefined && args.name !== trigger.name) {
    await assertNameAvailable({
      projectId: trigger.projectId as number,
      name: args.name,
    });
  }

  applyUpdateFields(trigger, args);
  await trigger.save();

  const updated = await db.Trigger.findOne({
    where: { id: trigger.id },
    include: triggerIncludes(),
  });
  return mapTrigger(updated!);
};

export const deleteTrigger = async (args: { id: string }) => {
  log('deleteTrigger: id=%s', args.id);
  const trigger = await db.Trigger.findOne({ where: { publicId: args.id } });
  if (!trigger) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Trigger '${args.id}' not found.`
    );
  }
  await trigger.destroy();
};

export const rotateTriggerSecret = async (args: { id: string }) => {
  log('rotateTriggerSecret: id=%s', args.id);
  const trigger = await findTriggerOrThrow({ id: args.id });
  if (trigger.type !== 'webhook') {
    throw new DomainError(
      'TRIGGER_ACTION_NOT_ALLOWED',
      'Only webhook triggers have a secret.'
    );
  }
  trigger.secret = generateSecret();
  await trigger.save();
  return mapTrigger(trigger, { includeSecret: true });
};
