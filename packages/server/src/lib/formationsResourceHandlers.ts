import { normalizeDeclaredProperties } from './formationsProperties';
import { getFormationModule } from './formationsRegistry';
import type {
  FormationResourceContext,
  UpdateOutcome,
} from './formationsTypes';

// The write half of the module-dispatch seam. The pipelines already normalize
// upstream; normalizing again here is idempotent and makes the guarantee hold
// for any caller, so no module has to remember (#901).

// ── Public API ────────────────────────────────────────────────────────────

export type ApplyArgs = {
  resourceType: string;
  resolvedProperties: Record<string, unknown>;
} & FormationResourceContext;

export const applyCreateResource = async (args: ApplyArgs): Promise<string> => {
  const formationModule = getFormationModule({
    resourceType: args.resourceType,
  });
  if (!formationModule)
    throw new Error(`Unsupported resource type: ${args.resourceType}`);
  return formationModule.create({
    properties: normalizeDeclaredProperties(args.resolvedProperties),
    projectId: args.projectId,
    logicalId: args.logicalId,
    resourceKey: args.resourceKey,
  });
};

export const applyUpdateResource = async (
  args: {
    resourceType: string;
    physicalResourceId: string;
    resolvedProperties: Record<string, unknown>;
  } & FormationResourceContext
): Promise<UpdateOutcome | void> => {
  const formationModule = getFormationModule({
    resourceType: args.resourceType,
  });
  if (!formationModule)
    throw new Error(
      `Unsupported resource type for update: ${args.resourceType}`
    );
  return formationModule.update({
    physicalResourceId: args.physicalResourceId,
    properties: normalizeDeclaredProperties(args.resolvedProperties),
    projectId: args.projectId,
    logicalId: args.logicalId,
    resourceKey: args.resourceKey,
  });
};

/**
 * Asks a resource type why deleting it would refuse, before anything is deleted.
 *
 * Answers `null` — "no predictable refusal" — for an unregistered type, a type
 * that declares no blocker, and a blocker that could not be evaluated at all. A
 * resource deleted out of band is the common last case: the lookup throws
 * "not found", which is not a refusal but the delete's own already-gone path.
 *
 * Swallowing rather than propagating is the deliberate contract. The pre-flight
 * exists only to report refusals it is sure of; the delete attempt stays
 * authoritative, so a pre-flight that cannot answer must never be the thing that
 * fails a teardown which would otherwise have succeeded.
 */
export const findResourceDeletionBlocker = async (args: {
  resourceType: string;
  physicalResourceId: string;
}): Promise<string | null> => {
  const formationModule = getFormationModule({
    resourceType: args.resourceType,
  });
  if (!formationModule?.findDeletionBlocker) return null;
  try {
    return await formationModule.findDeletionBlocker({
      physicalResourceId: args.physicalResourceId,
    });
  } catch {
    return null;
  }
};

export const applyDeleteResource = async (
  args: {
    resourceType: string;
    physicalResourceId: string;
  } & FormationResourceContext
): Promise<void> => {
  const formationModule = getFormationModule({
    resourceType: args.resourceType,
  });
  if (!formationModule)
    throw new Error(
      `Unsupported resource type for delete: ${args.resourceType}`
    );
  return formationModule.delete({
    physicalResourceId: args.physicalResourceId,
    projectId: args.projectId,
    logicalId: args.logicalId,
    resourceKey: args.resourceKey,
  });
};
