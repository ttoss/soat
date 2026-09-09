import { db } from 'src/db';

import {
  collectApplyAuthorizationRequests,
  collectAuthorizationDenials,
} from './formationsAuthorization';
import {
  buildDependencyGraph,
  buildResolvedParamsMap,
  topologicalSort,
} from './formationsHelpers';
import {
  computeOrphanedPlanChanges,
  planResourceChange,
} from './formationsPlanHelpers';
import { redactPlanChanges } from './formationsSensitive';
import type {
  FormationAuthorizer,
  FormationTemplate,
  PlanChange,
  PlanResult,
} from './formationsTypes';

export const planFormation = async (args: {
  projectId: number;
  template: FormationTemplate;
  formationId?: string;
  parameters?: Record<string, string>;
  authorize: FormationAuthorizer;
}): Promise<PlanResult> => {
  const graph = buildDependencyGraph(args.template);
  const sortedOrder = topologicalSort(graph) ?? [];

  const existingMap = new Map<string, string>();
  const lastAppliedMap = new Map<string, Record<string, unknown> | null>();
  let existingResources: InstanceType<(typeof db)['FormationResource']>[] = [];
  if (args.formationId) {
    const formation = await db.Formation.findOne({
      where: { publicId: args.formationId },
    });
    if (formation) {
      existingResources = await db.FormationResource.findAll({
        where: {
          formationId: formation.id as number,
        },
      });
      for (const r of existingResources) {
        if (r.physicalResourceId)
          existingMap.set(r.logicalId, r.physicalResourceId);
        lastAppliedMap.set(
          r.logicalId,
          r.lastAppliedProperties as Record<string, unknown> | null
        );
      }
    }
  }

  const resolvedParams = buildResolvedParamsMap(args.template, args.parameters);
  const templateResourceKeys = new Set(Object.keys(args.template.resources));

  const changes: PlanChange[] = await Promise.all(
    sortedOrder.map((logicalId) => {
      return planResourceChange({
        logicalId,
        decl: args.template.resources[logicalId],
        physicalResourceId: existingMap.get(logicalId),
        projectId: args.projectId,
        resolvedParams,
        existingMap,
        templateResourceKeys,
        lastAppliedProperties: lastAppliedMap.get(logicalId),
      });
    })
  );

  // Surface resources the ledger still tracks but the new template no longer
  // declares — they are about to be orphaned/deleted on `update-formation` —
  // so `plan` and `update` agree on the same set of changes.
  const orphanedChanges = computeOrphanedPlanChanges({
    templateResourceKeys,
    existingResources,
  });

  // A plan is read-only, so it *reports* what an apply would refuse rather than
  // becoming a refusal itself (#1181) — naming every action at once beats an
  // apply that fails at resource seven and rolls the rest back.
  const unauthorizedActions = await collectAuthorizationDenials({
    authorize: args.authorize,
    requests: collectApplyAuthorizationRequests({
      template: args.template,
      existingResources,
    }),
  });

  // Omitted rather than empty, so a plan a caller may fully apply is byte
  // identical to what it was before this field existed.
  return {
    changes: redactPlanChanges({ changes: [...changes, ...orphanedChanges] }),
    ...(unauthorizedActions.length > 0 ? { unauthorizedActions } : {}),
  };
};
