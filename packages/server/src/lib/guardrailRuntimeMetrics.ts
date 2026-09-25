import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { enforceableCostUsd } from './costEnforceability';
import type {
  RuntimeMetric,
  RuntimeModule,
  RuntimeWindow,
} from './guardrailRuntimeCatalog';
import { sumEventTokens } from './usageThresholds';
import { TOOL_EXECUTION_METER_TYPE } from './usageToolRecording';

type EventWhere = Record<string | symbol, unknown>;

const WINDOW_MS: Record<Exclude<RuntimeWindow, 'total'>, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * The internal ids of the entities in the current call, each resolved within
 * the call's project, at most once per evaluation and only when a key reads
 * it. `null` when the call has
 * no such entity — a tool node has no agent, a direct call no run — which
 * leaves every key of that module unresolved.
 */
export type RuntimeEntities = {
  projectId: number;
  guardrailId: () => string | null;
  agentId: () => Promise<number | null>;
  toolId: () => Promise<number | null>;
  orchestrationRunId: () => Promise<number | null>;
};

const memoize = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= load();
    return cached;
  };
};

const idOf = (row: { id?: number } | null): number | null => {
  return row?.id ?? null;
};

export const runtimeEntities = (args: {
  projectId: number;
  guardrailId?: string | null;
  agentId?: string | null;
  toolId?: string | null;
  orchestrationRunId?: string | null;
}): RuntimeEntities => {
  return {
    projectId: args.projectId,
    guardrailId: () => {
      return args.guardrailId ?? null;
    },
    agentId: memoize(async () => {
      if (!args.agentId) return null;
      return idOf(
        await db.Agent.findOne({
          where: { publicId: args.agentId, projectId: args.projectId },
          attributes: ['id'],
        })
      );
    }),
    toolId: memoize(async () => {
      if (!args.toolId) return null;
      return idOf(
        await db.Tool.findOne({
          where: { publicId: args.toolId, projectId: args.projectId },
          attributes: ['id'],
        })
      );
    }),
    orchestrationRunId: memoize(async () => {
      if (!args.orchestrationRunId) return null;
      return idOf(
        await db.OrchestrationRun.findOne({
          where: {
            publicId: args.orchestrationRunId,
            projectId: args.projectId,
          },
          attributes: ['id'],
        })
      );
    }),
  };
};

// The events the module's entity owns, or `null` when the call has no such
// entity.
const moduleScope = async (args: {
  module: RuntimeModule;
  entities: RuntimeEntities;
}): Promise<EventWhere | null> => {
  const { entities } = args;
  switch (args.module) {
    case 'projects':
      return { projectId: entities.projectId };
    case 'guardrails': {
      const guardrailId = entities.guardrailId();
      return guardrailId
        ? {
            projectId: entities.projectId,
            guardrailIds: { [Op.contains]: [guardrailId] },
          }
        : null;
    }
    case 'agents': {
      const agentId = await entities.agentId();
      return agentId === null ? null : { agentId };
    }
    case 'tools': {
      const toolId = await entities.toolId();
      return toolId === null ? null : { toolId };
    }
    case 'orchestrations': {
      const orchestrationRunId = await entities.orchestrationRunId();
      return orchestrationRunId === null ? null : { orchestrationRunId };
    }
  }
};

const TOOL_ERROR_OUTCOMES = ['error', 'timeout'];

const readMetric = (args: {
  metric: RuntimeMetric;
  where: EventWhere;
}): Promise<number | null> => {
  switch (args.metric) {
    case 'tool_calls':
      return db.UsageEvent.count({
        where: { ...args.where, meterType: TOOL_EXECUTION_METER_TYPE },
      });
    case 'errors':
      return db.UsageEvent.count({
        where: {
          ...args.where,
          meterType: TOOL_EXECUTION_METER_TYPE,
          outcome: TOOL_ERROR_OUTCOMES,
        },
      });
    case 'tokens':
      return sumEventTokens({ where: args.where });
    case 'cost_usd':
      // `null` when the scope metered AI usage and priced none of it, rather
      // than a sum that understates it (`costEnforceability.ts`).
      return enforceableCostUsd({ where: args.where });
  }
};

/**
 * The value of one `runtime.<module>.<metric>.<window>` key, or `undefined`
 * when the call has no entity of that module. An empty window is a real `0`,
 * so a ceiling passes for an entity that has done nothing yet.
 */
export const resolveRuntimeMetric = async (args: {
  module: RuntimeModule;
  metric: RuntimeMetric;
  window: RuntimeWindow;
  entities: RuntimeEntities;
  now: Date;
}): Promise<number | null | undefined> => {
  const scope = await moduleScope(args);
  if (scope === null) return undefined;
  const where =
    args.window === 'total'
      ? scope
      : {
          ...scope,
          createdAt: {
            [Op.gte]: new Date(args.now.getTime() - WINDOW_MS[args.window]),
          },
        };
  return readMetric({ metric: args.metric, where });
};
