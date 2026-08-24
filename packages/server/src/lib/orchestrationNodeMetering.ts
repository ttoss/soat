import type { db } from '../db';
import { recordComputeUsage } from './usageComputeRecording';

/**
 * Meters the wall-clock compute of a finished node execution as one
 * `compute_execution` usage event (usage-metering P4). Called at every terminal
 * recording point in `orchestrationNodeRecorder` — pure and side-effecting nodes
 * alike — so a node execution is metered exactly once (the two paths are
 * mutually exclusive per execution). A skipped node (no `startedAt`) did no work
 * and is not metered. Awaited so the event is durable before the run advances;
 * `recordComputeUsage` never throws.
 *
 * Lives apart from the recorder because metering a finished execution is a
 * distinct concern from deciding what to record, and the recorder is at its
 * line ceiling.
 */
export const meterNodeCompute = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  nodeId: string;
  attempt: number;
  startedAt: Date | null;
  completedAt: Date | null;
}): Promise<void> => {
  if (!args.startedAt || !args.completedAt) return;
  await recordComputeUsage({
    projectId: args.runRecord.projectId as number,
    orchestrationRunId: args.runRecord.id as number,
    runPublicId: args.runRecord.publicId as string,
    nodeId: args.nodeId,
    attempt: args.attempt,
    startedAt: args.startedAt,
    completedAt: args.completedAt,
  });
};
