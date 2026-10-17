import { db } from '../../db';
import { DomainError } from '../../errors';
import { lookupAgentInternalId } from '../formationLookups';
import {
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { readMaxContextMessages } from '../sessionContextWindow';
import {
  createSession,
  deleteSession,
  getSession,
  updateSession,
} from '../sessions';
import { toStoredToolContext } from '../toolContext';
import { defineFormationModule } from './defineFormationModule';
import { pushStringBagValueErrors } from './formationSpecLoader';

const getSessionAgentInternalId = async (
  sessionPublicId: string
): Promise<number> => {
  const session = await db.Session.findOne({
    where: { publicId: sessionPublicId },
  });
  if (!session?.agentId) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Session not found: ${sessionPublicId}`
    );
  }
  return session.agentId;
};

/** A template declares the whole session, so an undeclared window is null. */
const maxContextMessagesOf = (
  properties: Record<string, unknown>
): number | null => {
  const value = properties.max_context_messages;
  return (
    readMaxContextMessages(typeof value === 'number' ? value : null) ?? null
  );
};

export const sessionsFormationModule = defineFormationModule({
  resourceType: 'session',
  authorization: {
    srnResourceType: 'session',
    create: 'agents:CreateSession',
    update: 'agents:UpdateSession',
    delete: 'agents:DeleteSession',
  },

  extraChecks: (args) => {
    pushStringBagValueErrors({ ...args, field: 'tool_context' });
  },

  create: async ({ properties, projectId }) => {
    const agentId = await lookupAgentInternalId({
      publicId: properties.agent_id as string,
      projectId,
      reach: 'project',
    });

    return createSession({
      projectId,
      agentId,
      name: toNullableString(properties.name),
      actorId: toNullableString(properties.actor_id),
      autoGenerate:
        typeof properties.auto_generate === 'boolean'
          ? properties.auto_generate
          : undefined,
      inactivityTtlSeconds:
        typeof properties.inactivity_ttl_seconds === 'number'
          ? properties.inactivity_ttl_seconds
          : undefined,
      maxContextMessages: maxContextMessagesOf(properties),
      toolContext: toStoredToolContext(properties.tool_context),
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    const agentId = await getSessionAgentInternalId(physicalResourceId);

    await updateSession({
      agentId,
      sessionId: physicalResourceId,
      name: toNullableString(properties.name),
      status: toOptionalString(properties.status) ?? undefined,
      autoGenerate:
        typeof properties.auto_generate === 'boolean'
          ? properties.auto_generate
          : undefined,
      maxContextMessages: maxContextMessagesOf(properties),
      toolContext: toStoredToolContext(properties.tool_context),
    });
  },

  remove: async ({ physicalResourceId }) => {
    const agentId = await getSessionAgentInternalId(physicalResourceId);
    await deleteSession({ agentId, sessionId: physicalResourceId });
  },

  // `getSession` already returns the snake_case read contract, so the formation
  // view is a selection of it rather than a second transcription.
  fetch: async ({ physicalResourceId }) => {
    const agentId = await getSessionAgentInternalId(physicalResourceId);
    return getSession({ agentId, sessionId: physicalResourceId });
  },

  // `getSession` never returns the bag, so a live-read diff can never confirm
  // it matches the template: without this, `plan-formation` compares the
  // declared value against a key that is always absent and reports `update`
  // forever, and applying it a second time would silently keep the first
  // apply's raw value in `lastAppliedProperties` to make that diff agree.
  writeOnlyProperties: ['tool_context'],
});
