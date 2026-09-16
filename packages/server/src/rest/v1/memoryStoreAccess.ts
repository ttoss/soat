import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import { getMemoryStore } from 'src/lib/memoryStores';
import { buildResourceTagContext } from 'src/lib/tags';

export type LoadedMemoryStore = NonNullable<
  Awaited<ReturnType<typeof getMemoryStore>>
>;

/**
 * Loads the memory store a request targets and authorizes `action` against it,
 * with the store's own tags as the condition context.
 *
 * Shared so a route cannot authorize a store without supplying that context — a
 * missing context makes every `soat:ResourceTag/<key>` condition evaluate
 * against nothing, which silently drops a `Deny`. It lives in its own module
 * because a memory **rule** is authorized here too: a rule is the store's
 * ingestion policy, so its SRN is the store's.
 */
export const requireMemoryStore = async (args: {
  ctx: Context;
  memoryStorePublicId: string;
  action: string;
}): Promise<LoadedMemoryStore> => {
  const memoryStore = await getMemoryStore({ id: args.memoryStorePublicId });
  if (!memoryStore) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory store not found');
  }

  const allowed = await args.ctx.authUser!.isAllowed({
    projectPublicId: memoryStore.project_id!,
    action: args.action,
    resource: buildSrn({
      projectPublicId: memoryStore.project_id!,
      resourceType: 'memory_store',
      resourceId: memoryStore.id,
    }),
    context: buildResourceTagContext({
      resourceType: 'memory_store',
      tags: memoryStore.tags,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  return memoryStore;
};
