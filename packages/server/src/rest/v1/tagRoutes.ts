import type { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { readTagBag } from 'src/lib/tags';

import { type AuthenticatedContext, requireAuth } from './helpers';

export type TagAccess = 'read' | 'write';

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
  // `resolve` has already found the resource; a null here means it vanished
  // between the two reads.
  const requireBag = (bag: Record<string, string> | null) => {
    if (bag === null) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Resource not found');
    }
    return bag;
  };

  args.router.get(args.path, async (ctx: Context) => {
    requireAuth(ctx);
    const resource = await args.resolve({ ctx, access: 'read' });
    ctx.body = requireBag(await args.readTags({ resource }));
  });

  const write = (merge: boolean) => {
    return async (ctx: Context) => {
      requireAuth(ctx);
      const resource = await args.resolve({ ctx, access: 'write' });
      const tags = readTagBag(ctx.request.body) ?? {};
      ctx.body = requireBag(await args.writeTags({ resource, tags, merge }));
    };
  };

  args.router.put(args.path, write(false));
  args.router.patch(args.path, write(true));
};
