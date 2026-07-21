import { actorsFormationModule } from './formation-modules/actorsFormationModule';
import { agentsFormationModule } from './formation-modules/agentsFormationModule';
import { aiProvidersFormationModule } from './formation-modules/aiProvidersFormationModule';
import { apiKeysFormationModule } from './formation-modules/apiKeysFormationModule';
import { chatsFormationModule } from './formation-modules/chatsFormationModule';
import { conversationsFormationModule } from './formation-modules/conversationsFormationModule';
import { discussionsFormationModule } from './formation-modules/discussionsFormationModule';
import { documentsFormationModule } from './formation-modules/documentsFormationModule';
import { filesFormationModule } from './formation-modules/filesFormationModule';
import { ingestionRulesFormationModule } from './formation-modules/ingestionRulesFormationModule';
import { memoriesFormationModule } from './formation-modules/memoriesFormationModule';
import { memoryEntriesFormationModule } from './formation-modules/memoryEntriesFormationModule';
import { orchestrationsFormationModule } from './formation-modules/orchestrationsFormationModule';
import { policiesFormationModule } from './formation-modules/policiesFormationModule';
import { projectPricesFormationModule } from './formation-modules/projectPricesFormationModule';
import { quotasFormationModule } from './formation-modules/quotasFormationModule';
import { secretsFormationModule } from './formation-modules/secretsFormationModule';
import { sessionsFormationModule } from './formation-modules/sessionsFormationModule';
import { toolsFormationModule } from './formation-modules/toolsFormationModule';
import { triggersFormationModule } from './formation-modules/triggersFormationModule';
import { webhooksFormationModule } from './formation-modules/webhooksFormationModule';
import { workflowsFormationModule } from './formation-modules/workflowsFormationModule';
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
registerFormationModule({ module: discussionsFormationModule });
registerFormationModule({ module: filesFormationModule });
registerFormationModule({ module: ingestionRulesFormationModule });
registerFormationModule({ module: policiesFormationModule });
registerFormationModule({ module: projectPricesFormationModule });
registerFormationModule({ module: quotasFormationModule });
registerFormationModule({ module: secretsFormationModule });
registerFormationModule({ module: sessionsFormationModule });
registerFormationModule({ module: orchestrationsFormationModule });
registerFormationModule({ module: triggersFormationModule });
registerFormationModule({ module: workflowsFormationModule });

export const getFormationModule = (args: {
  resourceType: string;
}): FormationModule | undefined => {
  return registeredModules.get(args.resourceType);
};
