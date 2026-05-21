import { actorsFormationModule } from './formation-modules/actorsFormationModule';
import { agentsFormationModule } from './formation-modules/agentsFormationModule';
import type { FormationModule } from './formationsTypes';

const registeredModules = new Map<string, FormationModule>();

const registerFormationModule = (args: { module: FormationModule }): void => {
  const existing = registeredModules.get(args.module.resourceType);
  if (existing) {
    throw new Error(
      `Duplicate formation module registration for resource type: ${args.module.resourceType}`
    );
  }
  registeredModules.set(args.module.resourceType, args.module);
};

registerFormationModule({ module: actorsFormationModule });
registerFormationModule({ module: agentsFormationModule });

export const getFormationModule = (args: {
  resourceType: string;
}): FormationModule | undefined => {
  return registeredModules.get(args.resourceType);
};
