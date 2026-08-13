import { actorsFormationModule } from './formation-modules/actorsFormationModule';
import { agentsFormationModule } from './formation-modules/agentsFormationModule';
import { aiProvidersFormationModule } from './formation-modules/aiProvidersFormationModule';
import { apiKeysFormationModule } from './formation-modules/apiKeysFormationModule';
import { chatsFormationModule } from './formation-modules/chatsFormationModule';
import { conversationsFormationModule } from './formation-modules/conversationsFormationModule';
import { datasetItemsFormationModule } from './formation-modules/datasetItemsFormationModule';
import { datasetsFormationModule } from './formation-modules/datasetsFormationModule';
import { discussionsFormationModule } from './formation-modules/discussionsFormationModule';
import { documentsFormationModule } from './formation-modules/documentsFormationModule';
import { evalsFormationModule } from './formation-modules/evalsFormationModule';
import { filesFormationModule } from './formation-modules/filesFormationModule';
import { guardrailsFormationModule } from './formation-modules/guardrailsFormationModule';
import { ingestionRulesFormationModule } from './formation-modules/ingestionRulesFormationModule';
import { memoriesFormationModule } from './formation-modules/memoriesFormationModule';
import { memoryEntriesFormationModule } from './formation-modules/memoryEntriesFormationModule';
import { modelRoutesFormationModule } from './formation-modules/modelRoutesFormationModule';
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
registerFormationModule({ module: modelRoutesFormationModule });
registerFormationModule({ module: webhooksFormationModule });
registerFormationModule({ module: chatsFormationModule });
registerFormationModule({ module: conversationsFormationModule });
registerFormationModule({ module: discussionsFormationModule });
registerFormationModule({ module: filesFormationModule });
registerFormationModule({ module: guardrailsFormationModule });
registerFormationModule({ module: ingestionRulesFormationModule });
registerFormationModule({ module: policiesFormationModule });
registerFormationModule({ module: projectPricesFormationModule });
registerFormationModule({ module: quotasFormationModule });
registerFormationModule({ module: secretsFormationModule });
registerFormationModule({ module: sessionsFormationModule });
registerFormationModule({ module: orchestrationsFormationModule });
registerFormationModule({ module: triggersFormationModule });
registerFormationModule({ module: datasetsFormationModule });
registerFormationModule({ module: datasetItemsFormationModule });
registerFormationModule({ module: evalsFormationModule });
registerFormationModule({ module: workflowsFormationModule });

export const getFormationModule = (args: {
  resourceType: string;
}): FormationModule | undefined => {
  return registeredModules.get(args.resourceType);
};

/**
 * The resource types a formation template may declare — derived from the
 * registry rather than restated, so registering a module is the single step
 * that makes its type reachable. A hand-written copy of this set had already
 * fallen one entry behind (#900), leaving `model_route` unusable.
 */
export const supportedResourceTypes = (): ReadonlySet<string> => {
  return new Set(registeredModules.keys());
};
