import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { memoryStoresFormationModule } from 'src/lib/formation-modules/memoryStoresFormationModule';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// What a deploy does to built-in resources across a formation's life: the
// update each module applies, the resources a new template drops, the outputs a
// stored template resolves, and the unwind of a deploy that fails. Every
// outcome is read back through the resource's own route.

let adminToken: string;
let projectId: string;
let aiProviderId: string;
let secretId: string;
let agentId: string;
let formationCounter = 0;

const client = () => {
  return authenticatedTestClient(adminToken);
};

const createFormation = async (template: unknown) => {
  formationCounter += 1;
  const res = await client()
    .post('/api/v1/formations')
    .send({
      project_id: projectId,
      name: `apply-lifecycle-${String(formationCounter)}`,
      template,
    });
  expect(res.status).toBe(201);
  return res;
};

const updateFormation = (formationId: string, body: object) => {
  return client().put(`/api/v1/formations/${formationId}`).send(body);
};

const physicalIdOf = (
  formation: {
    resources: { logical_id: string; physical_resource_id: string }[];
  },
  logicalId: string
): string => {
  const resource = formation.resources.find((r) => {
    return r.logical_id === logicalId;
  });
  if (!resource) throw new Error(`no resource ${logicalId}`);
  return resource.physical_resource_id;
};

