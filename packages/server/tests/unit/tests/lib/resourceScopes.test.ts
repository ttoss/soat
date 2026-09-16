import { db } from 'src/db';
import { createActor } from 'src/lib/actors';
import { createConversation } from 'src/lib/conversations';
import { writeMemory } from 'src/lib/memories';
import { createMemoryRule } from 'src/lib/memoryRules';
import { createMemoryStore } from 'src/lib/memoryStores';
import { resolveResourceScope } from 'src/lib/resourceScopes';

/**
 * The table that says what a public id authorizes against. It is the half of
 * the boundary check that is not visible from a refused call — a wrong SRN and
 * a missing resolver both read as "denied" — so each kind is asserted here
 * directly, against the pair its module's routes check.
 *
 * A `lib/` test because the mapping is the input space: one entry per kind,
 * two of them resolving to a resource other than the one named. The end-to-end
 * refusal is covered through the tool surface in
 * `rest/soatToolBoundaryScope.test.ts`.
 */
describe('resolveResourceScope', () => {
  let projectId: number;
  let projectPublicId: string;
  let storeId: string;
  let taggedStoreId: string;

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'ResourceScopes Test' });
    projectId = project.id as number;
    projectPublicId = project.publicId;

    storeId = (await createMemoryStore({ projectId, name: 'Scopes Store' })).id;
    taggedStoreId = (
      await createMemoryStore({
        projectId,
        name: 'Scopes Tagged Store',
        tags: { env: 'prod' },
      })
    ).id;
  });

  test('a memory store resolves to its own SRN parts and tags', async () => {
    const scope = await resolveResourceScope({
      kind: 'memory_store',
      publicId: taggedStoreId,
    });

    expect(scope).toEqual({
      resourceType: 'memory_store',
      resourceId: taggedStoreId,
      projectId,
      projectPublicId,
      tags: { env: 'prod' },
    });
  });

  test('a memory resolves to the store that holds it', async () => {
    const store = await db.MemoryStore.findOne({
      where: { publicId: taggedStoreId },
    });
    const written = await writeMemory({
      memoryStoreId: store!.id as number,
      content: 'A fact the scope test reads back.',
      assertion: {
        mechanism: 'api',
        principalType: 'user',
        principalId: 'user_scopes_test',
      },
    });

    const scope = await resolveResourceScope({
      kind: 'memory',
      publicId: written.entry.id,
    });

    expect(scope).toEqual({
      resourceType: 'memory_store',
      resourceId: taggedStoreId,
      projectId,
      projectPublicId,
      tags: { env: 'prod' },
    });
  });

  test('a memory rule resolves to the store it feeds', async () => {
    const store = await db.MemoryStore.findOne({
      where: { publicId: storeId },
    });
    const rule = await createMemoryRule({
      memoryStoreId: store!.id as number,
      on: 'agents.generation.completed',
    });

    const scope = await resolveResourceScope({
      kind: 'memory_rule',
      publicId: rule.id,
    });

    expect(scope).toEqual({
      resourceType: 'memory_store',
      resourceId: storeId,
      projectId,
      projectPublicId,
      tags: null,
    });
  });

  test('an agent resolves to its own SRN parts', async () => {
    const provider = await db.AiProvider.create({
      projectId,
      name: 'Scopes Agent Provider',
      provider: 'ollama',
      defaultModel: 'llama3.2',
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: provider.id,
      name: 'Scopes Standalone Agent',
    });

    const scope = await resolveResourceScope({
      kind: 'agent',
      publicId: agent.publicId,
    });

    expect(scope).toEqual({
      resourceType: 'agent',
      resourceId: agent.publicId,
      projectId,
      projectPublicId,
      // Agents carry no tags column, so a tag condition reads no pairs.
      tags: null,
    });
  });

  test('an actor resolves to its own SRN parts', async () => {
    const actor = await createActor({ projectId, name: 'Scopes Actor' });

    const scope = await resolveResourceScope({
      kind: 'actor',
      publicId: actor.id,
    });

    expect(scope).toEqual({
      resourceType: 'actor',
      resourceId: actor.id,
      projectId,
      projectPublicId,
      // The column defaults to an empty bag rather than null, so a condition
      // over resource tags reads no pairs — not a missing context.
      tags: {},
    });
  });

  test('a conversation resolves to its own SRN parts', async () => {
    const conversation = await createConversation({ projectId });

    const scope = await resolveResourceScope({
      kind: 'conversation',
      publicId: conversation.id,
    });

    expect(scope).toEqual({
      resourceType: 'conversation',
      resourceId: conversation.id,
      projectId,
      projectPublicId,
      tags: {},
    });
  });

  test('a session resolves to its own SRN parts', async () => {
    const provider = await db.AiProvider.create({
      projectId,
      name: 'Scopes Provider',
      provider: 'ollama',
      defaultModel: 'llama3.2',
    });
    const agent = await db.Agent.create({
      projectId,
      aiProviderId: provider.id,
      name: 'Scopes Agent',
    });
    const conversation = await createConversation({ projectId });
    const conversationRow = await db.Conversation.findOne({
      where: { publicId: conversation.id },
    });
    const session = await db.Session.create({
      projectId,
      agentId: agent.id,
      conversationId: conversationRow!.id,
      status: 'active',
      tags: { env: 'staging' },
    });

    const scope = await resolveResourceScope({
      kind: 'session',
      publicId: session.publicId,
    });

    expect(scope).toEqual({
      resourceType: 'session',
      resourceId: session.publicId,
      projectId,
      projectPublicId,
      tags: { env: 'staging' },
    });
  });

  // Both leave the caller with the resource-less `*`, which matches no scoped
  // statement — so an unknown kind and a dangling id refuse rather than admit.
  test('an unknown kind resolves to nothing', async () => {
    const scope = await resolveResourceScope({
      kind: 'workflow',
      publicId: 'wkf_whatever',
    });

    expect(scope).toBeNull();
  });

  // Some accessors answer null on a miss and others throw; every kind has to
  // read the same way here, because "no scope" is what leaves the check on the
  // resource-less `*`.
  test.each([
    ['agent', 'agent_absent'],
    ['memory_store', 'mstore_absent'],
    ['memory', 'mem_absent'],
    ['memory_rule', 'mrule_absent'],
    ['actor', 'actor_absent'],
    ['conversation', 'conv_absent'],
    ['session', 'sess_absent'],
  ])('an id that names no %s resolves to nothing', async (kind, publicId) => {
    await expect(resolveResourceScope({ kind, publicId })).resolves.toBeNull();
  });
});
