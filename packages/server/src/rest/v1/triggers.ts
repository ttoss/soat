import { Router } from '@ttoss/http-server';
import type { AuthUser, Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import { sanitizeCallerToolContext } from 'src/lib/toolContext';
import { fireTriggerNow } from 'src/lib/triggerDispatch';
import { getTriggerFiring, listTriggerFirings } from 'src/lib/triggerFirings';
import {
  countTriggers,
  createTrigger,
  deleteTrigger,
  getTrigger,
  getTriggerSecret,
  listTriggers,
  mayStartTarget,
  rotateTriggerSecret,
  TRIGGER_TARGET_TYPES,
  TRIGGER_TYPES,
  updateTrigger,
} from 'src/lib/triggers';

import {
  type AuthenticatedContext,
  parseEnumQuery,
  parseNullableToolContextBody,
  parsePagination,
  parseToolContextBody,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';
import { resourceRefusal } from './resourceAccess';

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

/** `type` and `target_type`, read once for the list and its count. */
const readTriggerListFilters = (ctx: Context) => {
  return {
    type: parseEnumQuery({ ctx, name: 'type', allowed: TRIGGER_TYPES }),
    targetType: parseEnumQuery({
      ctx,
      name: 'target_type',
      allowed: TRIGGER_TARGET_TYPES,
    }),
  };
};

triggersRouter.get('/triggers', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'triggers:ListTriggers',
    resourceType: 'trigger',
  });
  ctx.body = await listTriggers({
    projectIds: projectIds ?? [],
    ...readTriggerListFilters(ctx),
    ...parsePagination(ctx),
  });
});

triggersRouter.get('/triggers/count', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId: ctx.query.project_id as string | undefined,
    action: 'triggers:ListTriggers',
    resourceType: 'trigger',
  });
  ctx.body = await countTriggers({
    projectIds: projectIds ?? [],
    ...readTriggerListFilters(ctx),
  });
});

/**
 * Authorizes `action` on a loaded trigger against its own SRN; a refusal is
 * `resourceRefusal`'s.
 */
const authorizeTrigger = async (args: {
  ctx: AuthenticatedContext;
  trigger: { id: string; project_id?: string };
  action: string;
}): Promise<void> => {
  const projectPublicId = args.trigger.project_id!;
  const allowed = await args.ctx.authUser.isAllowed({
    projectPublicId,
    action: args.action,
    resource: buildSrn({
      projectPublicId,
      resourceType: 'trigger',
      resourceId: args.trigger.id,
    }),
  });
  if (!allowed) {
    throw await resourceRefusal({
      ctx: args.ctx,
      projectPublicId,
      notFound: new DomainError(
        'RESOURCE_NOT_FOUND',
        `Trigger '${args.trigger.id}' not found.`
      ),
    });
  }
};

triggersRouter.get('/triggers/:trigger_id', async (ctx: Context) => {
  requireAuth(ctx);

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  await authorizeTrigger({ ctx, trigger, action: 'triggers:GetTrigger' });

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
    tool_context?: unknown;
    cron?: string;
    event_pattern?: string;
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
  const canStartTarget = await mayStartTarget({
    isAllowed: ctx.authUser!.isAllowed,
    projectPublicId: projectPublicId!,
    targetType: body.target_type,
    targetId: body.target_id,
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
    toolContext: parseToolContextBody(body.tool_context),
    cron: body.cron,
    eventPattern: body.event_pattern,
    active: body.active,
    isAllowed: ctx.authUser!.isAllowed,
  });

  ctx.status = 201;
  ctx.body = trigger;
});

/** A caller-supplied object that lays something over the stored firing. */
const carriesFields = (value: unknown): boolean => {
  return (
    typeof value === 'object' && value !== null && Object.keys(value).length > 0
  );
};

/** The caller must be able to start the target themselves; `403` otherwise. */
const assertCallerMayStart = async (args: {
  authUser: AuthUser;
  projectPublicId: string;
  targetType: string;
  targetId: string;
}): Promise<void> => {
  const canStartTarget = await mayStartTarget({
    isAllowed: args.authUser.isAllowed,
    projectPublicId: args.projectPublicId,
    targetType: args.targetType,
    targetId: args.targetId,
  });
  if (!canStartTarget) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
};

/**
 * A firing runs as the creator, so every field that shapes what it does asks
 * the create route's question again, against the effective target pair.
 */
