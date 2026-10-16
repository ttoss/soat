import createDebug from 'debug';

import { db } from '../db';
import type { PlaybookCaseSnapshot, PlaybookRunRef } from './playbookState';

const log = createDebug('soat:playbookCases');

/**
 * What a `waiting` node waits on, in that resource's own words: a task's
 * workflow `state` and `automation_status` (`failed` when its dispatch failed
 * and nothing routes the failure), or a run's `status`. Read on every case
 * read, never stored. A field is null when the resource no longer exists.
 */
export type PlaybookNodeRun =
  | {
      type: 'task';
      id: string;
      state: string | null;
      automation_status: string | null;
    }
  | { type: 'orchestration_run'; id: string; status: string | null };

const idsOf = (args: {
  refs: Array<PlaybookRunRef & { node: string }>;
  type: PlaybookRunRef['type'];
}) => {
  return args.refs
    .filter((ref) => {
      return ref.type === args.type;
    })
    .map((ref) => {
      return ref.id;
    });
};

/** The run each waiting node waits on, by node key. */
export const playbookNodeRuns = async (args: {
  snapshot: PlaybookCaseSnapshot;
}): Promise<Map<string, PlaybookNodeRun>> => {
  const refs = Object.entries(args.snapshot).flatMap(([node, record]) => {
    const run = record.execution?.run;
    return run ? [{ node, ...run }] : [];
  });
  if (refs.length === 0) return new Map();
  log('playbookNodeRuns: %d waiting', refs.length);

  const [tasks, runs] = await Promise.all([
    db.Task.findAll({
      where: { publicId: idsOf({ refs, type: 'task' }) },
      attributes: ['publicId', 'state', 'automationStatus'],
    }),
    db.OrchestrationRun.findAll({
      where: { publicId: idsOf({ refs, type: 'orchestration_run' }) },
      attributes: ['publicId', 'status'],
    }),
  ]);
  const taskById = new Map(
    tasks.map((task) => {
      return [task.publicId, task];
    })
  );
  const runById = new Map(
    runs.map((run) => {
      return [run.publicId, run];
    })
  );

  return new Map(
    refs.map((ref): [string, PlaybookNodeRun] => {
      if (ref.type === 'task') {
        const task = taskById.get(ref.id);
        return [
          ref.node,
          {
            type: 'task',
            id: ref.id,
            state: task?.state ?? null,
            automation_status: task?.automationStatus ?? null,
          },
        ];
      }
      return [
        ref.node,
        {
          type: 'orchestration_run',
          id: ref.id,
          status: runById.get(ref.id)?.status ?? null,
        },
      ];
    })
  );
};
