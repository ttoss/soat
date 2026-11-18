import { db } from '../db';
import { START_ACTIONS, type StartableType, startCheck } from './startActions';
import { buildResourceTagContext } from './tags';
import { assertAllowedUnder } from './turnAuthority';
import { requireWorkAuthority, type WorkAuthority } from './workAuthority';

/** Starts whose entry point is not `gateToolCall` or `gateGenerationStart`. */
export type GatedStartType = Exclude<StartableType, 'agent' | 'tool'>;

/**
 * The start check a decider, workflow, orchestration or eval crosses at its
 * entry point, under the authority the work runs under, before anything is
 * recorded. No caller starting one for someone else checks it again.
 */
export const gateStart = async (args: {
  type: GatedStartType;
  id: string;
  projectId: number;
  authority: WorkAuthority | null;
}): Promise<void> => {
  const authority = requireWorkAuthority({
    authority: args.authority,
    work: `The start of ${args.type} '${args.id}'`,
  });
  const project = await db.Project.findByPk(args.projectId, {
    attributes: ['publicId'],
    rejectOnEmpty: true,
  });
  const projectPublicId = project.publicId as string;
  await assertAllowedUnder({
    authority,
    checks: [
      {
        projectPublicId,
        ...startCheck({ projectPublicId, type: args.type, id: args.id }),
        context: buildResourceTagContext({
          resourceType: START_ACTIONS[args.type].resourceType,
          tags: null,
        }),
      },
    ],
  });
};
