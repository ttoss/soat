import type { Tool } from 'ai';
import { isSoatActionAllowedByBoundary } from 'src/lib/agentToolResolver';
import { resolveSoatTools } from 'src/lib/agentToolResolverExternalTools';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

// A protocol test reads the call, not its meter: no project, so the
// recorder's write is refused and swallowed.
const UNMETERED = { projectId: 0, toolId: null, attribution: {} };

/**
 * A builtin action carries the caller's bearer, so the route checks the
 * caller's policy against the target's SRN. The agent's `boundary_policy` is
 * the second half of that intersection, and it is evaluated here — before the
 * request — against the same SRN and tags, so an operator can confine an agent
 * to named resources whoever invoked it.
 *
 * Executed against the real in-process dispatch with the real boundary check:
 * a resolver that reads the wrong argument, or loses the tags, shows up as a
 * call that should have been refused going through.
 */
describe('a builtin tool is bounded by the resource its arguments name', () => {
  let adminToken: string;
  let projectId: string;
  let allowedStoreId: string;
  let otherStoreId: string;

  const resolveGetMemoryStore = (boundaryPolicy: unknown): Tool => {
    const tools = resolveSoatTools({
      meter: UNMETERED,
      typedTool: {
        name: 'platform',
        description: null,
        actions: ['get-memory-store'],
      },
      authHeader: `Bearer ${adminToken}`,
      projectPublicId: projectId,
      boundaryPolicy,
      buildContextHeaders: () => {
        return {};
      },
      isSoatActionAllowedByBoundary,
      logToolCallingError: () => {},
    });
    return tools['platform_get-memory-store'];
  };

  const callWith = async (args: {
    tool: Tool;
    memoryStoreId: string;
  }): Promise<{ id?: string; error?: string }> => {
    return (await args.tool.execute?.(
      { memory_store_id: args.memoryStoreId },
      { messages: [], toolCallId: 'call_1', context: undefined }
    )) as { id?: string; error?: string };
  };

  const allowMemoriesOn = (resource: string) => {
    return {
      statement: [
        { effect: 'Allow', action: ['memories:*'], resource: [resource] },
      ],
    };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'boundscope',
      policyActions: ['memories:*'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    await loginAs('boundscopeadmin', 'supersecret');

    const allowed = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-stores')
      .send({
        project_id: projectId,
        name: 'Boundary Allowed Store',
        tags: { env: 'prod' },
      });
    allowedStoreId = allowed.body.id;

    const other = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: 'Boundary Other Store' });
    otherStoreId = other.body.id;
  });

  test('the named resource is reached', async () => {
    const tool = resolveGetMemoryStore(
      allowMemoriesOn(`srn:${projectId}:memory_store:${allowedStoreId}`)
    );

    const result = await callWith({ tool, memoryStoreId: allowedStoreId });

    expect(result.error).toBeUndefined();
    expect(result.id).toBe(allowedStoreId);
  });

  test('another resource of the same type is refused', async () => {
    const tool = resolveGetMemoryStore(
      allowMemoriesOn(`srn:${projectId}:memory_store:${allowedStoreId}`)
    );

    const result = await callWith({ tool, memoryStoreId: otherStoreId });

    expect(result).toEqual({
      error: 'Forbidden: boundary policy denies memories:GetMemoryStore',
    });
  });

  test('a resource-tag condition reads the target resource tags', async () => {
    const boundaryPolicy = {
      statement: [
        {
          effect: 'Allow',
          action: ['memories:*'],
          resource: ['*'],
          condition: { StringEquals: { 'soat:ResourceTag/env': 'prod' } },
        },
      ],
    };

    const tagged = await callWith({
      tool: resolveGetMemoryStore(boundaryPolicy),
      memoryStoreId: allowedStoreId,
    });
    expect(tagged.error).toBeUndefined();

    const untagged = await callWith({
      tool: resolveGetMemoryStore(boundaryPolicy),
      memoryStoreId: otherStoreId,
    });
    expect(untagged).toEqual({
      error: 'Forbidden: boundary policy denies memories:GetMemoryStore',
    });
  });

  test('a preset-supplied resource is the one the boundary is checked against', async () => {
    // The operator pins the store the agent may read; the model passes no
    // argument at all. Checking the model's arguments alone would find no
    // resource and refuse the call the operator explicitly allowed.
    const tools = resolveSoatTools({
      meter: UNMETERED,
      typedTool: {
        name: 'platform',
        description: null,
        actions: ['get-memory-store'],
        presetParameters: { memory_store_id: allowedStoreId },
      },
      authHeader: `Bearer ${adminToken}`,
      projectPublicId: projectId,
      boundaryPolicy: allowMemoriesOn(
        `srn:${projectId}:memory_store:${allowedStoreId}`
      ),
      buildContextHeaders: () => {
        return {};
      },
      isSoatActionAllowedByBoundary,
      logToolCallingError: () => {},
    });

    const result = (await tools['platform_get-memory-store'].execute?.(
      {},
      { messages: [], toolCallId: 'call_1', context: undefined }
    )) as { id?: string; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.id).toBe(allowedStoreId);
  });

  test('a wildcard boundary still reaches every resource', async () => {
    const tool = resolveGetMemoryStore(allowMemoriesOn('*'));

    const result = await callWith({ tool, memoryStoreId: otherStoreId });

    expect(result.error).toBeUndefined();
    expect(result.id).toBe(otherStoreId);
  });
});

