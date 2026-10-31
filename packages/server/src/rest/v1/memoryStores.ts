import type {
  MemoryAssertionMechanism,
  MemoryAssertionOutcome,
} from '@soat/postgresdb';
import {
  MEMORY_ASSERTION_MECHANISMS,
  MEMORY_ASSERTION_OUTCOMES,
} from '@soat/postgresdb';
import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  findThresholdOrderError,
  resolveMemoryThresholds,
} from 'src/lib/memories';
import { listMemoryStoreAssertions } from 'src/lib/memoryAssertions';
import {
  createMemoryStore,
  deleteMemoryStore,
  findMemoryStoreDedupPolicy,
  getMemoryStoreTags,
  listMemoryStores,
  updateMemoryStore,
  updateMemoryStoreTags,
} from 'src/lib/memoryStores';
import {
  assertNoSystemTagKeys,
  readNullableTagBag,
  readTagBag,
  readTagQuery,
} from 'src/lib/tags';

import {
  type AuthenticatedContext,
  parseDateQuery,
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';
import { requireMemoryStore } from './memoryStoreAccess';
import { compileReadPolicy } from './readPolicy';
import { registerTagRoutes, type TagAccess } from './tagRoutes';

const memoryStoresRouter = new Router<Context>();

/**
 * A threshold a caller sent, or `undefined` when the field is absent. `null`
 * survives as `null`, which clears a store's override back to the algorithm
 * constant — a different request from not mentioning the field.
 */
const readThreshold = (args: {
  value: unknown;
  field: string;
}): number | null | undefined => {
  if (args.value === undefined) return undefined;
  if (args.value === null) return null;
  if (
    typeof args.value !== 'number' ||
    !Number.isFinite(args.value) ||
    args.value < 0 ||
    args.value > 1
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${args.field} must be a number between 0 and 1`
    );
  }
  return args.value;
};

/**
 * Rejects a pair that would make one of the three write outcomes unreachable.
 * On an update the check runs against the stored values the request does not
 * replace, so a one-field update cannot invert the pair from the side.
 */
const assertStoreThresholdOrder = (args: {
  current?: {
    duplicateThreshold: number | null;
    supersedeThreshold: number | null;
  } | null;
  duplicateThreshold?: number | null;
  supersedeThreshold?: number | null;
}): void => {
  const pick = (
    incoming: number | null | undefined,
    stored: number | null | undefined
  ): number | undefined => {
    if (incoming === undefined) return stored ?? undefined;
    return incoming ?? undefined;
  };

  const error = findThresholdOrderError(
    resolveMemoryThresholds({
      duplicateThreshold: pick(
        args.duplicateThreshold,
        args.current?.duplicateThreshold
      ),
      supersedeThreshold: pick(
        args.supersedeThreshold,
        args.current?.supersedeThreshold
      ),
    })
  );
  if (error) {
    throw new DomainError('VALIDATION_FAILED', error);
  }
};

const readEnum = <T extends string>(args: {
  value: unknown;
  allowed: readonly T[];
  field: string;
}): T | undefined => {
  if (args.value === undefined) return undefined;
  if (!args.allowed.includes(args.value as T)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${args.field} must be one of: ${args.allowed.join(', ')}`
    );
  }
  return args.value as T;
};

memoryStoresRouter.get('/memory-stores', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;
  const tags = readTagQuery(ctx.query.tags);

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'memories:ListMemoryStores',
    resourceType: 'memory_store',
  });

  const { where: policyWhere, hasAccess } = await compileReadPolicy({
    ctx,
    projectPublicId,
    projectIds,
    action: 'memories:ListMemoryStores',
    resourceType: 'memory_store',
  });
  ctx.body = await listMemoryStores({
    // No Allow statement matches the action, so the caller reads nothing: an
    // empty scope, not an error, as on every listing.
    projectIds: hasAccess ? (projectIds ?? []) : [],
    tags,
    policyWhere,
    ...parsePagination(ctx),
  });
});

memoryStoresRouter.get(
  '/memory-stores/:memory_store_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    ctx.body = await requireMemoryStore({
      ctx,
      memoryStorePublicId: ctx.params.memory_store_id,
      action: 'memories:GetMemoryStore',
    });
  }
);

