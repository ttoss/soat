import { isDeepStrictEqual } from 'node:util';

import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import {
  applyFormationTemplate,
  buildDeleteOrder,
  performResourceDeletions,
} from './formationsApply';
import {
  buildDependencyGraph,
  buildResolvedParamsMap,
  resolveParamExpressions,
  topologicalSort,
} from './formationsHelpers';
import { getFormationModule } from './formationsRegistry';
import type {
  FormationEvent,
  FormationTemplate,
  MappedFormation,
  MappedFormationOperation,
  MappedFormationResource,
  PlanChange,
  PlanResult,
} from './formationsTypes';

const log = createDebug('soat:formations');

export { getMissingParams } from './formationsHelpers';
export type {
  FormationEvent,
  FormationTemplate,
  MappedFormation,
  MappedFormationOperation,
  MappedFormationResource,
  PlanChange,
  PlanResult,
} from './formationsTypes';
export {
  parseFormationTemplateInput,
  validateFormationTemplate,
} from './formationsValidation';

// ── Mapping ───────────────────────────────────────────────────────────────

const mapFormation = (
  instance: InstanceType<(typeof db)['Formation']> & {
    project?: InstanceType<(typeof db)['Project']>;
    formationResources?: InstanceType<(typeof db)['FormationResource']>[];
  },
  includeResources = false
): MappedFormation => {
  const resources: MappedFormationResource[] | undefined = includeResources
    ? (instance.formationResources ?? []).map((r) => {
        return {
          id: r.publicId,
          logicalId: r.logicalId,
          resourceType: r.resourceType,
          physicalResourceId: r.physicalResourceId,
          status: r.status,
        };
      })
    : undefined;

  return {
    id: instance.publicId,
    projectId: instance.project?.publicId ?? '',
    name: instance.name,
    template: instance.template as FormationTemplate | null,
    outputs: instance.outputs,
    status: instance.status,
    metadata: instance.metadata,
    ...(resources !== undefined ? { resources } : {}),
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

const getFormationIncludes = (includeResources = false) => {
  const includes: object[] = [{ model: db.Project, as: 'project' }];
  if (includeResources) {
    includes.push({
      model: db.FormationResource,
      as: 'formationResources',
    });
  }
  return includes;
};

// ── Public API ────────────────────────────────────────────────────────────

export const planFormation = async (args: {
  projectId: number;
  template: FormationTemplate;
  formationId?: string;
  parameters?: Record<string, string>;
  parametersUsePrevious?: string[];
}): Promise<PlanResult> => {
  const graph = buildDependencyGraph(args.template);
  const sortedOrder = topologicalSort(graph) ?? [];

  const existingMap = new Map<string, string>();
  if (args.formationId) {
    const formation = await db.Formation.findOne({
      where: { publicId: args.formationId },
    });
    if (formation) {
      const existingResources = await db.FormationResource.findAll({
        where: {
          formationId: (formation as unknown as { id: number }).id,
        },
      });
      for (const r of existingResources) {
        if (r.physicalResourceId)
          existingMap.set(r.logicalId, r.physicalResourceId);
      }
    }
  }

  const resolvedParams = buildResolvedParamsMap(
    args.template,
    args.parameters,
    args.parametersUsePrevious
  );

  const changes: PlanChange[] = await Promise.all(
    sortedOrder.map(async (logicalId): Promise<PlanChange> => {
      const decl = args.template.resources[logicalId];
      const physicalResourceId = existingMap.get(logicalId);

      if (!physicalResourceId) {
        return { logicalId, resourceType: decl.type, action: 'create' };
      }

      // Attempt a property-level diff using the module's read method.
      const module = getFormationModule({ resourceType: decl.type });
      if (module?.read) {
        try {
          const liveProperties = await module.read({ physicalResourceId });
          if (liveProperties !== null) {
            const resolvedProperties = resolveParamExpressions(
              decl.properties ?? {},
              resolvedParams
            ) as Record<string, unknown>;

            const needsUpdate = Object.entries(resolvedProperties).some(
              ([key, value]) => {
                // A kept ("use previous value") param resolves to undefined;
                // it never counts as a change since the stored value is reused.
                if (value === undefined) return false;
                return !isDeepStrictEqual(liveProperties[key], value);
              }
            );

            return {
              logicalId,
              resourceType: decl.type,
              physicalResourceId,
              action: needsUpdate ? 'update' : 'no-op',
            };
          }
        } catch {
          // read failed — fall through to 'update'
        }
      }

      return {
        logicalId,
        resourceType: decl.type,
        physicalResourceId,
        action: 'update',
      };
    })
  );

  return { changes };
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
    formationId: (formation as unknown as { id: number }).id,
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

  const refreshed = await db.Formation.findOne({
    where: { id: (formation as unknown as { id: number }).id },
    include: getFormationIncludes(true),
  });

  log(
    'createFormation: formation completed formationId=%s status=%s',
    formation.publicId,
    refreshed?.status
  );

  return mapFormation(
    refreshed as unknown as Parameters<typeof mapFormation>[0],
    true
  );
};

export const listFormations = async (args: {
  projectIds: number[];
}): Promise<MappedFormation[]> => {
  const formations = await db.Formation.findAll({
    where: { projectId: args.projectIds, status: { [Op.ne]: 'deleted' } },
    include: getFormationIncludes(),
    order: [['createdAt', 'ASC']],
  });
  return formations.map((f) => {
    return mapFormation(f as unknown as Parameters<typeof mapFormation>[0]);
  });
};

export const getFormation = async (args: {
  id: string;
}): Promise<MappedFormation> => {
  const formation = await db.Formation.findOne({
    where: { publicId: args.id, status: { [Op.ne]: 'deleted' } },
    include: getFormationIncludes(true),
  });
  if (!formation)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Formation '${args.id}' not found.`
    );
  return mapFormation(
    formation as unknown as Parameters<typeof mapFormation>[0],
    true
  );
};

export const updateFormation = async (args: {
  id: string;
  template?: FormationTemplate;
  metadata?: Record<string, unknown> | null;
  parameters?: Record<string, string>;
  parametersUsePrevious?: string[];
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
    formationId: (formation as unknown as { id: number }).id,
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
    where: { formationId: (formation as unknown as { id: number }).id },
  });

  await applyFormationTemplate({
    formation,
    template: newTemplate,
    existingResources,
    projectId: formation.projectId,
    operation,
    parameters: args.parameters,
    parametersUsePrevious: args.parametersUsePrevious,
  });

  const refreshed = await db.Formation.findOne({
    where: { id: (formation as unknown as { id: number }).id },
    include: getFormationIncludes(true),
  });

  return mapFormation(
    refreshed as unknown as Parameters<typeof mapFormation>[0],
    true
  );
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
    formationId: (formation as unknown as { id: number }).id,
    operationType: 'delete',
    status: 'running',
    events: null,
    plan: null,
    error: null,
  });

  const existingResources = await db.FormationResource.findAll({
    where: { formationId: (formation as unknown as { id: number }).id },
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
}): Promise<MappedFormationOperation[]> => {
  const formation = await db.Formation.findOne({
    where: { publicId: args.formationId },
  });
  if (!formation) return [];

  const operations = await db.FormationOperation.findAll({
    where: { formationId: (formation as unknown as { id: number }).id },
    order: [['createdAt', 'ASC']],
  });

  return operations.map((op) => {
    return {
      id: op.publicId,
      operationType: op.operationType,
      status: op.status,
      events: op.events as FormationEvent[] | null,
      plan: op.plan as PlanResult | null,
      error: op.error,
      createdAt: op.createdAt,
      updatedAt: op.updatedAt,
    };
  });
};
