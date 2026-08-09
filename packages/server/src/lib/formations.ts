import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';
import {
  paginatedList,
  type PaginatedResult,
  resolvePagination,
} from 'src/lib/pagination';

import { DomainError } from '../errors';
import {
  applyFormationTemplate,
  buildDeleteOrder,
  performResourceDeletions,
} from './formationsApply';
import {
  buildDependencyGraph,
  buildResolvedParamsMap,
  topologicalSort,
} from './formationsHelpers';
import {
  computeOrphanedPlanChanges,
  planResourceChange,
} from './formationsPlanHelpers';
import {
  type FormationEvent,
  formationEventToWire,
  type FormationTemplate,
  type MappedFormation,
  type MappedFormationOperation,
  type MappedFormationResource,
  type PlanChange,
  type PlanResult,
  planResultToWire,
} from './formationsTypes';
import type { ResourceIncludes } from './modelIncludes';
import { makeResourceAccessor } from './resourceAccessor';

const log = createDebug('soat:formations');

export { getMissingParams } from './formationsHelpers';
export { detectStaticMetadataViolations } from './formationsMetadata';
export type {
  FormationEvent,
  FormationTemplate,
  MappedFormation,
  MappedFormationOperation,
  MappedFormationResource,
  PlanChange,
  PlanResult,
} from './formationsTypes';
export { planResultToWire } from './formationsTypes';
export {
  parseFormationTemplateInput,
  validateFormationTemplate,
} from './formationsValidation';

// ── Mapping ───────────────────────────────────────────────────────────────

type FormationRow = InstanceType<(typeof db)['Formation']> & {
  project?: InstanceType<(typeof db)['Project']>;
  formationResources?: InstanceType<(typeof db)['FormationResource']>[];
};