const latestOperationEvents = async (formationId: string) => {
  const res = await client().get(`/api/v1/formations/${formationId}/events`);
  expect(res.status).toBe(200);
  return res.body.data[res.body.data.length - 1].events;
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'fmlife',
    policyActions: ['formations:GetFormation'],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  projectId = setup.projectId;

  const secretRes = await client()
    .post('/api/v1/secrets')
    .send({ project_id: projectId, name: 'fmlife-secret', value: 'sk-1' });
  expect(secretRes.status).toBe(201);
  secretId = secretRes.body.id;

  const providerRes = await client().post('/api/v1/ai-providers').send({
    project_id: projectId,
    name: 'fmlife-provider',
    provider: 'ollama',
    default_model: 'llama3.2',
  });
  expect(providerRes.status).toBe(201);
  aiProviderId = providerRes.body.id;

  const agentRes = await client().post('/api/v1/agents').send({
    project_id: projectId,
    ai_provider_id: aiProviderId,
    name: 'fmlife-agent',
  });
  expect(agentRes.status).toBe(201);
  agentId = agentRes.body.id;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PUT /api/v1/formations/:formation_id — a changed declaration updates the resource', () => {
  test('an ai_provider takes a secret and clears its optional fields', async () => {
    const declare = (properties: Record<string, unknown>) => {
      return { resources: { Provider: { type: 'ai_provider', properties } } };
    };
    const created = await createFormation(
      declare({
        name: 'fmlife-upd-provider',
        provider: 'ollama',
        default_model: 'llama3.2',
        base_url: 'http://localhost:11434',
      })
    );

    const res = await updateFormation(created.body.id, {
      template: declare({
        name: 'fmlife-upd-provider-v2',
        provider: 'ollama',
        default_model: 'llama3.1',
        secret_id: secretId,
        base_url: null,
        config: null,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    const provider = await client().get(
      `/api/v1/ai-providers/${physicalIdOf(res.body, 'Provider')}`
    );
    expect(provider.body).toMatchObject({
      name: 'fmlife-upd-provider-v2',
      default_model: 'llama3.1',
      secret_id: secretId,
    });
    expect(provider.body.base_url ?? null).toBeNull();
  });

  test('an actor takes instructions and an agent link', async () => {
    const declare = (properties: Record<string, unknown>) => {
      return { resources: { Actor: { type: 'actor', properties } } };
    };
    const created = await createFormation(declare({ name: 'fmlife-actor' }));

    const res = await updateFormation(created.body.id, {
      template: declare({
        name: 'fmlife-actor-v2',
        instructions: 'Updated instructions',
        agent_id: agentId,
      }),
    });

    expect(res.body.status).toBe('active');
    const actor = await client().get(
      `/api/v1/actors/${physicalIdOf(res.body, 'Actor')}`
    );
    expect(actor.body).toMatchObject({
      name: 'fmlife-actor-v2',
      instructions: 'Updated instructions',
      agent_id: agentId,
    });
  });

  test('a memory_store clears its description with an explicit null', async () => {
    const declare = (properties: Record<string, unknown>) => {
      return { resources: { Store: { type: 'memory_store', properties } } };
    };
    const created = await createFormation(
      declare({ name: 'fmlife-store', description: 'original' })
    );

    const res = await updateFormation(created.body.id, {
      template: declare({ name: 'fmlife-store-v2', description: null }),
    });

    expect(res.body.status).toBe('active');
    const store = await client().get(
      `/api/v1/memory-stores/${physicalIdOf(res.body, 'Store')}`
    );
    expect(store.body.name).toBe('fmlife-store-v2');
    expect(store.body.description ?? null).toBeNull();
  });

  test('a webhook takes a new description and url', async () => {
    const declare = (properties: Record<string, unknown>) => {
      return { resources: { Hook: { type: 'webhook', properties } } };
    };
    const created = await createFormation(
      declare({
        name: 'fmlife-hook',
        url: 'https://example.com/webhook',
        events: ['memory_store.created'],
      })
    );

    const res = await updateFormation(created.body.id, {
      template: declare({
        name: 'fmlife-hook-v2',
        description: 'Updated description',
        url: 'https://example.com/hook',
        events: ['memory_store.updated'],
      }),
    });

    expect(res.body.status).toBe('active');
    const hook = await client().get(
      `/api/v1/webhooks/${physicalIdOf(res.body, 'Hook')}`
    );
    expect(hook.body).toMatchObject({
      name: 'fmlife-hook-v2',
      description: 'Updated description',
      url: 'https://example.com/hook',
      events: ['memory_store.updated'],
    });
  });

  test('a memory removed out of band fails the update that changes it', async () => {
    const declare = (content: string) => {
      return {
        resources: {
          Store: { type: 'memory_store', properties: { name: 'fmlife-ms' } },
          Note: {
            type: 'memory',
            properties: { memory_store_id: { ref: 'Store' }, content },
          },
        },
      };
    };
    const created = await createFormation(declare('first'));
    const memoryId = physicalIdOf(created.body, 'Note');
    const deleted = await client().delete(`/api/v1/memories/${memoryId}`);
    expect(deleted.status).toBe(204);

    const res = await updateFormation(created.body.id, {
      template: declare('second'),
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.error.message).toBe(`Memory not found: ${memoryId}`);
  });
});

describe('PUT /api/v1/formations/:formation_id — a resource the template drops', () => {
  test('is deleted', async () => {
    const created = await createFormation({
      resources: {
        Keep: { type: 'memory_store', properties: { name: 'fmlife-keep' } },
        Drop: { type: 'memory_store', properties: { name: 'fmlife-drop' } },
      },
    });
    const dropId = physicalIdOf(created.body, 'Drop');

    const res = await updateFormation(created.body.id, {
      template: {
        resources: {
          Keep: { type: 'memory_store', properties: { name: 'fmlife-keep' } },
        },
      },
    });

    expect(res.body.status).toBe('active');
    const store = await client().get(`/api/v1/memory-stores/${dropId}`);
    expect(store.status).toBe(404);
  });

  test('survives when its deletion_policy is retain', async () => {
    const created = await createFormation({
      resources: {
        Keep: { type: 'memory_store', properties: { name: 'fmlife-keep-2' } },
        Kept: {
          type: 'memory_store',
          properties: { name: 'fmlife-retained' },
          deletion_policy: 'retain',
        },
      },
    });
    const keptId = physicalIdOf(created.body, 'Kept');

    const res = await updateFormation(created.body.id, {
      template: {
        resources: {
          Keep: { type: 'memory_store', properties: { name: 'fmlife-keep-2' } },
        },
      },
    });

    expect(res.body.status).toBe('active');
    expect(await latestOperationEvents(res.body.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_id: 'Kept',
          action: 'delete',
          status: 'succeeded',
        }),
      ])
    );
    const store = await client().get(`/api/v1/memory-stores/${keptId}`);
    expect(store.status).toBe(200);
  });

  test('already deleted out of band counts as deleted', async () => {
    const created = await createFormation({
      resources: {
        Keep: { type: 'memory_store', properties: { name: 'fmlife-keep-3' } },
        Chat: {
          type: 'chat',
          properties: { name: 'fmlife-chat', ai_provider_id: aiProviderId },
        },
      },
    });
    const chatId = physicalIdOf(created.body, 'Chat');
    const deleted = await client().delete(`/api/v1/chats/${chatId}`);
    expect(deleted.status).toBe(204);

    const res = await updateFormation(created.body.id, {
      template: {
        resources: {
          Keep: { type: 'memory_store', properties: { name: 'fmlife-keep-3' } },
        },
      },
    });

    expect(res.body.status).toBe('active');
    expect(res.body.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ logical_id: 'Chat', status: 'deleted' }),
      ])
    );
    expect(await latestOperationEvents(res.body.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_id: 'Chat',
          action: 'delete',
          status: 'succeeded',
          physical_resource_id: chatId,
        }),
      ])
    );
  });
});

