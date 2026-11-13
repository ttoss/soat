import type { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { isPlainObject } from 'src/lib/plainObject';
import { assertNoSystemTagKeys, isStringRecord } from 'src/lib/tags';

import { type AuthenticatedContext, requireAuth } from './helpers';

export type TagAccess = 'read' | 'write';

/**
 * States the tags a write carries before its route authorizes it, so a policy
 * condition on `iam:RequestTag/<key>` reads them. Every route that writes
 * caller tags calls it ahead of its permission check
 * (`tests/harness/requestTagDeclaration.test.mjs`). A bag that is not a string
 * record declares nothing: the route's own validation still refuses it, after
 * authorization as before.
 */
export const declareRequestTags = (args: {
  ctx: Context;
  tags: unknown;
}): void => {
  if (!isStringRecord(args.tags)) return;
  args.ctx.authUser?.declareRequestTags(args.tags);
};

/** {@link declareRequestTags} for a write whose body carries `tags`. */
export const declareBodyTags = (ctx: Context): void => {
  const body: unknown = ctx.request.body;
  declareRequestTags({
    ctx,
    tags: isPlainObject(body) ? body.tags : undefined,
  });
};

/**
 * Mounts the tag sub-resource of one tagged resource: `GET` reads the bag,
 * `PUT` replaces it, `PATCH` merges into it.
 *
 * Authorization stays with the module. `resolve` loads the resource for the
 * requested access and throws `RESOURCE_NOT_FOUND` / `FORBIDDEN` itself, so
 * files keep authorizing by path SRN, sessions by agent, documents through
 * their permission helper. What every tagged resource shares lives here: the
 * body must be a flat bag of string values (`400` otherwise), and the response
 * is the resulting bag, never the resource.
 */
export const registerTagRoutes = <TResource>(args: {
  router: Router<Context>;
  path: `/${string}/:${string}/tags`;
  resolve: (args: {
    ctx: AuthenticatedContext;
    access: TagAccess;
  }) => Promise<TResource>;
  readTags: (args: {
    resource: TResource;
  }) => Promise<Record<string, string> | null>;
  writeTags: (args: {
    resource: TResource;
    tags: Record<string, string>;
    merge: boolean;
  }) => Promise<Record<string, string> | null>;
}): void => {
  args.router.get(args.path, async (ctx: Context) => {
    requireAuth(ctx);
    const resource = await args.resolve({ ctx, access: 'read' });
    ctx.body = await args.readTags({ resource });
  });

  const write = (merge: boolean) => {
    return async (ctx: Context) => {
      requireAuth(ctx);
      // The body parser hands an empty body over as `{}`, so the whole body
      // is the bag; `String(["a","b"])` is "a,b", hence no coercion.
      const body: unknown = ctx.request.body;
      declareRequestTags({ ctx, tags: body });
      const resource = await args.resolve({ ctx, access: 'write' });
      if (!isStringRecord(body)) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'tags must be an object of string values'
        );
      }
      ctx.body = await args.writeTags({
        resource,
        tags: assertNoSystemTagKeys(body),
        merge,
      });
    };
  };

  args.router.put(args.path, write(false));
  args.router.patch(args.path, write(true));
};
