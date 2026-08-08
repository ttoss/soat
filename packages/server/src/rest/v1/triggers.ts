import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import { fireTriggerNow } from 'src/lib/triggerDispatch';
import { getTriggerFiring, listTriggerFirings } from 'src/lib/triggerFirings';
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  getTriggerSecret,
  listTriggers,
  rotateTriggerSecret,
  targetStartAction,
  updateTrigger,
} from 'src/lib/triggers';

import {
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';

const triggersRouter = new Router<Context>();

const resolvePolicyId = async (
  policyPublicId: string | undefined
): Promise<number | null> => {
  if (!policyPublicId) return null;
  const policy = await db.Policy.findOne({
    where: { publicId: policyPublicId },
  });
  if (!policy) {
    throw new DomainError(
      'POLICY_NOT_FOUND',
      `Policy '${policyPublicId}' not found.`
    );
  }
  return policy.id;
};

triggersRouter.get('/triggers', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;
  const type = ctx.query.type as string | undefined;
  const targetType = ctx.query.target_type as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'triggers:ListTriggers',
    resourceType: 'trigger',
  });
  ctx.body = await listTriggers({
    projectIds: projectIds ?? [],
    type,
    targetType,
    ...parsePagination(ctx),
  });
});

triggersRouter.get('/triggers/:trigger_id', async (ctx: Context) => {
  requireAuth(ctx);

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: trigger.project_id!,
    action: 'triggers:GetTrigger',
    resource: buildSrn({
      projectPublicId: trigger.project_id!,
      resourceType: 'trigger',
      resourceId: trigger.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  ctx.body = trigger;
});

triggersRouter.post('/triggers', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    name: string;
    description?: string;
    type: string;
    target_type: string;
    target_id: string;
    action?: string;
    input?: Record<string, unknown>;
    cron?: string;
    active?: boolean;
    policy_id?: string;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'triggers:CreateTrigger',
    resourceType: 'trigger',
  });
  // No privilege escalation: the caller must also hold the target-start action.
  const projectPublicId =
    body.project_id ?? ctx.authUser!.apiKeyProjectPublicId;
  const canStartTarget = await ctx.authUser!.isAllowed({
    projectPublicId: projectPublicId!,
    action: targetStartAction(body.target_type),
    resource: buildSrn({
      projectPublicId: projectPublicId!,
      resourceType: body.target_type,
      resourceId: body.target_id,
    }),
  });
  if (!canStartTarget) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const policyId = await resolvePolicyId(body.policy_id);

  const trigger = await createTrigger({
    projectId: Number(targetProjectId),
    createdByUserId: ctx.authUser!.id,
    policyId,
    name: body.name,
    description: body.description,
    type: body.type,
    targetType: body.target_type,
    targetId: body.target_id,
    action: body.action,
    input: body.input,
    cron: body.cron,
    active: body.active,
  });

  ctx.status = 201;
  ctx.body = trigger;
});

