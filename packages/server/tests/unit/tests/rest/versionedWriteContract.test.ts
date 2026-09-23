import type { Test } from 'supertest';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { VERSIONED_RESOURCES } from '../../fixtures/versionedResources';
import { authenticatedTestClient } from '../../testClient';

/**
 * Every versioned resource claims its counter through one engine
 * (`resourceVersionStore.ts`), so a write response that disagrees with the
 * read after it is a defect in all of them at once. Each write here must answer
 * the `version` and `updated_at` the next `GET` returns, bump the version by
 * exactly one, and, where the resource archives its config, add exactly one
 * history row.
 */

type Write = { name: string; send: (id: string) => Test };

type Driver = {
  path: string;
  /** Whether the resource keeps a `/versions` history. */
  archived: boolean;
  create: () => Promise<string>;
  /** Applied in order to one freshly created resource. */
  writes: Write[];
};

describe('versioned write contract', () => {
  let userToken: string;
  let projectId: string;
  let aiProviderId: string;

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  const createIn = async (path: string, body: Record<string, unknown>) => {
    const res = await client().post(path).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const restore = (path: string, version: number): Write['send'] => {
    return (id) => {
      return client()
        .post(`${path}/${id}/versions/${version}/restore`)
        .send({});
    };
  };

  const drivers: Record<string, Driver> = {
    'Agent.ts': {
      path: '/api/v1/agents',
      archived: true,
      create: () => {
        return createIn('/api/v1/agents', {
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'Contract Agent',
        });
      },
      writes: [
        {
          name: 'updateAgent',
          send: (id) => {
            return client()
              .put(`/api/v1/agents/${id}`)
              .send({ instructions: 'second' });
          },
        },
        {
          name: 'restoreAgentVersion',
          send: restore('/api/v1/agents', 1),
        },
      ],
    },
    'Guardrail.ts': {
      path: '/api/v1/guardrails',
      archived: true,
      create: () => {
        return createIn('/api/v1/guardrails', {
          project_id: projectId,
          name: 'Contract Guardrail',
          document: { class: 'C' },
        });
      },
      writes: [
        {
          name: 'updateGuardrail',
          send: (id) => {
            return client()
              .patch(`/api/v1/guardrails/${id}`)
              .send({ document: { class: 'B' } });
          },
        },
        {
          name: 'restoreGuardrailVersion',
          send: restore('/api/v1/guardrails', 1),
        },
      ],
    },
    'Orchestration.ts': {
      path: '/api/v1/orchestrations',
      archived: true,
      create: () => {
        return createIn('/api/v1/orchestrations', {
          project_id: projectId,
          name: 'Contract Orchestration',
          nodes: [{ id: 'a', type: 'transform', expression: 'v1' }],
          edges: [],
        });
      },
      writes: [
        {
          name: 'updateOrchestration',
          send: (id) => {
            return client()
              .patch(`/api/v1/orchestrations/${id}`)
              .send({
                nodes: [{ id: 'a', type: 'transform', expression: 'v2' }],
                edges: [],
              });
          },
        },
        {
          name: 'restoreOrchestrationVersion',
          send: restore('/api/v1/orchestrations', 1),
        },
      ],
    },
    'Workflow.ts': {
      path: '/api/v1/workflows',
      archived: true,
      create: () => {
        return createIn('/api/v1/workflows', {
          project_id: projectId,
          name: 'contract-workflow',
          states: [
            { name: 'triage', initial: true },
            { name: 'done', terminal: true },
          ],
          transitions: [{ name: 'finish', from: ['triage'], to: 'done' }],
        });
      },
      writes: [
        {
          name: 'updateWorkflow',
          send: (id) => {
            return client()
              .patch(`/api/v1/workflows/${id}`)
              .send({ payload_schema: { type: 'object' } });
          },
        },
        {
          name: 'restoreWorkflowVersion',
          send: restore('/api/v1/workflows', 1),
        },
      ],
    },
    'Document.ts': {
      path: '/api/v1/documents',
      archived: true,
      create: () => {
        return createIn('/api/v1/documents', {
          project_id: projectId,
          content: 'First state.',
          filename: 'contract.txt',
          path: '/contract/doc.txt',
        });
      },
      writes: [
        {
          name: 'updateDocument',
          send: (id) => {
            return client()
              .patch(`/api/v1/documents/${id}`)
              .send({ content: 'Second state.' });
          },
        },
        {
          name: 'withdrawDocument',
          send: (id) => {
            return client().post(`/api/v1/documents/${id}/withdraw`).send({});
          },
        },
        {
          name: 'restoreDocumentVersion',
          send: restore('/api/v1/documents', 2),
        },
      ],
    },
    // A memory keeps no archived config, so only the counter is checked.
    'Memory.ts': {
      path: '/api/v1/memories',
      archived: false,
      create: async () => {
        const storeId = await createIn('/api/v1/memory-stores', {
          project_id: projectId,
          name: 'Contract Store',
        });
        return createIn('/api/v1/memories', {
          memory_store_id: storeId,
          content: 'The office is in Lisbon',
        });
      },
      writes: [
        {
          name: 'updateMemory',
          send: (id) => {
            return client()
              .put(`/api/v1/memories/${id}`)
              .send({ content: 'The office is in Porto' });
          },
        },
        {
          name: 'retractMemory',
          send: (id) => {
            return client().post(`/api/v1/memories/${id}/retract`).send({});
          },
        },
      ],
    },
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'verwrite',
      policyActions: [
        'agents:*',
        'guardrails:*',
        'orchestrations:*',
        'workflows:*',
        'documents:*',
        'memories:*',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Contract Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    expect(provider.status).toBe(201);
    aiProviderId = provider.body.id;
  }, 60_000);

  test('every versioned resource has a driver for each of its writes', () => {
    expect(Object.keys(drivers).sort()).toEqual(
      Object.keys(VERSIONED_RESOURCES).sort()
    );
    for (const [model, sites] of Object.entries(VERSIONED_RESOURCES)) {
      const driven = drivers[model].writes.map((write) => {
        return write.name;
      });
      expect({ model, driven }).toEqual({
        model,
        driven: expect.arrayContaining(
          sites.map((site) => {
            return site.update;
          })
        ),
      });
    }
  });

  const readState = async (driver: Driver, id: string) => {
    const res = await client().get(`${driver.path}/${id}`);
    expect(res.status).toBe(200);
    const history = driver.archived
      ? await client().get(`${driver.path}/${id}/versions`)
      : undefined;
    if (history) expect(history.status).toBe(200);
    return {
      version: res.body.version as number,
      updated_at: res.body.updated_at as string,
      history: history ? (history.body.data as unknown[]).length : undefined,
    };
  };

  test.each(Object.keys(VERSIONED_RESOURCES).sort())(
    '%s: each write answers what the next read returns',
    async (model) => {
      const driver = drivers[model];
      const id = await driver.create();
      let previous = await readState(driver, id);

      for (const write of driver.writes) {
        const res = await write.send(id);
        expect({ write: write.name, status: res.status }).toEqual({
          write: write.name,
          status: 200,
        });

        const current = await readState(driver, id);
        expect({
          write: write.name,
          version: res.body.version,
          updated_at: res.body.updated_at,
        }).toEqual({
          write: write.name,
          version: current.version,
          updated_at: current.updated_at,
        });
        expect({ write: write.name, version: current.version }).toEqual({
          write: write.name,
          version: previous.version + 1,
        });
        if (driver.archived) {
          expect({ write: write.name, history: current.history }).toEqual({
            write: write.name,
            history: (previous.history as number) + 1,
          });
        }
        previous = current;
      }
    }
  );
});
