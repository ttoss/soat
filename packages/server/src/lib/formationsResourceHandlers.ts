import { normalizeDeclaredProperties } from './formationsProperties';
import { getFormationModule } from './formationsRegistry';

// The write half of the module-dispatch seam (the read half is
// `runFormationModuleHooks` in `formationsValidation.ts`). The apply and plan
// pipelines already normalize upstream; normalizing again here — it is
// idempotent — is what makes the guarantee hold for any caller of these entry
// points, so no module has to remember (#901).

// ── Public API ────────────────────────────────────────────────────────────

export type ApplyArgs = {
  resourceType: string;
  resolvedProperties: Record<string, unknown>;
  projectId: number;
};

export const applyCreateResource = async (args: ApplyArgs): Promise<string> => {
  const formationModule = getFormationModule({
    resourceType: args.resourceType,
  });
  if (!formationModule)
    throw new Error(`Unsupported resource type: ${args.resourceType}`);
  return formationModule.create({
    properties: normalizeDeclaredProperties(args.resolvedProperties),
    projectId: args.projectId,
  });
};

export const applyUpdateResource = async (args: {
  resourceType: string;
  physicalResourceId: string;
  resolvedProperties: Record<string, unknown>;
}): Promise<void> => {
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
  });
};

export const applyDeleteResource = async (args: {
  resourceType: string;
  physicalResourceId: string;
}): Promise<void> => {
  const formationModule = getFormationModule({
    resourceType: args.resourceType,
  });
  if (!formationModule)
    throw new Error(
      `Unsupported resource type for delete: ${args.resourceType}`
    );
  return formationModule.delete({
    physicalResourceId: args.physicalResourceId,
  });
};