describe('PUT /api/v1/formations/:formation_id — outputs of a stored template', () => {
  // The write path refuses each of these output shapes, so only a template
  // stored before a rule existed holds one, and a re-deploy without a new
  // template resolves that stored template. The row is seeded directly because
  // no route can store it.
  test('resolves the outputs it can and skips the ones it must not', async () => {
    const created = await createFormation({
      resources: {
        Hook: {
          type: 'webhook',
          properties: {
            name: 'fmlife-out-hook',
            url: 'https://example.com/out',
            events: ['*'],
          },
        },
      },
      outputs: { hookId: { ref: 'Hook' } },
    });
    const hookId = physicalIdOf(created.body, 'Hook');

    const row = await db.Formation.findOne({
      where: { publicId: created.body.id },
    });
    await row!.update({
      template: {
        ...row!.template,
        outputs: {
          hookId: { ref: 'Hook' },
          literal: 'plain',
          count: 5,
          hookSecret: { ref_attr: 'Hook.secret' },
          noDot: { ref_attr: 'HookSecret' },
          ghost: { ref_attr: 'Ghost.secret' },
        },
      },
    });

    const res = await updateFormation(created.body.id, {
      metadata: { redeployed: 'yes' },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.outputs).toEqual({ hookId, literal: 'plain' });
  });
});

describe('POST /api/v1/formations/plan — a ref to a resource not yet created', () => {
  test('stays unresolved in the desired properties', async () => {
    const res = await client()
      .post('/api/v1/formations/plan')
      .send({
        project_id: projectId,
        template: {
          resources: {
            Provider: {
              type: 'ai_provider',
              properties: {
                name: 'fmlife-plan-provider',
                provider: 'ollama',
                default_model: 'llama3.2',
              },
            },
            Agent: {
              type: 'agent',
              properties: {
                name: 'fmlife-plan-agent',
                ai_provider_id: { ref: 'Provider' },
              },
            },
          },
        },
      });

    expect(res.status).toBe(200);
    const agent = res.body.changes.find((change: { logical_id: string }) => {
      return change.logical_id === 'Agent';
    });
    expect(agent).toEqual({
      logical_id: 'Agent',
      resource_type: 'agent',
      action: 'create',
      diff: {
        desired: {
          name: 'fmlife-plan-agent',
          ai_provider_id: { ref: 'Provider' },
        },
        current: null,
      },
    });
  });
});

describe('POST /api/v1/formations — a deploy that fails partway', () => {
  const failingTemplate = {
    resources: {
      Store: { type: 'memory_store', properties: { name: 'fmlife-unwind' } },
      Broken: {
        type: 'agent',
        properties: {
          name: { sub: 'fmlife-broken-${Store}' },
          ai_provider_id: 'aip_doesnotexist0000',
        },
      },
    },
  };

  test('unwinds the resources it created', async () => {
    const res = await createFormation(failingTemplate);

    expect(res.body.status).toBe('failed');
    const storeId = physicalIdOf(res.body, 'Store');
    expect(res.body.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ logical_id: 'Store', status: 'deleted' }),
      ])
    );
    const store = await client().get(`/api/v1/memory-stores/${storeId}`);
    expect(store.status).toBe(404);
  });

  test('leaves a retained resource in place', async () => {
    const res = await createFormation({
      resources: {
        Store: {
          type: 'memory_store',
          properties: { name: 'fmlife-unwind-retained' },
          deletion_policy: 'retain',
        },
        Broken: failingTemplate.resources.Broken,
      },
    });

    expect(res.body.status).toBe('failed');
    const storeId = physicalIdOf(res.body, 'Store');
    expect(await latestOperationEvents(res.body.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_id: 'Store',
          action: 'rollback-skipped',
          status: 'succeeded',
          physical_resource_id: storeId,
        }),
      ])
    );
    const store = await client().get(`/api/v1/memory-stores/${storeId}`);
    expect(store.status).toBe(200);
  });

  test('an unwind that finds the resource already gone counts it as unwound', async () => {
    // Every module's delete runs against the real database; this one rejection
    // stands in for a resource removed between its create and the unwind.
    jest
      .spyOn(memoryStoresFormationModule, 'delete')
      .mockRejectedValueOnce(
        new DomainError('RESOURCE_NOT_FOUND', 'Memory store not found.')
      );

    const res = await createFormation(failingTemplate);

    expect(res.body.status).toBe('failed');
    expect(await latestOperationEvents(res.body.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_id: 'Store',
          action: 'rollback',
          status: 'succeeded',
        }),
      ])
    );
    expect(res.body.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ logical_id: 'Store', status: 'deleted' }),
      ])
    );
  });
});

describe('POST /api/v1/formations/validate — actor declarations', () => {
  test('refuses an actor linked to both an agent and a chat', async () => {
    const res = await client()
      .post('/api/v1/formations/validate')
      .send({
        template: {
          resources: {
            Actor: {
              type: 'actor',
              properties: {
                name: 'fmlife-both',
                agent_id: agentId,
                chat_id: 'cht_placeholder00000',
              },
            },
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'resources.Actor.properties' }),
      ])
    );
  });
});

describe('POST /api/v1/formations/validate — a non-object properties bag', () => {
  test('is one error and no warning, even for a type that declares warnings', async () => {
    const res = await client()
      .post('/api/v1/formations/validate')
      .send({
        template: { resources: { Tool: { type: 'tool', properties: 'nope' } } },
      });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.warnings).toEqual([]);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'resources.Tool.properties' }),
      ])
    );
  });
});

describe('POST /api/v1/formations — actor declarations', () => {
  test('a blank actor name fails the deploy naming the field', async () => {
    const res = await createFormation({
      resources: { Actor: { type: 'actor', properties: { name: '   ' } } },
    });

    expect(res.body.status).toBe('failed');
    expect(res.body.error.message).toBe(
      "Actor field 'name' must be a non-empty string"
    );
  });
});
