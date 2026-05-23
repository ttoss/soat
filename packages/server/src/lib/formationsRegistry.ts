import { actorsFormationModule } from './formation-modules/actorsFormationModule';
import { agentsFormationModule } from './formation-modules/agentsFormationModule';
import { agentToolsFormationModule } from './formation-modules/agentToolsFormationModule';
import { aiProvidersFormationModule } from './formation-modules/aiProvidersFormationModule';
import { apiKeysFormationModule } from './formation-modules/apiKeysFormationModule';
import { documentsFormationModule } from './formation-modules/documentsFormationModule';
import { memoriesFormationModule } from './formation-modules/memoriesFormationModule';
import { memoryEntriesFormationModule } from './formation-modules/memoryEntriesFormationModule';
import { webhooksFormationModule } from './formation-modules/webhooksFormationModule';
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
registerFormationModule({ module: agentToolsFormationModule });
registerFormationModule({ module: aiProvidersFormationModule });
registerFormationModule({ module: apiKeysFormationModule });
registerFormationModule({ module: documentsFormationModule });
registerFormationModule({ module: memoriesFormationModule });
registerFormationModule({ module: memoryEntriesFormationModule });
registerFormationModule({ module: webhooksFormationModule });

export const getFormationModule = (args: {
  resourceType: string;
}): FormationModule | undefined => {
  return registeredModules.get(args.resourceType);
};
