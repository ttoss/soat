import { Router } from '@ttoss/http-server';
import type { AuthUser, Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import {
  approveApproval,
  getApproval,
  listApprovalRecurrences,
  listApprovals,
  rejectApproval,
  type WireProposedAction,
} from 'src/lib/approvals';
import { buildSrn } from 'src/lib/iam';
import { soatTools } from 'src/lib/soatTools';

import type { ProjectOwned } from './helpers';
import { parsePagination, requireAuth, resolveReadProjectIds } from './helpers';

const approvalsRouter = new Router<Context>();

/**
 * Item-level SRN for a single approval. The get/resolve handlers authorize
 * against this concrete resource rather than the implicit `*` default so a
 * project-scoped principal — whose policy grants an SRN pattern such as
 * `srn:<project>:*:*`, never the bare `*` — is granted access. Passing no
 * resource defaults to `*`, which such a policy cannot match, wrongly denying
 * get/approve/reject while `list` (already SRN-checked) succeeds.
 */
const approvalSrn = (approval: { id: string } & ProjectOwned): string => {
  return buildSrn({
    projectPublicId: approval.project_id!,
    resourceType: 'approval',
    resourceId: approval.id,
  });
};

/**
 * The IAM action a `builtin` proposal would perform, or `undefined` when the
 * proposal is not one — an `http`/`mcp`/`client`/`pipeline` tool, a tool that
 * no longer exists, or a builtin naming an action the catalog does not know.
 */
const proposedBuiltinIamAction = async (args: {
  projectPublicId: string;
  proposed: NonNullable<WireProposedAction>;
}): Promise<string | undefined> => {
  if (!args.proposed.action) return undefined;

  const project = await db.Project.findOne({
    where: { publicId: args.projectPublicId },
    attributes: ['id'],
  });
  if (!project) return undefined;

  const tool = await db.Tool.findOne({
    where: { publicId: args.proposed.tool_id, projectId: project.id },
    attributes: ['type'],
  });
  if (tool?.type !== 'builtin') return undefined;

  return soatTools.find((def) => {
    return def.name === args.proposed.action;
  })?.iamAction;
};

/**
 * The authority an **edit** needs, on top of the right to resolve.
 *
 * Approving as proposed adjudicates a call somebody else's agent composed;
 * editing composes a new one — and the approved action executes under the
 * *proposing* generation's principal, not the approver's. Without this, an
 * approver holding nothing but `approvals:ResolveApproval` could turn another
 * principal's agent into a machine for running whatever they wrote.
 *
 * So an editor must hold what making the call themselves would need:
 * `tools:CallTool` on the tool, and for a `builtin` proposal the action's own
 * IAM action as well — that dispatch re-checks the action against whoever's
 * credential is on the request, which here is the proposer's, so nothing else
 * on this path asks whether the approver could have performed it.
 *
 * The tool row is consulted only for the second half; `tools:CallTool` is
 * answered from the proposal alone, so a proposal naming a tool that has since
 * been deleted is still bounded.
 */
const assertMayEditProposedAction = async (args: {
  authUser: AuthUser;
  approval: {
    project_id?: string | null;
    proposed_action?: WireProposedAction;
  };
}): Promise<void> => {
  const proposed = args.approval.proposed_action;
  const projectPublicId = args.approval.project_id;
  if (!proposed?.tool_id || !projectPublicId) return;

  const refuse = () => {
    throw new DomainError(
      'FORBIDDEN',
      'Editing the proposed arguments requires permission to make the call yourself; approving it as proposed does not.'
    );
  };

  const mayCall = await args.authUser.isAllowed({
    projectPublicId,
    action: 'tools:CallTool',
    resource: buildSrn({
      projectPublicId,
      resourceType: 'tool',
      resourceId: proposed.tool_id,
    }),
  });
  if (!mayCall) refuse();

  const iamAction = await proposedBuiltinIamAction({
    projectPublicId,
    proposed,
  });
  if (!iamAction) return;

  const mayAct = await args.authUser.isAllowed({
    projectPublicId,
    action: iamAction,
    // The edit names its own target inside the arguments, so what is asked is
    // whether the approver may perform this action anywhere in the project. A
    // narrower grant cannot be shown to cover the edited target, and is
    // refused rather than assumed.
    resource: buildSrn({
      projectPublicId,
      resourceType: '*',
      resourceId: '*',
    }),
  });
  if (!mayAct) refuse();
};

approvalsRouter.get('/approvals', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'approvals:ListApprovals',
    resourceType: 'approval',
  });

  const expiresBeforeRaw = ctx.query.expires_before as string | undefined;

  ctx.body = await listApprovals({
    projectIds: projectIds ?? [],
    status: ctx.query.status as string | undefined,
    origin: ctx.query.origin as string | undefined,
    expiresBefore: expiresBeforeRaw ? new Date(expiresBeforeRaw) : undefined,
    ...parsePagination(ctx),
  });
});

// Registered before `/approvals/:approval_id` so the static `recurrences`
// segment matches this handler rather than binding as an `:approval_id` value.
approvalsRouter.get('/approvals/recurrences', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'approvals:ListApprovalRecurrences',
    resourceType: 'approval',
  });

  const minCountRaw = ctx.query.min_count as string | undefined;
  const minCount =
    minCountRaw != null ? Number.parseInt(minCountRaw, 10) : undefined;

  ctx.body = await listApprovalRecurrences({
    projectIds: projectIds ?? [],
    status: ctx.query.status as string | undefined,
    minCount: Number.isFinite(minCount) ? minCount : undefined,
    ...parsePagination(ctx),
  });
});

approvalsRouter.get('/approvals/:approval_id', async (ctx: Context) => {
  requireAuth(ctx);

  const approval = await getApproval({ id: ctx.params.approval_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: approval.project_id!,
    action: 'approvals:GetApproval',
    resource: approvalSrn(approval),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  ctx.body = approval;
});

approvalsRouter.post(
  '/approvals/:approval_id/approve',
  async (ctx: Context) => {
    requireAuth(ctx);

    const approval = await getApproval({ id: ctx.params.approval_id });

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: approval.project_id!,
      action: 'approvals:ResolveApproval',
      resource: approvalSrn(approval),
    });
    if (!allowed) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    const body = ctx.request.body as { arguments?: object };

    if (body.arguments != null) {
      await assertMayEditProposedAction({
        authUser: ctx.authUser,
        approval,
      });
    }

    const { item } = await approveApproval({
      id: ctx.params.approval_id,
      editedArguments: body.arguments ?? null,
      resolvedByUserId: ctx.authUser.id,
    });

    ctx.body = item;
  }
);

approvalsRouter.post('/approvals/:approval_id/reject', async (ctx: Context) => {
  requireAuth(ctx);

  const approval = await getApproval({ id: ctx.params.approval_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: approval.project_id!,
    action: 'approvals:ResolveApproval',
    resource: approvalSrn(approval),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  // `reason` is guaranteed present by the strict-field middleware (required in
  // the OpenAPI request schema); the lib re-checks for a non-empty value.
  const body = ctx.request.body as { reason: string };

  const { item } = await rejectApproval({
    id: ctx.params.approval_id,
    reason: body.reason,
    resolvedByUserId: ctx.authUser.id,
  });

  ctx.body = item;
});

export { approvalsRouter };
