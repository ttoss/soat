import { actorsFormationModule } from './formation-modules/actorsFormationModule';
import { agentsFormationModule } from './formation-modules/agentsFormationModule';
import { aiProvidersFormationModule } from './formation-modules/aiProvidersFormationModule';
import { apiKeysFormationModule } from './formation-modules/apiKeysFormationModule';
import { chatsFormationModule } from './formation-modules/chatsFormationModule';
import { conversationsFormationModule } from './formation-modules/conversationsFormationModule';
import { datasetItemsFormationModule } from './formation-modules/datasetItemsFormationModule';
import { datasetsFormationModule } from './formation-modules/datasetsFormationModule';
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
import { buildRegisteredFormationModule } from './formation-modules/registeredFormationModule';
import { secretsFormationModule } from './formation-modules/secretsFormationModule';
import { sessionsFormationModule } from './formation-modules/sessionsFormationModule';
import { toolsFormationModule } from './formation-modules/toolsFormationModule';
import { triggersFormationModule } from './formation-modules/triggersFormationModule';
import { webhooksFormationModule } from './formation-modules/webhooksFormationModule';
import { workflowsFormationModule } from './formation-modules/workflowsFormationModule';
import type { FormationResourceTypeRegistration } from './formationResourceTypeConfig';
import { loadFormationResourceTypeConfig } from './formationResourceTypeConfig';
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

/**
 * The types that ship with SOAT, frozen after the registrations above.
 *
 * Distinct from `supportedResourceTypes()`, which also counts the types a
 * deployment operator registered. The two are only equal on a deployment with
 * no registration file — which is why the distinction has to be explicit: the
 * rules that are genuinely about *built-ins* (each has a
 * `*ResourceProperties` schema in `formations.yaml`; none may be shadowed by a
 * registration) would otherwise silently start asserting things about custom
 * types they cannot hold for.
 */
const BUILT_IN_RESOURCE_TYPES: ReadonlySet<string> = new Set(
  registeredModules.keys()
);

export const builtInResourceTypes = (): ReadonlySet<string> => {
  return BUILT_IN_RESOURCE_TYPES;
};

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

// ── Operator-registered resource types ────────────────────────────────────

/**
 * Adds the resource types a deployment operator declared (#1078).
 *
 * Called once, from `initFormationResourceTypes` at boot, with the contents of
 * the file `FORMATION_RESOURCE_TYPES_CONFIG` names. It is deliberately not
 * reachable from any route: the handler URL and its signing secret are
 * deployment configuration at the same trust level as the database URL, so no
 * request may add, change or redirect a type.
 *
 * A name that collides with a built-in throws, so a registration can never
 * shadow `agent` and quietly redirect it to an external handler. The parser
 * rejects the same case earlier with a message that names the file; this is the
 * backstop for any other caller.
 */
export const registerFormationResourceTypes = (args: {
  registrations: FormationResourceTypeRegistration[];
}): void => {
  for (const registration of args.registrations) {
    if (BUILT_IN_RESOURCE_TYPES.has(registration.name)) {
      throw new Error(
        `Cannot register formation resource type '${registration.name}': it is a built-in type`
      );
    }
    registerFormationModule({
      module: buildRegisteredFormationModule({ registration }),
    });
  }
};

/**
 * Removes operator-registered types again. Exists for tests, which must not
 * leak a registry mutation into another file (`.claude/rules/tests.md`); a
 * built-in is never removable.
 */
export const unregisterFormationResourceTypes = (args: {
  names: string[];
}): void => {
  for (const name of args.names) {
    if (BUILT_IN_RESOURCE_TYPES.has(name)) continue;
    registeredModules.delete(name);
  }
};

/**
 * Loads the registration file, if the deployment named one, and registers what
 * it declares. Any problem throws, which fails the boot — see
 * `formationResourceTypeConfig.ts` for why that is the right outcome.
 */
export const initFormationResourceTypes = (): void => {
  registerFormationResourceTypes({
    registrations: loadFormationResourceTypeConfig({
      builtInTypes: BUILT_IN_RESOURCE_TYPES,
      env: process.env,
    }),
  });
};