memoryStoresRouter.post('/memory-stores', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    name: string;
    description?: string;
    tags?: unknown;
    duplicate_threshold?: unknown;
    supersede_threshold?: unknown;
  };

  const tags = assertNoSystemTagKeys(readTagBag(body.tags));
  const duplicateThreshold = readThreshold({
    value: body.duplicate_threshold,
    field: 'duplicate_threshold',
  });
  const supersedeThreshold = readThreshold({
    value: body.supersede_threshold,
    field: 'supersede_threshold',
  });
  assertStoreThresholdOrder({ duplicateThreshold, supersedeThreshold });

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'memories:CreateMemoryStore',
    resourceType: 'memory_store',
  });
  const memoryStore = await createMemoryStore({
    projectId: Number(targetProjectId),
    name: body.name,
    description: body.description,
    tags,
    duplicateThreshold,
    supersedeThreshold,
  });

  ctx.status = 201;
  ctx.body = memoryStore;
});

memoryStoresRouter.put(
  '/memory-stores/:memory_store_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    await requireMemoryStore({
      ctx,
      memoryStorePublicId: ctx.params.memory_store_id,
      action: 'memories:UpdateMemoryStore',
    });

    const body = ctx.request.body as {
      name?: string;
      description?: string | null;
      tags?: unknown;
      duplicate_threshold?: unknown;
      supersede_threshold?: unknown;
    };

    const duplicateThreshold = readThreshold({
      value: body.duplicate_threshold,
      field: 'duplicate_threshold',
    });
    const supersedeThreshold = readThreshold({
      value: body.supersede_threshold,
      field: 'supersede_threshold',
    });
    assertStoreThresholdOrder({
      current: await findMemoryStoreDedupPolicy({
        id: ctx.params.memory_store_id,
      }),
      duplicateThreshold,
      supersedeThreshold,
    });

    const updated = await updateMemoryStore({
      id: ctx.params.memory_store_id,
      name: body.name,
      description: body.description,
      tags: assertNoSystemTagKeys(readNullableTagBag(body.tags)),
      duplicateThreshold,
      supersedeThreshold,
    });

    ctx.body = updated;
  }
);

/**
 * @openapi
 * GET /api/v1/memory-stores/{memory_store_id}/assertions
 * operationId: listMemoryStoreAssertions
 * Returns the store's write ledger, newest first: one row per write attempt,
 * skips included, filterable by door, outcome, generation and time. This is
 * how "which write path is filling this store?" is asked.
 */
memoryStoresRouter.get(
  '/memory-stores/:memory_store_id/assertions',
  async (ctx: Context) => {
    requireAuth(ctx);

    await requireMemoryStore({
      ctx,
      memoryStorePublicId: ctx.params.memory_store_id,
      action: 'memories:ListMemoryAssertions',
    });

    const store = await findMemoryStoreDedupPolicy({
      id: ctx.params.memory_store_id,
    });

    ctx.body = await listMemoryStoreAssertions({
      memoryStoreId: store!.id,
      mechanism: readEnum<MemoryAssertionMechanism>({
        value: ctx.query.mechanism,
        allowed: MEMORY_ASSERTION_MECHANISMS,
        field: 'mechanism',
      }),
      outcome: readEnum<MemoryAssertionOutcome>({
        value: ctx.query.outcome,
        allowed: MEMORY_ASSERTION_OUTCOMES,
        field: 'outcome',
      }),
      generationId: ctx.query.generation_id as string | undefined,
      from: parseDateQuery({ ctx, name: 'from' }),
      to: parseDateQuery({ ctx, name: 'to' }),
      ...parsePagination(ctx),
    });
  }
);

const resolveMemoryStore = async (args: {
  ctx: AuthenticatedContext;
  access: TagAccess;
}) => {
  return requireMemoryStore({
    ctx: args.ctx,
    memoryStorePublicId: args.ctx.params.memory_store_id,
    action:
      args.access === 'read'
        ? 'memories:GetMemoryStore'
        : 'memories:UpdateMemoryStore',
  });
};

registerTagRoutes({
  router: memoryStoresRouter,
  path: '/memory-stores/:memory_store_id/tags',
  resolve: resolveMemoryStore,
  readTags: ({ resource }) => {
    return getMemoryStoreTags({ id: resource.id });
  },
  writeTags: ({ resource, tags, merge }) => {
    return updateMemoryStoreTags({ id: resource.id, tags, merge });
  },
});

memoryStoresRouter.delete(
  '/memory-stores/:memory_store_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    await requireMemoryStore({
      ctx,
      memoryStorePublicId: ctx.params.memory_store_id,
      action: 'memories:DeleteMemoryStore',
    });

    await deleteMemoryStore({ id: ctx.params.memory_store_id });

    ctx.status = 204;
  }
);

export { memoryStoresRouter };
