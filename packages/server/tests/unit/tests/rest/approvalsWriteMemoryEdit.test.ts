import { db } from 'src/db';
import { emitApproval } from 'src/lib/approvals';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * A held `write_memory` call writes in-process under the agent's authority, so
 * its edit is held to the actions the write performs, on the store the agent
 * writes to — the pair the agent's own write is held to.
 */
describe('POST /api/v1/approvals/{approval_id}/approve — editing a held write_memory call', () => {
  let adminToken: string;
  let projectId: string;
  let projectInternalId: number;
  let callerToken: string;
  let writerToken: string;
  let otherStoreWriterToken: string;
  let agentId: string;

  const createPolicyUser = async (args: {
    username: string;
    statement: Array<Record<string, unknown>>;
  }) => {
    const password = `${args.username}pass`;
    const user = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: args.username, password });
    const policy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({ document: { statement: args.statement } });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${user.body.id}/policies`)
      .send({ policy_ids: [policy.body.id] });
    return loginAs(args.username, password);
  };

  const seedWrite = () => {
    // No public create endpoint: items are platform-created, so tests seed
    // through `emitApproval` and resolve through REST.
    return emitApproval({
      projectId: projectInternalId,
      expiresInSeconds: 3600,
      agentId,
      proposedAction: {
        toolId: 'native:write_memory',
        action: 'write_memory',
        arguments: { content: 'Refunds need a receipt.' },
      },
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'approvalsmem',
      policyActions: ['approvals:ResolveApproval'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectInternalId = project!.id as number;

    const create = async (path: string, body: Record<string, unknown>) => {
      const res = await authenticatedTestClient(adminToken)
        .post(path)
        .send({ project_id: projectId, ...body });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    const storeId = await create('/api/v1/memory-stores', {
      name: 'Approval notes',
    });
    const otherStoreId = await create('/api/v1/memory-stores', {
      name: 'Other approval notes',
    });
    agentId = await create('/api/v1/agents', {
      ai_provider_id: await create('/api/v1/ai-providers', {
        name: 'approvals writer provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: 'http://127.0.0.1:9',
      }),
      name: 'approvals-writer',
      knowledge_config: { write_memory_store_id: storeId },
    });

    const projectWide = `srn:${projectId}:*:*`;
    callerToken = await createPolicyUser({
      username: 'approvalsmemcaller',
      statement: [
        {
          effect: 'Allow',
          action: ['approvals:ResolveApproval', 'tools:CallTool'],
          resource: [projectWide],
        },
      ],
    });
    writerToken = await createPolicyUser({
      username: 'approvalsmemwriter',
      statement: [
        {
          effect: 'Allow',
          action: [
            'approvals:ResolveApproval',
            'tools:CallTool',
            'memories:CreateMemory',
            'memories:UpdateMemory',
          ],
          resource: [projectWide],
        },
      ],
    });
    otherStoreWriterToken = await createPolicyUser({
      username: 'approvalsmemother',
      statement: [
        {
          effect: 'Allow',
          action: ['approvals:ResolveApproval', 'tools:CallTool'],
          resource: [projectWide],
        },
        {
          effect: 'Allow',
          action: ['memories:CreateMemory', 'memories:UpdateMemory'],
          resource: [`srn:${projectId}:memory_store:${otherStoreId}`],
        },
      ],
    });
  });

  test('an approver who may call tools but not write memories cannot edit', async () => {
    const seeded = await seedWrite();

    const res = await authenticatedTestClient(callerToken)
      .post(`/api/v1/approvals/${seeded.id}/approve`)
      .send({ arguments: { content: 'Refunds need nothing.' } });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test("a grant on another store does not cover the agent's store", async () => {
    const seeded = await seedWrite();

    const res = await authenticatedTestClient(otherStoreWriterToken)
      .post(`/api/v1/approvals/${seeded.id}/approve`)
      .send({ arguments: { content: 'Refunds need nothing.' } });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('the same approver can still approve as proposed', async () => {
    const seeded = await seedWrite();

    const res = await authenticatedTestClient(callerToken)
      .post(`/api/v1/approvals/${seeded.id}/approve`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
  });

  test('an approver holding both memory-write actions can edit', async () => {
    const seeded = await seedWrite();

    const res = await authenticatedTestClient(writerToken)
      .post(`/api/v1/approvals/${seeded.id}/approve`)
      .send({ arguments: { content: 'Refunds need a dated receipt.' } });

    expect(res.status).toBe(200);
    expect(res.body.edited_arguments).toEqual({
      content: 'Refunds need a dated receipt.',
    });
  });
});
