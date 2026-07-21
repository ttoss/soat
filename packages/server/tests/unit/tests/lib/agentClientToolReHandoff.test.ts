import { db } from 'src/db';
import { emitClientToolReHandoff } from 'src/lib/agentClientToolReHandoff';
import { pendingGenerations } from 'src/lib/agentGenerationHelpers';
import { emitApproval } from 'src/lib/approvals';

// On approval, a class-C client-tool item cannot run server-side — it is
// re-handed-off to the client as a fresh generation suspended at
// `requires_action` with the frozen (or edited) call pending. Real DB; no model
// call is made (buildGenerationContext only constructs the model, never invokes
// it).

describe('emitClientToolReHandoff (client-tool approval → requires_action)', () => {
  let projectId: number;
  let agentPublicId: string;
  let clientToolId: string;
  let httpToolId: string;

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'ReHandoff Project' });
    projectId = project.id;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'ReHandoff Provider',
      provider: 'ollama',
      defaultModel: 'stub-model',
      baseUrl: 'http://127.0.0.1:1',
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'ReHandoff Agent',
    });
    agentPublicId = agent.publicId;

    const clientTool = await db.Tool.create({
      projectId,
      type: 'client',
      name: 'write_local_file',
      description: 'Write a file on the caller machine',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    });
    clientToolId = clientTool.publicId;

    const httpTool = await db.Tool.create({
      projectId,
      type: 'http',
      name: 'ship',
      description: 'server tool',
      execute: { url: 'http://127.0.0.1:1/ship', method: 'POST' },
    });
    httpToolId = httpTool.publicId;
  });

  const fileClientApproval = async () => {
    return emitApproval({
      projectId,
      origin: 'tool_call',
      proposedAction: {
        toolId: clientToolId,
        action: 'write_local_file',
        arguments: { path: '/etc/frozen' },
      },
      expiresInSeconds: 3600,
      agentId: agentPublicId,
      generationId: 'gen_original_rehandoff',
    });
  };

  test('a client-tool approval seeds a new pending requires_action generation', async () => {
    const item = await fileClientApproval();
    const before = pendingGenerations.size;

    const handled = await emitClientToolReHandoff({
      item,
      projectInternalId: projectId,
    });

    expect(handled).toBe(true);
    expect(pendingGenerations.size).toBe(before + 1);

    // Find the newly seeded pending generation for this agent.
    const seeded = [...pendingGenerations.values()].find((pending) => {
      return (
        pending.agentId === agentPublicId &&
        pending.pendingToolCalls.some((call) => {
          return call.toolName === 'write_local_file';
        })
      );
    });
    expect(seeded).toBeDefined();
    expect(seeded!.pendingToolCalls[0].args).toEqual({ path: '/etc/frozen' });

    // The seeded generation is linked back to the original.
    const gen = await db.Generation.findOne({
      where: { publicId: seeded!.generationId },
    });
    expect(gen).not.toBeNull();
    expect(gen!.status).toBe('requires_action');
  });

  test('edited arguments override the frozen proposal in the re-handoff', async () => {
    const item = await emitApproval({
      projectId,
      origin: 'tool_call',
      proposedAction: {
        toolId: clientToolId,
        action: 'write_local_file',
        arguments: { path: '/etc/frozen' },
      },
      expiresInSeconds: 3600,
      agentId: agentPublicId,
      generationId: 'gen_original_edited',
    });
    // Simulate a human editing the arguments before approval.
    await db.ApprovalItem.update(
      { editedArguments: { path: '/tmp/edited' } },
      { where: { publicId: item.id } }
    );
    const reloaded = { ...item, editedArguments: { path: '/tmp/edited' } };

    const handled = await emitClientToolReHandoff({
      item: reloaded,
      projectInternalId: projectId,
    });
    expect(handled).toBe(true);

    const seeded = [...pendingGenerations.values()].find((pending) => {
      return pending.pendingToolCalls.some((call) => {
        const args = call.args as { path?: string };
        return args.path === '/tmp/edited';
      });
    });
    expect(seeded).toBeDefined();
  });

  test('a server (non-client) tool is not re-handed-off — caller falls back', async () => {
    const item = await emitApproval({
      projectId,
      origin: 'tool_call',
      proposedAction: {
        toolId: httpToolId,
        action: 'ship',
        arguments: { qty: 1 },
      },
      expiresInSeconds: 3600,
      agentId: agentPublicId,
      generationId: 'gen_original_server',
    });

    const handled = await emitClientToolReHandoff({
      item,
      projectInternalId: projectId,
    });
    expect(handled).toBe(false);
  });

  test('an inline-tool proposal (no toolId) is not re-handed-off', async () => {
    const item = await emitApproval({
      projectId,
      origin: 'tool_call',
      proposedAction: null,
      expiresInSeconds: 3600,
      agentId: agentPublicId,
      generationId: 'gen_original_inline',
    });

    const handled = await emitClientToolReHandoff({
      item,
      projectInternalId: projectId,
    });
    expect(handled).toBe(false);
  });
});
