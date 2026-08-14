/**
 * Deleting an agent, and the cascade a forced delete performs.
 *
 * Split out of `agents.ts`, which had grown to a god module mixing CRUD,
 * mapping, cross-reference validation and this 120-line cascade — and carried
 * an `eslint-disable max-lines` to say so. The cascade shares nothing with the
 * write paths but the accessor, which is why it can leave.
 */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { agents } from './agentAccessor';
import { agentVersionStore } from './agentVersionSnapshot';
import { emitResourceEvent } from './eventBus';
import { deleteStorageObjects } from './fileStorage';

const log = createDebug('soat:agents');

const findDependentIds = async (args: {
  agentId: number;
}): Promise<{
  generationIds: number[];
  traceIds: number[];
  fileIds: number[];
}> => {
  const [generationRows, traceRows] = await Promise.all([
    db.Generation.findAll({
      where: { agentId: args.agentId },
      attributes: ['id'],
    }),
    db.Trace.findAll({
      where: { agentId: args.agentId },
      attributes: ['id', 'fileId'],
    }),
  ]);

  return {
    generationIds: generationRows.map((row) => {
      return row.id as number;
    }),
    traceIds: traceRows.map((row) => {
      return row.id as number;
    }),
    fileIds: traceRows
      .map((row) => {
        return row.fileId;
      })
      .filter((fileId): fileId is number => {
        return fileId !== null;
      }),
  };
};

// Deletes an agent's generations/traces along with it. Cross-references from
// OTHER agents' rows into the ones being deleted (self-referencing FKs on
// Generation.initiatorGenerationId and Trace.parentTraceId/rootTraceId) are
// nulled out first, since those FKs are RESTRICT. Traces own a File holding
// their serialized steps (see `saveTrace`); those File rows are destroyed
// alongside the traces, and their storage objects are cleaned up once the
// transaction commits (see #835 — the row must be gone before the object is,
// otherwise a concurrent read could reference bytes mid-delete).
const forceDeleteAgentWithDependents = async (args: {
  agent: InstanceType<typeof db.Agent>;
  agentId: number;
}): Promise<void> => {
  const { generationIds, traceIds, fileIds } = await findDependentIds({
    agentId: args.agentId,
  });

  const files =
    fileIds.length > 0
      ? await db.File.findAll({
          where: { id: fileIds },
          attributes: ['storagePath', 'storageType'],
        })
      : [];

  await db.sequelize.transaction(async (transaction) => {
    if (generationIds.length > 0) {
      await db.Generation.update(
        { initiatorGenerationId: null },
        { where: { initiatorGenerationId: generationIds }, transaction }
      );
    }
    if (traceIds.length > 0) {
      await db.Trace.update(
        { parentTraceId: null },
        { where: { parentTraceId: traceIds }, transaction }
      );
      await db.Trace.update(
        { rootTraceId: null },
        { where: { rootTraceId: traceIds }, transaction }
      );
    }

    await db.Generation.destroy({
      where: { agentId: args.agentId },
      transaction,
    });
    await db.Trace.destroy({ where: { agentId: args.agentId }, transaction });
    if (fileIds.length > 0) {
      await db.File.destroy({ where: { id: fileIds }, transaction });
    }
    // Archived configs are owned by the agent; remove them before the parent so
    // no orphan version rows are left behind.
    await agentVersionStore.deleteVersions({
      resourceDbId: args.agentId,
      transaction,
    });
    await args.agent.destroy({ transaction });
  });

  await deleteStorageObjects(
    files.map((file) => {
      return { storagePath: file.storagePath, storageType: file.storageType };
    })
  );
};

const countAgentDependents = async (
  agentId: number
): Promise<{ generationCount: number; traceCount: number }> => {
  const [generationCount, traceCount] = await Promise.all([
    db.Generation.count({ where: { agentId } }),
    db.Trace.count({ where: { agentId } }),
  ]);
  return { generationCount, traceCount };
};

/**
 * Why an unforced `deleteAgent` would refuse, or `null` when it would succeed.
 *
 * Exported so a caller that deletes an agent as one step of a larger, ordered
 * teardown — formation stack deletion — can learn the answer *before* it starts
 * destroying anything. Reaching the refusal by attempting the delete is too
 * late there: the resources ordered ahead of the agent are already gone by then,
 * which is the partial teardown #985 reported.
 *
 * The count logic is shared with `deleteAgent` rather than restated, so the
 * pre-flight can never disagree with the delete it predicts.
 */
export const findAgentDeletionBlocker = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<string | null> => {
  const agent = await agents.getByPublicId(args);
  const { generationCount, traceCount } = await countAgentDependents(
    agent.id as number
  );

  if (generationCount === 0 && traceCount === 0) return null;

  return (
    `Agent '${args.id}' has ${String(generationCount)} dependent generation(s) ` +
    `and ${String(traceCount)} trace(s), so it cannot be deleted.`
  );
};

export const deleteAgent = async (args: {
  projectIds?: number[];
  id: string;
  force?: boolean;
}): Promise<void> => {
  log('deleteAgent: id=%s force=%s', args.id, Boolean(args.force));

  const agent = await agents.getByPublicId(args);

  const agentId = agent.id as number;

  const { generationCount, traceCount } = await countAgentDependents(agentId);

  if (generationCount > 0 || traceCount > 0) {
    if (!args.force) {
      throw new DomainError(
        'AGENT_HAS_DEPENDENTS',
        `Agent '${args.id}' has dependent generations or traces and cannot be deleted.`,
        { generationCount, traceCount }
      );
    }

    log(
      'deleteAgent: force-cascading id=%s generations=%d traces=%d',
      args.id,
      generationCount,
      traceCount
    );

    await forceDeleteAgentWithDependents({ agent, agentId });
  } else {
    // Archived configs are owned by the agent, so they go first (the FK is
    // RESTRICT); Actor.agentId is cleared automatically by the DB via
    // onDelete: 'SET NULL' on its own FK.
    await db.AgentVersion.destroy({ where: { agentId } });
    await agent.destroy();
  }

  emitResourceEvent({
    type: 'agents.deleted',
    projectId: agent.projectId,
    resourceType: 'agent',
    resourceId: args.id,
    data: { id: args.id },
  });
};