/**
 * One case per annotated resource kind, through the tool the agent would call.
 * The kinds differ in what the SRN names — a memory authorizes through its
 * store, a rule through the store it feeds — so a resolver that took the id at
 * face value would pass the memory-store case above and fail here.
 */
describe('each annotated resource kind resolves the scope its route checks', () => {
  let adminToken: string;
  let projectId: string;
  let storeId: string;
  let otherStoreId: string;
  let actorId: string;
  let otherActorId: string;
  let conversationId: string;
  let otherConversationId: string;
  let memoryId: string;
  let otherMemoryId: string;
  let ruleId: string;
  let otherRuleId: string;
  let sessionId: string;
  let otherSessionId: string;

  const callTool = async (args: {
    action: string;
    input: Record<string, unknown>;
    resource: string;
  }): Promise<{ id?: string; error?: string }> => {
    const tools = resolveSoatTools({
      meter: UNMETERED,
      typedTool: {
        name: 'platform',
        description: null,
        actions: [args.action],
      },
      authHeader: `Bearer ${adminToken}`,
      projectPublicId: projectId,
      boundaryPolicy: {
        statement: [
          { effect: 'Allow', action: ['*'], resource: [args.resource] },
        ],
      },
      buildContextHeaders: () => {
        return {};
      },
      isSoatActionAllowedByBoundary,
      logToolCallingError: () => {},
    });
    return (await tools[`platform_${args.action}`].execute?.(args.input, {
      messages: [],
      toolCallId: 'call_1',
      context: undefined,
    })) as { id?: string; error?: string };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'boundkinds',
      policyActions: ['*'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    await loginAs('boundkindsadmin', 'supersecret');

    const client = authenticatedTestClient(adminToken);

    const store = await client
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: 'Kinds Store' });
    storeId = store.body.id;
    const otherStore = await client
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: 'Kinds Other Store' });
    otherStoreId = otherStore.body.id;

    const actor = await client
      .post('/api/v1/actors')
      .send({ project_id: projectId, name: 'Kinds Actor' });
    actorId = actor.body.id;
    const otherActor = await client
      .post('/api/v1/actors')
      .send({ project_id: projectId, name: 'Kinds Other Actor' });
    otherActorId = otherActor.body.id;

    const conversation = await client
      .post('/api/v1/conversations')
      .send({ project_id: projectId });
    conversationId = conversation.body.id;
    const otherConversation = await client
      .post('/api/v1/conversations')
      .send({ project_id: projectId });
    otherConversationId = otherConversation.body.id;

    const memory = await client
      .post('/api/v1/memories')
      .send({ memory_store_id: storeId, content: 'A fact in the store.' });
    memoryId = memory.body.id;
    const otherMemory = await client.post('/api/v1/memories').send({
      memory_store_id: otherStoreId,
      content: 'A fact in the other store.',
    });
    otherMemoryId = otherMemory.body.id;

    const rule = await client
      .post('/api/v1/memory-rules')
      .send({ memory_store_id: storeId, on: 'agents.generation.completed' });
    ruleId = rule.body.id;
    const otherRule = await client.post('/api/v1/memory-rules').send({
      memory_store_id: otherStoreId,
      on: 'agents.generation.completed',
    });
    otherRuleId = otherRule.body.id;

    const provider = await client.post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Kinds Provider',
      provider: 'ollama',
      default_model: 'llama3.2',
    });
    const agent = await client.post('/api/v1/agents').send({
      project_id: projectId,
      name: 'Kinds Agent',
      ai_provider_id: provider.body.id,
    });
    const session = await client
      .post('/api/v1/sessions')
      .send({ agent_id: agent.body.id });
    sessionId = session.body.id;
    const otherSession = await client
      .post('/api/v1/sessions')
      .send({ agent_id: agent.body.id });
    otherSessionId = otherSession.body.id;
  });

  test('an actor is bounded by its own SRN', async () => {
    const resource = `srn:${projectId}:actor:${actorId}`;
    const allowed = await callTool({
      action: 'get-actor',
      input: { actor_id: actorId },
      resource,
    });
    const denied = await callTool({
      action: 'get-actor',
      input: { actor_id: otherActorId },
      resource,
    });

    expect(allowed.id).toBe(actorId);
    expect(denied.error).toBe(
      'Forbidden: boundary policy denies actors:GetActor'
    );
  });

  test('a conversation is bounded by its own SRN', async () => {
    const resource = `srn:${projectId}:conversation:${conversationId}`;
    const allowed = await callTool({
      action: 'get-conversation',
      input: { conversation_id: conversationId },
      resource,
    });
    const denied = await callTool({
      action: 'get-conversation',
      input: { conversation_id: otherConversationId },
      resource,
    });

    expect(allowed.id).toBe(conversationId);
    expect(denied.error).toBe(
      'Forbidden: boundary policy denies conversations:GetConversation'
    );
  });

  test('a memory is bounded by its store SRN', async () => {
    const resource = `srn:${projectId}:memory_store:${storeId}`;
    const allowed = await callTool({
      action: 'get-memory',
      input: { memory_id: memoryId },
      resource,
    });
    const denied = await callTool({
      action: 'get-memory',
      input: { memory_id: otherMemoryId },
      resource,
    });

    expect(allowed.id).toBe(memoryId);
    expect(denied.error).toBe(
      'Forbidden: boundary policy denies memories:GetMemory'
    );
  });

  test('a memory rule is bounded by the store it feeds', async () => {
    const resource = `srn:${projectId}:memory_store:${storeId}`;
    const allowed = await callTool({
      action: 'get-memory-rule',
      input: { memory_rule_id: ruleId },
      resource,
    });
    const denied = await callTool({
      action: 'get-memory-rule',
      input: { memory_rule_id: otherRuleId },
      resource,
    });

    expect(allowed.id).toBe(ruleId);
    expect(denied.error).toBe(
      'Forbidden: boundary policy denies memories:GetMemoryRule'
    );
  });

  test('a session is bounded by its own SRN', async () => {
    const resource = `srn:${projectId}:session:${sessionId}`;
    const allowed = await callTool({
      action: 'get-session',
      input: { session_id: sessionId },
      resource,
    });
    const denied = await callTool({
      action: 'get-session',
      input: { session_id: otherSessionId },
      resource,
    });

    expect(allowed.id).toBe(sessionId);
    expect(denied.error).toBe(
      'Forbidden: boundary policy denies agents:GetSession'
    );
  });

  test('an agent is bounded by its own SRN', async () => {
    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Kinds Target Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const client = authenticatedTestClient(adminToken);
    const target = await client.post('/api/v1/agents').send({
      project_id: projectId,
      name: 'Kinds Target Agent',
      ai_provider_id: provider.body.id,
    });
    const otherTarget = await client.post('/api/v1/agents').send({
      project_id: projectId,
      name: 'Kinds Other Target Agent',
      ai_provider_id: provider.body.id,
    });

    const resource = `srn:${projectId}:agent:${target.body.id}`;
    const allowed = await callTool({
      action: 'get-agent',
      input: { agent_id: target.body.id },
      resource,
    });
    const denied = await callTool({
      action: 'get-agent',
      input: { agent_id: otherTarget.body.id },
      resource,
    });

    expect(allowed.id).toBe(target.body.id);
    expect(denied.error).toBe(
      'Forbidden: boundary policy denies agents:GetAgent'
    );
  });

  test('an id that resolves to nothing is refused by a scoped boundary', async () => {
    const result = await callTool({
      action: 'get-memory-store',
      input: { memory_store_id: 'mstore_nonexistent' },
      resource: `srn:${projectId}:memory_store:${storeId}`,
    });

    expect(result.error).toBe(
      'Forbidden: boundary policy denies memories:GetMemoryStore'
    );
  });
});