const mapFormation = (
  instance: FormationRow,
  includeResources = false
): MappedFormation => {
  const resources: MappedFormationResource[] | undefined = includeResources
    ? (instance.formationResources ?? []).map((r) => {
        return {
          id: r.publicId,
          logical_id: r.logicalId,
          resource_type: r.resourceType,
          physical_resource_id: r.physicalResourceId,
          status: r.status,
        };
      })
    : undefined;

  return {
    id: instance.publicId,
    project_id: instance.project?.publicId ?? '',
    name: instance.name,
    template: instance.template as FormationTemplate | null,
    outputs: instance.outputs,
    status: instance.status,
    metadata: instance.metadata,
    resolved_metadata: instance.resolvedMetadata,
    resolved_parameters: instance.resolvedParameters,
    ...(resources !== undefined ? { resources } : {}),
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

const getFormationIncludes = (includeResources = false): ResourceIncludes => {
  const includes: ResourceIncludes = [{ model: db.Project, as: 'project' }];
  if (includeResources) {
    includes.push({
      model: db.FormationResource,
      as: 'formationResources',
    });
  }
  return includes;
};

/**
 * Every single-formation read wants the resources joined, so the accessor
 * pins that shape; the list query keeps the lighter one.
 */
const formations = makeResourceAccessor<FormationRow>({
  model: () => {
    return db.Formation;
  },
  includes: () => {
    return getFormationIncludes(true);
  },
  label: 'Formation',
});

/** A deleted formation reads as absent on every single-formation lookup. */
const NOT_DELETED = { status: { [Op.ne]: 'deleted' } };

// ── Public API ────────────────────────────────────────────────────────────

export const planFormation = async (args: {
  projectId: number;
  template: FormationTemplate;
  formationId?: string;
  parameters?: Record<string, string>;
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

  return { changes: [...changes, ...orphanedChanges] };
};

export const createFormation = async (args: {
  projectId: number;
  name: string;
  template: FormationTemplate;
  metadata?: Record<string, unknown>;
  parameters?: Record<string, string>;
}): Promise<MappedFormation> => {
  log(
    'createFormation: projectId=%d name=%s resources=%d',
    args.projectId,
    args.name,
    Object.keys(args.template.resources).length
  );
  const existing = await db.Formation.findOne({
    where: {
      projectId: args.projectId,
      name: args.name,
      status: { [Op.ne]: 'deleted' },
    },
  });
  if (existing) {
    log(
      'createFormation: name conflict projectId=%d name=%s',
      args.projectId,
      args.name
    );
    throw new DomainError(
      'NAME_CONFLICT',
      `A formation with the name '${args.name}' already exists.`
    );
  }

  const formation = await db.Formation.create({
    projectId: args.projectId,
    name: args.name,
    template: args.template,
    outputs: null,
    status: 'creating',
    metadata: args.metadata ?? null,
  });

  log(
    'createFormation: created formation formationId=%s status=%s',
    formation.publicId,
    formation.status
  );

  const operation = await db.FormationOperation.create({
    formationId: formation.id as number,
    operationType: 'create',
    status: 'running',
    events: null,
    plan: null,
    error: null,
  });

  log(
    'createFormation: created operation operationId=%s status=%s',
    operation.publicId,
    operation.status
  );

  await applyFormationTemplate({
    formation,
    template: args.template,
    existingResources: [],
    projectId: args.projectId,
    operation,
    parameters: args.parameters,
  });

  const refreshed = await formations.reload(formation);

  log(
    'createFormation: formation completed formationId=%s status=%s',
    formation.publicId,
    refreshed.status
  );

  return mapFormation(refreshed, true);
};

export const listFormations = async (args: {
  projectIds: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedFormation>> => {
  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Formation.findAndCountAll({
        where: { projectId: args.projectIds, status: { [Op.ne]: 'deleted' } },
        include: getFormationIncludes(),
        order: [['createdAt', 'ASC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (f) => {
      return mapFormation(f as FormationRow);
    },
  });
};

export const getFormation = async (args: {
  id: string;
}): Promise<MappedFormation> => {
  const formation = await formations.getByPublicId({
    id: args.id,
    where: NOT_DELETED,
  });
  return mapFormation(formation, true);
};

export const updateFormation = async (args: {
  id: string;
  template?: FormationTemplate;
  metadata?: Record<string, unknown> | null;
  parameters?: Record<string, string>;
}): Promise<MappedFormation> => {
  log(
    'updateFormation: formationId=%s updateTemplate=%s',
    args.id,
    !!args.template
  );
  const formation = await db.Formation.findOne({
    where: { publicId: args.id, status: { [Op.ne]: 'deleted' } },
  });
  if (!formation) {
    log('updateFormation: formation not found formationId=%s', args.id);
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Formation '${args.id}' not found.`
    );
  }

  const newTemplate =
    args.template ?? (formation.template as FormationTemplate);

  const operation = await db.FormationOperation.create({
    formationId: formation.id as number,
    operationType: 'update',
    status: 'running',
    events: null,
    plan: null,
    error: null,
  });

  log('updateFormation: created operation operationId=%s', operation.publicId);

  await formation.update({ status: 'updating' });
  if (args.metadata !== undefined) {
    await formation.update({ metadata: args.metadata });
  }

  const existingResources = await db.FormationResource.findAll({
    where: { formationId: formation.id as number },
  });

  await applyFormationTemplate({
    formation,
    template: newTemplate,
    existingResources,
    projectId: formation.projectId,
    operation,
    parameters: args.parameters,
  });

  const refreshed = await formations.reload(formation);

  return mapFormation(refreshed, true);
};

export const deleteFormation = async (args: {
  id: string;
}): Promise<{ success: boolean }> => {
  const formation = await db.Formation.findOne({
    where: { publicId: args.id, status: { [Op.ne]: 'deleted' } },
  });
  if (!formation)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Formation '${args.id}' not found.`
    );

  await formation.update({ status: 'deleting' });

  const operation = await db.FormationOperation.create({
    formationId: formation.id as number,
    operationType: 'delete',
    status: 'running',
    events: null,
    plan: null,
    error: null,
  });

  const existingResources = await db.FormationResource.findAll({
    where: { formationId: formation.id as number },
  });

  const orderedResources = buildDeleteOrder(
    formation.template as FormationTemplate | null,
    existingResources
  );
  const { events, hasError } = await performResourceDeletions(orderedResources);

  if (hasError) {
    await operation.update({ status: 'failed', events });
    await formation.update({ status: 'delete_failed' });
    return { success: false };
  }

  await operation.update({ status: 'succeeded', events });
  await formation.update({
    status: 'deleted',
    name: `${formation.name}__deleted__${formation.publicId}`,
  });
  return { success: true };
};

export const listFormationEvents = async (args: {
  formationId: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedFormationOperation>> => {
  const { limit, offset } = resolvePagination(args);

  const formation = await db.Formation.findOne({
    where: { publicId: args.formationId },
  });
  if (!formation) return { data: [], total: 0, limit, offset };

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: (pagination) => {
      return db.FormationOperation.findAndCountAll({
        where: { formationId: formation.id as number },
        order: [['createdAt', 'ASC']],
        limit: pagination.limit,
        offset: pagination.offset,
      });
    },
    map: (op) => {
      const events = op.events as FormationEvent[] | null;
      const plan = op.plan as PlanResult | null;
      return {
        id: op.publicId,
        operation_type: op.operationType,
        status: op.status,
        events: events ? events.map(formationEventToWire) : null,
        plan: plan ? planResultToWire(plan) : null,
        error: op.error,
        created_at: op.createdAt,
        updated_at: op.updatedAt,
      };
    },
  });
};
