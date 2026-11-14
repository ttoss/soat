import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { authUserOfWork } from '../middleware/auth';
import { buildSrn } from './iam';
import {
  RESOURCE_GRANT_PRINCIPALS,
  type ResourceGrantCarrier,
} from './resourceGrantCarriers';
import {
  narrowAuthority,
  resourceGrantAuthority,
  type WorkAuthority,
} from './workAuthority';
import type { CarriedAction } from './writerRule';

const log = createDebug('soat:resourceWork');

type ResourceWork = {
  carrier: ResourceGrantCarrier;
  id: string;
  projectPublicId: string;
  chain?: WorkAuthority | null;
};

const assertGrantStarts = async (
  args: ResourceWork & { starts: CarriedAction[] }
) => {
  const authUser = await authUserOfWork({
    db,
    authority: resourceGrantAuthority(args),
  });
  for (const start of args.starts) {
    const resource = buildSrn({
      projectPublicId: args.projectPublicId,
      resourceType: start.resourceType,
      resourceId: start.resourceId,
    });
    const allowed = await authUser?.isAllowed({
      projectPublicId: args.projectPublicId,
      action: start.action,
      resource,
    });
    if (allowed) continue;
    log('assertGrantStarts: %s %s refused %s', args.carrier, args.id, resource);
    throw new DomainError(
      'ACTION_NOT_HELD',
      `The ${RESOURCE_GRANT_PRINCIPALS[args.carrier]}'s policy_ids do not allow ${start.action} on ${resource}.`,
      { action: start.action, resource }
    );
  }
};

/**
 * The authority a resource's work runs under, refused before anything starts
 * unless the resource's own grant allows every one of `starts`. Work a request
 * started runs under that request's authority held to the grant, so it never
 * widens, and its starter needs only its own start action on the resource;
 * work the system started (`startedBy` null) runs under the grant alone.
 */
export const resourceWorkAuthority = async (args: {
  carrier: ResourceGrantCarrier;
  id: string;
  projectId: number;
  startedBy: WorkAuthority | null;
  chain?: WorkAuthority | null;
  starts: CarriedAction[];
}): Promise<WorkAuthority> => {
  log('resourceWorkAuthority: %s %s', args.carrier, args.id);
  const project = await db.Project.findByPk(args.projectId, {
    attributes: ['publicId'],
    rejectOnEmpty: true,
  });
  const work = { ...args, projectPublicId: project.publicId as string };
  if (args.starts.length > 0) await assertGrantStarts(work);
  if (!args.startedBy) return resourceGrantAuthority(work);
  return narrowAuthority({
    authority: args.startedBy,
    by: { grant: resourceGrantAuthority(work).grant, caps: [] },
  });
};
