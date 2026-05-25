import { actorsFormationModule } from './formation-modules/actorsFormationModule';
import { agentsFormationModule } from './formation-modules/agentsFormationModule';
import { toolsFormationModule } from './formation-modules/toolsFormationModule';
import { aiProvidersFormationModule } from './formation-modules/aiProvidersFormationModule';
import { apiKeysFormationModule } from './formation-modules/apiKeysFormationModule';
import { chatsFormationModule } from './formation-modules/chatsFormationModule';
import { conversationsFormationModule } from './formation-modules/conversationsFormationModule';
import { documentsFormationModule } from './formation-modules/documentsFormationModule';
import { filesFormationModule } from './formation-modules/filesFormationModule';
import { memoriesFormationModule } from './formation-modules/memoriesFormationModule';
import { memoryEntriesFormationModule } from './formation-modules/memoryEntriesFormationModule';
import { policiesFormationModule } from './formation-modules/policiesFormationModule';
import { secretsFormationModule } from './formation-modules/secretsFormationModule';
import { sessionsFormationModule } from './formation-modules/sessionsFormationModule';
import { webhooksFormationModule } from './formation-modules/webhooksFormationModule';
import type { FormationModule } from './formationsTypes';

const registeredModules = new Map<string, FormationModule>();

const registerFormationModule = (args: { module: FormationModule }): void => {
  const existing = registeredModules.get(args.module.resourceType);
  /* istanbul ignore next */
  if (existing) {
    throw new Error(
      `Duplicate formation module registration for resource type: ${args.module.resourceType}`
    );
  }
  registeredModules.set(args.module.resourceType, args.module);
};

registerFormationModule({ module: actorsFormationModule });
registerFormationModule({ module: agentsFormationModule });
registerFormationModule({ module: toolsFormationModule });
registerFormationModule({ module: aiProvidersFormationModule });
registerFormationModule({ module: apiKeysFormationModule });
registerFormationModule({ module: documentsFormationModule });
registerFormationModule({ module: memoriesFormationModule });
registerFormationModule({ module: memoryEntriesFormationModule });
registerFormationModule({ module: webhooksFormationModule });
registerFormationModule({ module: chatsFormationModule });
registerFormationModule({ module: conversationsFormationModule });
registerFormationModule({ module: filesFormationModule });
registerFormationModule({ module: policiesFormationModule });
registerFormationModule({ module: secretsFormationModule });
registerFormationModule({ module: sessionsFormationModule });

export const getFormationModule = (args: {
  resourceType: string;
}): FormationModule | undefined => {
  return registeredModules.get(args.resourceType);
};
