import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A resource definition is a caller-written document: its nested objects read
 * back, and restore from a version, with their keys in the order written. Each
 * object below lists its keys longest first, the reverse of the order `JSONB`
 * stores them in.
 */

type Definition = {
  path: string;
  create: () => Record<string, unknown>;
  /** A write that changes the definition, so version 1 differs from the head. */
  change: { method: 'put' | 'patch'; body: Record<string, unknown> };
  /** The nested value whose key order is checked. */
  read: (body: Record<string, unknown>) => unknown;
};

const SCHEMA = {
  type: 'object',
  properties: {
    priority: { type: 'string' },
    title: { type: 'string' },
    id: { type: 'string' },
  },
};

const keyOrder = (value: unknown): string => {
  return JSON.stringify(value);
};

describe('definition key order', () => {
  let token: string;
  let projectId: string;
  let aiProviderId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'keyorder',
      policyActions: [
        'agents:*',
        'guardrails:*',
        'orchestrations:*',
        'workflows:*',
      ],
    });
    token = setup.userToken;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Key Order Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    expect(provider.status).toBe(201);
    aiProviderId = provider.body.id;
  }, 60_000);

  const definitions: Record<string, Definition> = {
    agents: {
      path: '/api/v1/agents',
      create: () => {
        return {
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'Key Order Agent',
          boundary_policy: {
            statement: [
              {
                resource: ['*'],
                effect: 'Allow',
                action: ['memories:ListMemories'],
              },
            ],
          },
        };
      },
      change: { method: 'put', body: { boundary_policy: null } },
      read: (body) => {
        return body.boundary_policy;
      },
    },
    guardrails: {
      path: '/api/v1/guardrails',
      create: () => {
        return {
          project_id: projectId,
          name: 'Key Order Guardrail',
          document: { default_class: 'C', escalate: false, class: 'B' },
        };
      },
      change: { method: 'patch', body: { document: { class: 'B' } } },
      read: (body) => {
        return body.document;
      },
    },
    orchestrations: {
      path: '/api/v1/orchestrations',
      create: () => {
        return {
          project_id: projectId,
          name: 'Key Order Orchestration',
          nodes: [{ id: 'a', type: 'transform', expression: 'v1' }],
          edges: [],
          input_schema: SCHEMA,
        };
      },
      change: { method: 'patch', body: { input_schema: { type: 'object' } } },
      read: (body) => {
        return body.input_schema;
      },
    },
    workflows: {
      path: '/api/v1/workflows',
      create: () => {
        return {
          project_id: projectId,
          name: 'key-order-workflow',
          states: [
            { name: 'triage', initial: true },
            { name: 'done', terminal: true },
          ],
          transitions: [{ name: 'finish', from: ['triage'], to: 'done' }],
          payload_schema: SCHEMA,
        };
      },
      change: { method: 'patch', body: { payload_schema: { type: 'object' } } },
      read: (body) => {
        return body.payload_schema;
      },
    },
  };

  describe.each(Object.entries(definitions))('%s', (_name, definition) => {
    test('reads back, and restores from a version, in the order written', async () => {
      const client = () => {
        return authenticatedTestClient(token);
      };
      const body = definition.create();
      const written = keyOrder(definition.read(body));

      const created = await client().post(definition.path).send(body);
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      const read = await client().get(`${definition.path}/${id}`);
      expect(read.status).toBe(200);
      expect(keyOrder(definition.read(read.body))).toBe(written);

      const changed = await client()
        [definition.change.method](`${definition.path}/${id}`)
        .send(definition.change.body);
      expect(changed.status).toBe(200);
      expect(keyOrder(definition.read(changed.body))).not.toBe(written);

      const restored = await client()
        .post(`${definition.path}/${id}/versions/1/restore`)
        .send({});
      expect(restored.status).toBe(200);

      const after = await client().get(`${definition.path}/${id}`);
      expect(keyOrder(definition.read(after.body))).toBe(written);
    });
  });
});