triggersRouter.patch('/triggers/:trigger_id', async (ctx: Context) => {
  requireAuth(ctx);

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: trigger.project_id!,
    action: 'triggers:UpdateTrigger',
    resource: buildSrn({
      projectPublicId: trigger.project_id!,
      resourceType: 'trigger',
      resourceId: trigger.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const body = ctx.request.body as {
    name?: string;
    description?: string | null;
    target_type?: string;
    target_id?: string;
    action?: string | null;
    input?: Record<string, unknown> | null;
    cron?: string | null;
    active?: boolean;
    policy_id?: string | null;
  };

  // Re-check the target-start action when the target type changes.
  if (
    body.target_type !== undefined &&
    body.target_type !== trigger.target_type
  ) {
    const canStartTarget = await ctx.authUser.isAllowed({
      projectPublicId: trigger.project_id!,
      action: targetStartAction(body.target_type),
      resource: buildSrn({
        projectPublicId: trigger.project_id!,
        resourceType: body.target_type,
        resourceId: body.target_id ?? (trigger.target_id as string),
      }),
    });
    if (!canStartTarget) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }
  }

  const policyId =
    body.policy_id === undefined
      ? undefined
      : await resolvePolicyId(body.policy_id ?? undefined);

  const updated = await updateTrigger({
    id: ctx.params.trigger_id,
    name: body.name,
    description: body.description,
    targetType: body.target_type,
    targetId: body.target_id,
    action: body.action,
    input: body.input,
    cron: body.cron,
    active: body.active,
    policyId: body.policy_id === null ? null : policyId,
  });

  ctx.body = updated;
});

triggersRouter.delete('/triggers/:trigger_id', async (ctx: Context) => {
  requireAuth(ctx);

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: trigger.project_id!,
    action: 'triggers:DeleteTrigger',
    resource: buildSrn({
      projectPublicId: trigger.project_id!,
      resourceType: 'trigger',
      resourceId: trigger.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  await deleteTrigger({ id: ctx.params.trigger_id });
  ctx.status = 204;
});

triggersRouter.post('/triggers/:trigger_id/fire', async (ctx: Context) => {
  requireAuth(ctx);

  // No recursion: a trigger run-as credential cannot fire a trigger.
  if (ctx.authUser.isTriggerToken) {
    throw new DomainError(
      'TRIGGER_RECURSION_FORBIDDEN',
      'A trigger-scoped credential cannot fire a trigger.'
    );
  }

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: trigger.project_id!,
    action: 'triggers:FireTrigger',
    resource: buildSrn({
      projectPublicId: trigger.project_id!,
      resourceType: 'trigger',
      resourceId: trigger.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const body = ctx.request.body as {
    input?: Record<string, unknown>;
  };

  const firing = await fireTriggerNow({
    triggerPublicId: ctx.params.trigger_id,
    source: 'manual',
    fireInput: body.input,
  });

  ctx.status = 200;
  ctx.body = firing;
});

triggersRouter.get('/trigger-firings', async (ctx: Context) => {
  requireAuth(ctx);

  const triggerPublicId = ctx.query.trigger_id as string | undefined;
  if (!triggerPublicId) {
    throw new DomainError('VALIDATION_FAILED', 'trigger_id is required.');
  }

  // Authorize against the trigger's project: 404 if the trigger is missing,
  // 403 if the caller lacks access (a permission-less JWT user resolves to an
  // empty project set, which would otherwise read as "not found").
  const trigger = await getTrigger({ id: triggerPublicId });
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: trigger.project_id!,
    action: 'triggers:ListTriggerFirings',
    resource: buildSrn({
      projectPublicId: trigger.project_id!,
      resourceType: 'trigger',
      resourceId: trigger.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined;
  const offset = ctx.query.offset ? Number(ctx.query.offset) : undefined;

  ctx.body = await listTriggerFirings({
    triggerPublicId,
    limit,
    offset,
  });
});

triggersRouter.get('/trigger-firings/:firing_id', async (ctx: Context) => {
  requireAuth(ctx);

  const firing = await getTriggerFiring({ id: ctx.params.firing_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: firing.project_id!,
    action: 'triggers:GetTriggerFiring',
    resource: buildSrn({
      projectPublicId: firing.project_id!,
      resourceType: 'triggerFiring',
      resourceId: firing.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  ctx.body = firing;
});

triggersRouter.get('/triggers/:trigger_id/secret', async (ctx: Context) => {
  requireAuth(ctx);

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: trigger.project_id!,
    action: 'triggers:GetTriggerSecret',
    resource: buildSrn({
      projectPublicId: trigger.project_id!,
      resourceType: 'trigger',
      resourceId: trigger.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  ctx.body = await getTriggerSecret({ id: ctx.params.trigger_id });
});

triggersRouter.post(
  '/triggers/:trigger_id/rotate-secret',
  async (ctx: Context) => {
    requireAuth(ctx);

    const trigger = await getTrigger({ id: ctx.params.trigger_id });

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: trigger.project_id!,
      action: 'triggers:RotateTriggerSecret',
      resource: buildSrn({
        projectPublicId: trigger.project_id!,
        resourceType: 'trigger',
        resourceId: trigger.id,
      }),
    });
    if (!allowed) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    ctx.body = await rotateTriggerSecret({ id: ctx.params.trigger_id });
  }
);

export { triggersRouter };
