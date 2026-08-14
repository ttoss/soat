import {
  emitResourceEvent,
  resolveProjectPublicId,
  type SoatEventTypeFor,
} from './eventBus';
import type { mapTask } from './tasks';

/**
 * Fires one task lifecycle event, mirroring `orchestrationEvents.ts` and
 * `evaluationEvents.ts`: the emitters live beside the module they belong to
 * rather than inside it, so the six task modules that emit share one shape.
 *
 * `type` is drawn from the `task` entry of the event registry
 * (`soatEvents.ts`), so a name that is not a registered task event — or that
 * belongs to some other resource — does not compile.
 */
export const emitTaskEvent = async (args: {
  type: SoatEventTypeFor<'task'>;
  projectId: number;
  task: ReturnType<typeof mapTask>;
  extra?: Record<string, unknown>;
}): Promise<void> => {
  const projectPublicId = await resolveProjectPublicId({
    projectId: args.projectId,
  });
  emitResourceEvent({
    type: args.type,
    projectId: args.projectId,
    projectPublicId,
    resourceType: 'task',
    resourceId: args.task.id,
    data: { task: args.task, ...(args.extra ?? {}) },
  });
};
