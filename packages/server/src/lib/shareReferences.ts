import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { shares } from './shares';

const log = createDebug('soat:shares');

/** A resource of the grantee project that names a shared resource. */
export type ShareReference = {
  type:
    | 'agent'
    | 'tool'
    | 'ingestion_rule'
    | 'orchestration'
    | 'trigger'
    | 'formation';
  id: string;
};

type Where = ReturnType<typeof db.sequelize.where>;

// A public id is only ever stored as a JSON string, so its quoted form found in
// the column's text is the id itself and never a prefix of another.
const jsonNames = (column: string, id: string): Where => {
  return db.sequelize.where(
    db.sequelize.fn(
      'strpos',
      db.sequelize.cast(db.sequelize.col(column), 'text'),
      JSON.stringify(id)
    ),
    Op.gt,
    0
  );
};

const publicIds = (rows: Array<{ publicId: string }>): string[] => {
  return rows.map((row) => {
    return row.publicId;
  });
};

const toReferences = (
  type: ShareReference['type'],
  ids: string[]
): ShareReference[] => {
  return ids.map((id) => {
    return { type, id };
  });
};

/** The grantee's agents and pipelines naming a shared tool. */
const findToolUsers = async (args: {
  projectId: number;
  toolId: string;
}): Promise<ShareReference[]> => {
  const [agents, pipelines] = await Promise.all([
    db.Agent.findAll({
      where: {
        projectId: args.projectId,
        [Op.or]: [
          jsonNames('tool_bindings', args.toolId),
          jsonNames('active_tool_ids', args.toolId),
          jsonNames('step_rules', args.toolId),
        ],
      },
      attributes: ['publicId'],
    }),
    db.Tool.findAll({
      where: {
        projectId: args.projectId,
        [Op.and]: [jsonNames('pipeline', args.toolId)],
      },
      attributes: ['publicId'],
    }),
  ]);
  return [
    ...toReferences('agent', publicIds(agents)),
    ...toReferences('tool', publicIds(pipelines)),
  ];
};

/**
 * Every resource in `projectId` that names the shared tool or agent
 * `resourceId`: what degrades if the project's acceptance is revoked. Answers
 * both `GET /shares/{id}/references` and the grantee's revoke refusal, so the
 * two cannot disagree.
 */
export const findShareReferences = async (args: {
  resourceType: string;
  resourceId: string;
  projectId: number;
}): Promise<ShareReference[]> => {
  log(
    'findShareReferences: %s %s projectId=%d',
    args.resourceType,
    args.resourceId,
    args.projectId
  );
  const isTool = args.resourceType === 'tool';
  const lookup = { where: { publicId: args.resourceId }, attributes: ['id'] };
  const resource = await (isTool
    ? db.Tool.findOne(lookup)
    : db.Agent.findOne(lookup));

  const [users, rules, orchestrations, triggers, formations] =
    await Promise.all([
      isTool
        ? findToolUsers({ projectId: args.projectId, toolId: args.resourceId })
        : [],
      resource
        ? db.IngestionRule.findAll({
            where: {
              projectId: args.projectId,
              [isTool ? 'toolId' : 'agentId']: resource.id,
            },
            attributes: ['publicId'],
          })
        : [],
      db.Orchestration.findAll({
        where: {
          projectId: args.projectId,
          [Op.and]: [jsonNames('nodes', args.resourceId)],
        },
        attributes: ['publicId'],
      }),
      db.Trigger.findAll({
        where: {
          projectId: args.projectId,
          targetType: args.resourceType,
          targetId: args.resourceId,
        },
        attributes: ['publicId'],
      }),
      db.Formation.findAll({
        where: {
          projectId: args.projectId,
          [Op.and]: [jsonNames('template', args.resourceId)],
        },
        attributes: ['publicId'],
      }),
    ]);

  return [
    ...users,
    ...toReferences('ingestion_rule', publicIds(rules)),
    ...toReferences('orchestration', publicIds(orchestrations)),
    ...toReferences('trigger', publicIds(triggers)),
    ...toReferences('formation', publicIds(formations)),
  ];
};

/** What `projectId` names of the resource share `id` grants it. */
export const listShareReferences = async (args: {
  id: string;
  projectId: number;
}): Promise<{ data: ShareReference[] }> => {
  const share = await shares.getByPublicId({ id: args.id });
  return {
    data: await findShareReferences({
      resourceType: share.resourceType,
      resourceId: share.resourceId,
      projectId: args.projectId,
    }),
  };
};
