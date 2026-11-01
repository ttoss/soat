import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { jsonbFn } from './jsonbQuery';
import { parseActiveRelease } from './releaseAssignment';

type Where = ReturnType<typeof db.sequelize.where>;
export type Condition = Where | Record<string, unknown>;

type Json = ReturnType<typeof db.sequelize.col> | ReturnType<typeof jsonbFn>;

// A public id is only ever stored as a JSON string, so its quoted form found in
// the JSON's text is the id itself and never a prefix of another.
const textNames = (values: Json[], ids: string[]): Condition[] => {
  return values.flatMap((value) => {
    return ids.map((id) => {
      return db.sequelize.where(
        db.sequelize.fn(
          'strpos',
          db.sequelize.cast(value, 'text'),
          JSON.stringify(id)
        ),
        Op.gt,
        0
      );
    });
  });
};

export const jsonNames = (columns: string[], ids: string[]): Condition[] => {
  return textNames(
    columns.map((column) => {
      return db.sequelize.col(column);
    }),
    ids
  );
};

/** Where an archived `config` names an id under one of `keys`. */
const configNames = (keys: string[], ids: string[]): Condition[] => {
  return textNames(
    keys.map((key) => {
      return jsonbFn({
        fn: 'extract_path',
        source: { column: 'config' },
        params: [key],
      });
    }),
    ids
  );
};

// The agent's columns and its archived config's keys share these names.
export const AGENT_NAMING_FIELDS = [
  'tool_bindings',
  'active_tool_ids',
  'step_rules',
  'guardrail_ids',
];

/**
 * Agents whose release serves an archived version naming an id: while a
 * release is set, generations run those versions, never the live row.
 */
export const servedAgentRowIds = async (args: {
  projectId: number;
  ids: string[];
}): Promise<number[]> => {
  const released = await db.Agent.findAll({
    where: { projectId: args.projectId, activeRelease: { [Op.ne]: null } },
    attributes: ['id', 'activeRelease'],
  });
  const served = released.flatMap((agent) => {
    const release = parseActiveRelease(agent.activeRelease);
    if (!release) return [];
    return [
      {
        agentId: agent.id,
        version: [release.stable_version, release.canary_version],
      },
    ];
  });
  if (served.length === 0) return [];
  const versions = await db.AgentVersion.findAll({
    where: {
      [Op.and]: [
        { [Op.or]: served },
        { [Op.or]: configNames(AGENT_NAMING_FIELDS, args.ids) },
      ],
    },
    attributes: ['agentId'],
  });
  return versions.map((version) => {
    return version.agentId;
  });
};

type Pin = { resourceId: number; version: number };

type VersionWhere = {
  [Op.and]: [{ [Op.or]: Record<string, number>[] }, { [Op.or]: Condition[] }];
};

/**
 * A resource whose live work runs on the version it is pinned to, never the
 * live row: where the pins are read, and where that version names an id.
 */
type PinSource = {
  pins: (projectId: number) => Promise<Pin[]>;
  foreignKey: string;
  configKeys: string[];
  versionsOf: (where: VersionWhere) => Promise<number[]>;
};

const pinsOf = <T>(
  rows: T[],
  pin: (row: T) => { resourceId: number; version: number | null }
): Pin[] => {
  return rows.flatMap((row) => {
    const { resourceId, version } = pin(row);
    return version === null ? [] : [{ resourceId, version }];
  });
};

const PIN_SOURCES = {
  /** An open task transitions on its pinned version's machine. */
  workflow: {
    pins: async (projectId) => {
      const rows = await db.Task.findAll({
        where: {
          projectId,
          status: 'open',
          workflowVersion: { [Op.ne]: null },
        },
        attributes: ['workflowId', 'workflowVersion'],
        group: ['workflowId', 'workflowVersion'],
      });
      return pinsOf(rows, (row) => {
        return { resourceId: row.workflowId, version: row.workflowVersion };
      });
    },
    foreignKey: 'workflowId',
    configKeys: ['states'],
    versionsOf: async (where) => {
      const rows = await db.WorkflowVersion.findAll({
        where,
        attributes: ['workflowId'],
      });
      return rows.map((row) => {
        return row.workflowId;
      });
    },
  },
  /** An unfinished run executes its pinned version's graph. */
  orchestration: {
    pins: async (projectId) => {
      const rows = await db.OrchestrationRun.findAll({
        where: {
          projectId,
          status: ['queued', 'running', 'sleeping', 'awaiting_input'],
          orchestrationVersion: { [Op.ne]: null },
        },
        attributes: ['orchestrationId', 'orchestrationVersion'],
        group: ['orchestrationId', 'orchestrationVersion'],
      });
      return pinsOf(rows, (row) => {
        return {
          resourceId: row.orchestrationId,
          version: row.orchestrationVersion,
        };
      });
    },
    foreignKey: 'orchestrationId',
    configKeys: ['nodes'],
    versionsOf: async (where) => {
      const rows = await db.OrchestrationVersion.findAll({
        where,
        attributes: ['orchestrationId'],
      });
      return rows.map((row) => {
        return row.orchestrationId;
      });
    },
  },
  /** A case has no end: every later execution runs its pinned definition. */
  playbook: {
    pins: async (projectId) => {
      const rows = await db.PlaybookCase.findAll({
        where: { projectId },
        attributes: ['playbookId', 'playbookVersion'],
        group: ['playbookId', 'playbookVersion'],
      });
      return pinsOf(rows, (row) => {
        return { resourceId: row.playbookId, version: row.playbookVersion };
      });
    },
    foreignKey: 'playbookId',
    configKeys: ['definition'],
    versionsOf: async (where) => {
      const rows = await db.PlaybookVersion.findAll({
        where,
        attributes: ['playbookId'],
      });
      return rows.map((row) => {
        return row.playbookId;
      });
    },
  },
} satisfies Record<string, PinSource>;

/** Row ids of `type` pinned by live work to an archived version naming an id. */
export const pinnedRowIds = async (args: {
  type: keyof typeof PIN_SOURCES;
  projectId: number;
  ids: string[];
}): Promise<number[]> => {
  const source: PinSource = PIN_SOURCES[args.type];
  const pins = await source.pins(args.projectId);
  if (pins.length === 0) return [];
  return source.versionsOf({
    [Op.and]: [
      {
        [Op.or]: pins.map((pin) => {
          return { [source.foreignKey]: pin.resourceId, version: pin.version };
        }),
      },
      { [Op.or]: configNames(source.configKeys, args.ids) },
    ],
  });
};
