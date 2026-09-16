import type { MemoryRuleEvent } from '@soat/postgresdb';
import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import {
  assertSourceAgentIds,
  resolveMemoryRuleRefs,
} from 'src/lib/memoryRuleRefs';
import {
  createMemoryRule,
  deleteMemoryRule,
  getMemoryRule,
  listMemoryRules,
  updateMemoryRule,
} from 'src/lib/memoryRules';
import { findMemoryStoreScope } from 'src/lib/memoryStores';
import { setAuditResourceHint } from 'src/middleware/audit';

import { parsePagination, requireAuth, resolveReadProjectIds } from './helpers';
import { requireMemoryStore } from './memoryStoreAccess';

const memoryRulesRouter = new Router<Context>();

type RuleBody = {
  memory_store_id?: string;
  on?: MemoryRuleEvent;
  source_agent_ids?: string[] | null;
  agent_id?: string | null;
  tool_id?: string | null;
  action?: string | null;
  preset_parameters?: Record<string, unknown> | null;
  prompt?: string | null;
  ai_provider_id?: string | null;
  model?: string | null;
  enabled?: boolean;
};

type StoreScope = { id: number; projectId: number; publicId: string };

/**
 * Authorizes `action` against the memory store and returns its internal scope.
 *
 * A rule is a store's ingestion policy, so it is governed by the store's SRN —
 * the resource `memories:UpdateMemoryStore` already names, with the store's tags
 * as the condition context. It has no SRN of its own precisely because "who may
 * change what feeds this corpus?" is a question about the corpus.
 */
const authorizeStore = async (args: {
  ctx: Context;
  memoryStorePublicId: string | undefined;
  action: string;
}): Promise<StoreScope> => {
  if (!args.memoryStorePublicId) {
    throw new DomainError('VALIDATION_FAILED', 'memory_store_id is required');
  }
  await requireMemoryStore({
    ctx: args.ctx,
    memoryStorePublicId: args.memoryStorePublicId,
    action: args.action,
  });
  const scope = await findMemoryStoreScope({ id: args.memoryStorePublicId });
  return { ...scope!, publicId: args.memoryStorePublicId };
};

/**
 * Loads the rule a request names and authorizes it through its store. The rule
 * is read unscoped first because its project *is* its store's — there is
 * nothing to scope the read by until the store is in hand, and the store's own
 * check is what converges "elsewhere" and "absent" into one refusal.
 */
const authorizeRule = async (args: {
  ctx: Context;
  ruleId: string;
  action: string;
}): Promise<StoreScope> => {
  const rule = await getMemoryRule({ id: args.ruleId });
  return authorizeStore({
    ctx: args.ctx,
    memoryStorePublicId: rule.memory_store_id,
    action: args.action,
  });
};

const resolveWriteRefs = async (args: {
  body: RuleBody;
  projectId: number;
}) => {
  await assertSourceAgentIds({
    projectId: args.projectId,
    sourceAgentIds: args.body.source_agent_ids,
  });
  return resolveMemoryRuleRefs({
    projectId: args.projectId,
    agentId: args.body.agent_id,
    toolId: args.body.tool_id,
    aiProviderId: args.body.ai_provider_id,
  });
};

const writeArgs = (body: RuleBody) => {
  return {
    on: body.on,
    sourceAgentIds: body.source_agent_ids,
    action: body.action,
    presetParameters: body.preset_parameters,
    prompt: body.prompt,
    model: body.model,
    enabled: body.enabled,
  };
};

memoryRulesRouter.get('/memory-rules', async (ctx: Context) => {
  requireAuth(ctx);

  const memoryStorePublicId = ctx.query.memory_store_id as string | undefined;

  // Scoped to one store, the store itself authorizes and the listing is a read
  // of that store's policy. Unscoped, it falls back to the project scope every
  // listing uses, where no access yields an empty page rather than an error.
  if (memoryStorePublicId) {
    const store = await authorizeStore({
      ctx,
      memoryStorePublicId,
      action: 'memories:ListMemoryRules',
    });
    ctx.body = await listMemoryRules({
      memoryStoreId: store.id,
      ...parsePagination(ctx),
    });
    return;
  }

  // Passed through, never defaulted to `[]`: `undefined` is an unrestricted
  // (admin) scope, and collapsing it into an empty array would answer an
  // empty page instead of everything.
  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId: ctx.query.project_id as string | undefined,
    action: 'memories:ListMemoryRules',
    resourceType: 'memory_store',
  });
  ctx.body = await listMemoryRules({ projectIds, ...parsePagination(ctx) });
});

memoryRulesRouter.get('/memory-rules/:memory_rule_id', async (ctx: Context) => {
  requireAuth(ctx);

  await authorizeRule({
    ctx,
    ruleId: ctx.params.memory_rule_id,
    action: 'memories:GetMemoryRule',
  });

  ctx.body = await getMemoryRule({ id: ctx.params.memory_rule_id });
});

memoryRulesRouter.post('/memory-rules', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as RuleBody;

  const store = await authorizeStore({
    ctx,
    memoryStorePublicId: body.memory_store_id,
    action: 'memories:CreateMemoryRule',
  });

  const refs = await resolveWriteRefs({ body, projectId: store.projectId });

  ctx.status = 201;
  ctx.body = await createMemoryRule({
    memoryStoreId: store.id,
    ...writeArgs(body),
    ...refs,
  });
});

memoryRulesRouter.patch(
  '/memory-rules/:memory_rule_id',
  async (ctx: Context) => {
    requireAuth(ctx);
    const body = ctx.request.body as RuleBody;

    const store = await authorizeRule({
      ctx,
      ruleId: ctx.params.memory_rule_id,
      action: 'memories:UpdateMemoryRule',
    });

    const refs = await resolveWriteRefs({ body, projectId: store.projectId });

    ctx.body = await updateMemoryRule({
      id: ctx.params.memory_rule_id,
      ...writeArgs(body),
      ...refs,
    });
  }
);

memoryRulesRouter.delete(
  '/memory-rules/:memory_rule_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    const store = await authorizeRule({
      ctx,
      ruleId: ctx.params.memory_rule_id,
      action: 'memories:DeleteMemoryRule',
    });

    // `204 No Content` leaves the audit middleware no body to backfill the
    // project and SRN from, so it is handed the resolved resource first. The
    // SRN is the store's, which is what the request was authorized against.
    const rule = await getMemoryRule({ id: ctx.params.memory_rule_id });
    if (rule.project_id) {
      setAuditResourceHint(ctx, {
        projectPublicId: rule.project_id,
        resourceSrn: buildSrn({
          projectPublicId: rule.project_id,
          resourceType: 'memory_store',
          resourceId: store.publicId,
        }),
        resourcePublicId: rule.id,
      });
    }

    await deleteMemoryRule({ id: ctx.params.memory_rule_id });
    ctx.status = 204;
  }
);

export { memoryRulesRouter };
