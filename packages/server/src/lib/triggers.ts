import createDebug from 'debug';
import { db } from 'src/db';
import { paginatedList } from 'src/lib/pagination';
import { makeResourceAccessor } from 'src/lib/resourceAccessor';

import { DomainError } from '../errors';
import {
  decryptStoredSecret,
  encryptValue,
  generateSecretValue,
} from './secrets';
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
  validateEventPattern,
  validateTriggerShape,
} from './triggerValidation';

const log = createDebug('soat:triggers');

const generateSecret = generateSecretValue;

const decryptTriggerSecret = (stored: string): string => {
  return decryptStoredSecret({ stored, label: 'decryptTriggerSecret' });
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
    project_id: instance.project?.publicId,
    name: instance.name,
    description: instance.description,
    type: instance.type,
    target_type: instance.targetType,
    target_id: instance.targetId,
    action: instance.action,
    input: instance.input,
    cron: instance.cron,
    event_pattern: instance.eventPattern,
    active: instance.active,
    policy_id: instance.policy?.publicId ?? null,
    next_fire_at: instance.nextFireAt,
    ...(args?.includeSecret
      ? { secret: decryptTriggerSecret(instance.secret as string) }
      : {}),
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

const triggerIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Policy, as: 'policy' },
    { model: db.User, as: 'createdBy' },
  ];
};

const triggers = makeResourceAccessor<TriggerInstance>({
  model: () => {
    return db.Trigger;
  },
  includes: triggerIncludes,
  label: 'Trigger',
});

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
  return triggers.getByPublicId({ id: args.id });
};

// ── CRUD ───────────────────────────────────────────────────────────────────

export const listTriggers = async (args: {
  projectIds: number[];
  type?: string;
  targetType?: string;
  limit?: number;
  offset?: number;
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

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Trigger.findAndCountAll({
        where,
        include: triggerIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (t) => {
      return mapTrigger(t);
    },
  });
};

export const findTrigger = async (args: { id: string }) => {
  const trigger = await triggers.findByPublicId({ id: args.id });
  return trigger ? mapTrigger(trigger) : null;
};

export const getTrigger = async (args: { id: string }) => {
  return mapTrigger(await triggers.getByPublicId({ id: args.id }));
};

/**
 * Loads the minimal context needed to authenticate and dispatch an inbound
 * hook delivery: the trigger's public id, active flag, and signing secret.
 * Returns `null` for an unknown trigger *or* a non-webhook trigger, so the
 * inbound endpoint can respond `404` without leaking which case it was.
 */
export const findWebhookTriggerForDelivery = async (args: { id: string }) => {
  const trigger = await db.Trigger.findOne({ where: { publicId: args.id } });
  if (!trigger || trigger.type !== 'webhook') return null;
  return {
    id: trigger.publicId as string,
    active: trigger.active as boolean,
    secret: decryptTriggerSecret(trigger.secret as string),
  };
};

/**
 * Returns a webhook trigger's signing secret. Throws `RESOURCE_NOT_FOUND` when
 * the trigger does not exist, and `TRIGGER_ACTION_NOT_ALLOWED` when it is not a
 * webhook trigger (only webhook triggers have a secret).
 */
export const getTriggerSecret = async (args: { id: string }) => {
  const trigger = await db.Trigger.findOne({ where: { publicId: args.id } });
  if (!trigger) throw triggers.notFound(args.id);
  if (trigger.type !== 'webhook') {
    throw new DomainError(
      'TRIGGER_ACTION_NOT_ALLOWED',
      'Only webhook triggers have a secret.'
    );
  }
  return { secret: decryptTriggerSecret(trigger.secret as string) };
};

/**
 * Returns a webhook trigger's signing secret, or `null` when the trigger does
 * not exist or is not a webhook trigger. The null-safe counterpart to
 * {@link getTriggerSecret}, used by the formation module's `getAttributes` to
 * resolve `ref_attr` secret outputs without throwing on non-webhook triggers.
 */
export const findTriggerSecret = async (args: { id: string }) => {
  const trigger = await db.Trigger.findOne({ where: { publicId: args.id } });
  if (!trigger || trigger.type !== 'webhook') return null;
  return { secret: decryptTriggerSecret(trigger.secret as string) };
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
  eventPattern?: string | null;
  active?: boolean;
};

/** Derives the type-dependent fields: a secret for webhooks, next fire for schedules. */
const deriveTypeFields = (args: { type: string; cron?: string | null }) => {
  return {
    secret: args.type === 'webhook' ? encryptValue(generateSecret()) : null,
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
    eventPattern: args.eventPattern ?? null,
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
    eventPattern: args.eventPattern,
  });
  await assertNameAvailable({ projectId: args.projectId, name: args.name });

  const trigger = await db.Trigger.create(buildCreateAttributes(args));
  log('createTrigger: created id=%s', trigger.publicId);

  return mapTrigger(await triggers.reload(trigger), {
    includeSecret: args.type === 'webhook',
  });
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
  eventPattern?: string | null;
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

/**
 * The update fields that are copied straight onto the column of the same name,
 * paired one to one. `cron` is deliberately absent: it also derives
 * `nextFireAt`, so it goes through {@link applyCronUpdate}.
 *
 * A pair list rather than a chain of `if`s because the chain grew past the
 * complexity ceiling as fields were added — and every name still appears
 * literally on both sides, so nothing here rewrites a key.
 */
const DIRECT_UPDATE_FIELDS = [
  ['name', 'name'],
  ['description', 'description'],
  ['policyId', 'policyId'],
  ['targetType', 'targetType'],
  ['targetId', 'targetId'],
  ['action', 'action'],
  ['input', 'input'],
  ['eventPattern', 'eventPattern'],
  ['active', 'active'],
] as const satisfies readonly (readonly [
  keyof UpdateTriggerArgs,
  keyof InstanceType<(typeof db)['Trigger']>,
])[];

/** Applies the provided update fields onto the trigger instance in place. */
const applyUpdateFields = (
  trigger: InstanceType<(typeof db)['Trigger']>,
  args: UpdateTriggerArgs
): void => {
  for (const [argKey, column] of DIRECT_UPDATE_FIELDS) {
    const value = args[argKey];
    if (value !== undefined) trigger.set(column, value);
  }
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
    eventPattern:
      args.eventPattern !== undefined
        ? args.eventPattern
        : trigger.eventPattern,
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

  return mapTrigger(await triggers.reload(trigger));
};

export const deleteTrigger = async (args: { id: string }) => {
  log('deleteTrigger: id=%s', args.id);
  const trigger = await db.Trigger.findOne({ where: { publicId: args.id } });
  if (!trigger) throw triggers.notFound(args.id);
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
  trigger.secret = encryptValue(generateSecret());
  await trigger.save();
  return mapTrigger(trigger, { includeSecret: true });
};
