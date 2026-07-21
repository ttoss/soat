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

import { checkAuth, resolveWriteProjectId } from './helpers';

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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;
  const type = ctx.query.type as string | undefined;
  const targetType = ctx.query.targetType as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'triggers:ListTriggers',
    resourceType: 'trigger',
  });
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listTriggers({
    projectIds: projectIds ?? [],
    type,
    targetType,
  });
});

triggersRouter.get('/triggers/:trigger_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: trigger.projectId!,
    action: 'triggers:GetTrigger',
    resource: buildSrn({
      projectPublicId: trigger.projectId!,
      resourceType: 'trigger',
      resourceId: trigger.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = trigger;
});

triggersRouter.post('/triggers', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as {
    projectId?: string;
    name: string;
    description?: string;
    type: string;
    targetType: string;
    targetId: string;
    action?: string;
    input?: Record<string, unknown>;
    cron?: string;
    active?: boolean;
    policyId?: string;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'triggers:CreateTrigger',
    resourceType: 'trigger',
  });
  if (targetProjectId === null) return;

  // No privilege escalation: the caller must also hold the target-start action.
  const projectPublicId = body.projectId ?? ctx.authUser!.apiKeyProjectPublicId;
  const canStartTarget = await ctx.authUser!.isAllowed({
    projectPublicId: projectPublicId!,
    action: targetStartAction(body.targetType),
    resource: buildSrn({
      projectPublicId: projectPublicId!,
      resourceType: body.targetType,
      resourceId: body.targetId,
    }),
  });
  if (!canStartTarget) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const policyId = await resolvePolicyId(body.policyId);

  const trigger = await createTrigger({
    projectId: Number(targetProjectId),
    createdByUserId: ctx.authUser!.id,
    policyId,
    name: body.name,
    description: body.description,
    type: body.type,
    targetType: body.targetType,
    targetId: body.targetId,
    action: body.action,
    input: body.input,
    cron: body.cron,
    active: body.active,
  });

  ctx.status = 201;
  ctx.body = trigger;
});

triggersRouter.patch('/triggers/:trigger_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: trigger.projectId!,
    action: 'triggers:UpdateTrigger',
    resource: buildSrn({
      projectPublicId: trigger.projectId!,
      resourceType: 'trigger',
      resourceId: trigger.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    name?: string;
    description?: string | null;
    targetType?: string;
    targetId?: string;
    action?: string | null;
    input?: Record<string, unknown> | null;
    cron?: string | null;
    active?: boolean;
    policyId?: string | null;
  };

  // Re-check the target-start action when the target type changes.
  if (body.targetType !== undefined && body.targetType !== trigger.targetType) {
    const canStartTarget = await ctx.authUser.isAllowed({
      projectPublicId: trigger.projectId!,
      action: targetStartAction(body.targetType),
      resource: buildSrn({
        projectPublicId: trigger.projectId!,
        resourceType: body.targetType,
        resourceId: body.targetId ?? (trigger.targetId as string),
      }),
    });
    if (!canStartTarget) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }
  }

  const policyId =
    body.policyId === undefined
      ? undefined
      : await resolvePolicyId(body.policyId ?? undefined);

  const updated = await updateTrigger({
    id: ctx.params.trigger_id,
    name: body.name,
    description: body.description,
    targetType: body.targetType,
    targetId: body.targetId,
    action: body.action,
    input: body.input,
    cron: body.cron,
    active: body.active,
    policyId: body.policyId === null ? null : policyId,
  });

  ctx.body = updated;
});

triggersRouter.delete('/triggers/:trigger_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: trigger.projectId!,
    action: 'triggers:DeleteTrigger',
    resource: buildSrn({
      projectPublicId: trigger.projectId!,
      resourceType: 'trigger',
      resourceId: trigger.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteTrigger({ id: ctx.params.trigger_id });
  ctx.status = 204;
});

triggersRouter.post('/triggers/:trigger_id/fire', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  // No recursion: a trigger run-as credential cannot fire a trigger.
  if (ctx.authUser.isTriggerToken) {
    throw new DomainError(
      'TRIGGER_RECURSION_FORBIDDEN',
      'A trigger-scoped credential cannot fire a trigger.'
    );
  }

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: trigger.projectId!,
    action: 'triggers:FireTrigger',
    resource: buildSrn({
      projectPublicId: trigger.projectId!,
      resourceType: 'trigger',
      resourceId: trigger.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = (ctx.request.body ?? {}) as {
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const triggerPublicId = ctx.query.triggerId as string | undefined;
  if (!triggerPublicId) {
    throw new DomainError('VALIDATION_FAILED', 'trigger_id is required.');
  }

  // Authorize against the trigger's project: 404 if the trigger is missing,
  // 403 if the caller lacks access (a permission-less JWT user resolves to an
  // empty project set, which would otherwise read as "not found").
  const trigger = await getTrigger({ id: triggerPublicId });
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: trigger.projectId!,
    action: 'triggers:ListTriggerFirings',
    resource: buildSrn({
      projectPublicId: trigger.projectId!,
      resourceType: 'trigger',
      resourceId: trigger.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const firing = await getTriggerFiring({ id: ctx.params.firing_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: firing.projectId!,
    action: 'triggers:GetTriggerFiring',
    resource: buildSrn({
      projectPublicId: firing.projectId!,
      resourceType: 'triggerFiring',
      resourceId: firing.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = firing;
});

triggersRouter.get('/triggers/:trigger_id/secret', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: trigger.projectId!,
    action: 'triggers:GetTriggerSecret',
    resource: buildSrn({
      projectPublicId: trigger.projectId!,
      resourceType: 'trigger',
      resourceId: trigger.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await getTriggerSecret({ id: ctx.params.trigger_id });
});

triggersRouter.post(
  '/triggers/:trigger_id/rotate-secret',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const trigger = await getTrigger({ id: ctx.params.trigger_id });

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: trigger.projectId!,
      action: 'triggers:RotateTriggerSecret',
      resource: buildSrn({
        projectPublicId: trigger.projectId!,
        resourceType: 'trigger',
        resourceId: trigger.id,
      }),
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    ctx.body = await rotateTriggerSecret({ id: ctx.params.trigger_id });
  }
);

export { triggersRouter };