const assertMayShapeUpdatedFiring = async (args: {
  authUser: AuthUser;
  trigger: { project_id?: string; target_type?: unknown; target_id?: unknown };
  body: {
    target_type?: string;
    target_id?: string;
    action?: string | null;
    input?: Record<string, unknown> | null;
    policy_id?: string | null;
  };
  toolContext: Record<string, string> | null | undefined;
}): Promise<void> => {
  const { authUser, trigger, body, toolContext } = args;
  const retypes =
    body.target_type !== undefined && body.target_type !== trigger.target_type;
  const repoints =
    body.target_id !== undefined && body.target_id !== trigger.target_id;
  const reshapes = [body.action, body.input, toolContext, body.policy_id].some(
    (field) => {
      return field !== undefined;
    }
  );
  if (!retypes && !repoints && !reshapes) return;

  await assertCallerMayStart({
    authUser,
    projectPublicId: trigger.project_id!,
    targetType: body.target_type ?? (trigger.target_type as string),
    targetId: body.target_id ?? (trigger.target_id as string),
  });
};

triggersRouter.patch('/triggers/:trigger_id', async (ctx: Context) => {
  requireAuth(ctx);

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  await authorizeTrigger({ ctx, trigger, action: 'triggers:UpdateTrigger' });

  const body = ctx.request.body as {
    name?: string;
    description?: string | null;
    target_type?: string;
    target_id?: string;
    action?: string | null;
    input?: Record<string, unknown> | null;
    tool_context?: unknown;
    cron?: string | null;
    event_pattern?: string | null;
    active?: boolean;
    policy_id?: string | null;
  };

  const toolContext = parseNullableToolContextBody(body.tool_context);

  await assertMayShapeUpdatedFiring({
    authUser: ctx.authUser,
    trigger,
    body,
    toolContext,
  });

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
    toolContext,
    cron: body.cron,
    eventPattern: body.event_pattern,
    active: body.active,
    policyId: body.policy_id === null ? null : policyId,
    isAllowed: ctx.authUser!.isAllowed,
  });

  ctx.body = updated;
});

triggersRouter.delete('/triggers/:trigger_id', async (ctx: Context) => {
  requireAuth(ctx);

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  await authorizeTrigger({ ctx, trigger, action: 'triggers:DeleteTrigger' });

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

  await authorizeTrigger({ ctx, trigger, action: 'triggers:FireTrigger' });

  const body = ctx.request.body as {
    input?: Record<string, unknown>;
    tool_context?: unknown;
  };

  const toolContext = parseToolContextBody(body.tool_context);

  if (carriesFields(body.input) || carriesFields(toolContext)) {
    await assertCallerMayStart({
      authUser: ctx.authUser,
      projectPublicId: trigger.project_id!,
      targetType: trigger.target_type as string,
      targetId: trigger.target_id as string,
    });
  }

  const firing = await fireTriggerNow({
    triggerPublicId: ctx.params.trigger_id,
    source: 'manual',
    fireInput: body.input,
    // The fired half is caller data on a live request, and a firing whose
    // target is a tool reaches it with no generation in between — so the
    // reserved identity keys are stripped here, where the caller's bytes
    // arrive, rather than trusted.
    fireToolContext: sanitizeCallerToolContext(toolContext),
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
  await authorizeTrigger({
    ctx,
    trigger,
    action: 'triggers:ListTriggerFirings',
  });

  ctx.body = await listTriggerFirings({
    triggerPublicId,
    ...parsePagination(ctx),
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
    throw await resourceRefusal({
      ctx,
      projectPublicId: firing.project_id!,
      notFound: new DomainError(
        'RESOURCE_NOT_FOUND',
        `Trigger firing '${ctx.params.firing_id}' not found.`
      ),
    });
  }

  ctx.body = firing;
});

triggersRouter.get('/triggers/:trigger_id/secret', async (ctx: Context) => {
  requireAuth(ctx);

  const trigger = await getTrigger({ id: ctx.params.trigger_id });

  await authorizeTrigger({ ctx, trigger, action: 'triggers:GetTriggerSecret' });

  ctx.body = await getTriggerSecret({ id: ctx.params.trigger_id });
});

triggersRouter.post(
  '/triggers/:trigger_id/rotate-secret',
  async (ctx: Context) => {
    requireAuth(ctx);

    const trigger = await getTrigger({ id: ctx.params.trigger_id });

    await authorizeTrigger({
      ctx,
      trigger,
      action: 'triggers:RotateTriggerSecret',
    });

    ctx.body = await rotateTriggerSecret({ id: ctx.params.trigger_id });
  }
);

export { triggersRouter };
