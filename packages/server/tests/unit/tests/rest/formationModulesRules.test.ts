import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// The rules each built-in formation module adds on top of its schema: what a
// template may declare, what an apply refuses, and how a resource that went
// missing out of band reads back.

let adminToken: string;
let projectId: string;
let aiProviderId: string;
let agentId: string;
let converterToolId: string;
let datasetId: string;
let counter = 0;

const client = () => {
  return authenticatedTestClient(adminToken);
};

const seed = (): string => {
  counter += 1;
  return `r${String(counter)}`;
};

const one = (type: string, properties: unknown) => {
  return { resources: { Res: { type, properties } } };
};

const validate = async (template: unknown) => {
  const res = await client()
    .post('/api/v1/formations/validate')
    .send({ template });
  expect(res.status).toBe(200);
  return res.body as {
    valid: boolean;
    errors: { path: string; message: string }[];
  };
};

const deploy = async (
  template: unknown,
  parameters?: Record<string, string>
) => {
  const res = await client()
    .post('/api/v1/formations')
    .send({
      project_id: projectId,
      name: `rules-${seed()}`,
      template,
      ...(parameters ? { parameters } : {}),
    });
  expect(res.status).toBe(201);
  return res.body;
};

const redeploy = async (formationId: string, template: unknown) => {
  const res = await client()
    .put(`/api/v1/formations/${formationId}`)
    .send({ template });
  expect(res.status).toBe(200);
  return res.body;
};

const physicalIdOf = (
  formation: {
    resources: { logical_id: string; physical_resource_id: string }[];
  },
  logicalId = 'Res'
): string => {
  const resource = formation.resources.find((r) => {
    return r.logical_id === logicalId;
  });
  if (!resource) throw new Error(`no resource ${logicalId}`);
  return resource.physical_resource_id;
};

const planOne = async (formationId: string, template: unknown) => {
  const res = await client().post('/api/v1/formations/plan').send({
    project_id: projectId,
    formation_id: formationId,
    template,
  });
  expect(res.status).toBe(200);
  return res.body.changes[0];
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'fmrules',
    policyActions: ['formations:GetFormation'],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  projectId = setup.projectId;

  const providerRes = await client().post('/api/v1/ai-providers').send({
    project_id: projectId,
    name: 'Rules Provider',
    provider: 'openai',
    default_model: 'gpt-4o',
  });
  aiProviderId = providerRes.body.id;

  const agentRes = await client().post('/api/v1/agents').send({
    project_id: projectId,
    ai_provider_id: aiProviderId,
    name: 'Rules Agent',
  });
  agentId = agentRes.body.id;

  const toolRes = await client()
    .post('/api/v1/tools')
    .send({
      project_id: projectId,
      name: 'rules-converter',
      type: 'builtin',
      description: 'converter tool',
      actions: ['list-tools'],
    });
  converterToolId = toolRes.body.id;

  const datasetRes = await client()
    .post('/api/v1/datasets')
    .send({ project_id: projectId, name: 'Rules Suite' });
  datasetId = datasetRes.body.id;
});

describe('POST /api/v1/formations/validate — a non-object properties bag', () => {
  // resourceType → the "must be an object" message the module itself reports.
  const NON_OBJECT: Array<[string, string]> = [
    ['api_key', 'API key `properties` must be an object'],
    ['webhook', 'Webhook `properties` must be an object'],
    ['trigger', 'Trigger `properties` must be an object'],
    ['memory', 'Memory `properties` must be an object'],
    ['chat', 'Chat `properties` must be an object'],
    ['conversation', 'Conversation `properties` must be an object'],
    ['file', 'File `properties` must be an object'],
    ['policy', 'Policy `properties` must be an object'],
    ['project_price', 'Project price `properties` must be an object'],
    ['quota', 'Quota `properties` must be an object'],
    ['secret', 'Secret `properties` must be an object'],
    ['session', 'Session `properties` must be an object'],
    ['ingestion_rule', 'Ingestion rule `properties` must be an object'],
    ['memory_rule', 'Memory rule `properties` must be an object'],
    ['agent', 'Agent `properties` must be an object'],
    ['memory_store', 'Memory store `properties` must be an object'],
    ['orchestration', 'Orchestration `properties` must be an object'],
    ['ai_provider', 'AI provider `properties` must be an object'],
    ['actor', 'Actor `properties` must be an object'],
    ['tool', 'Tool `properties` must be an object'],
    ['document', 'Document `properties` must be an object'],
    ['workflow', 'Workflow `properties` must be an object'],
    ['guardrail', 'Guardrail `properties` must be an object'],
    ['model_route', 'Model route `properties` must be an object'],
    ['dataset', 'Dataset `properties` must be an object'],
    ['dataset_item', 'DatasetItem `properties` must be an object'],
    ['eval', 'Eval `properties` must be an object'],
  ];

  test.each(NON_OBJECT)('%s names its own type', async (type, message) => {
    const result = await validate(one(type, null));

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([{ path: 'resources.Res.properties', message }])
    );
  });
});

describe('POST /api/v1/formations/validate — module rules', () => {
  // Factories, so fixture ids set in `beforeAll` are read at test time.
  const RULES: Array<{
    name: string;
    template: () => unknown;
    message: RegExp;
  }> = [
    {
      name: 'a camelCase unknown key is reported in snake_case (memory_store)',
      template: () => {
        return one('memory_store', { name: 'Mem', someUnknownKey: 'y' });
      },
      message: /some_unknown_key/,
    },
    {
      name: 'a camelCase unknown key is reported in snake_case (document)',
      template: () => {
        return one('document', { content: 'hi', someUnknownKey: 'y' });
      },
      message: /some_unknown_key/,
    },
    {
      name: 'a camelCase unknown key is reported in snake_case (webhook)',
      template: () => {
        return one('webhook', {
          webhookUrl: 'http://example.com',
          events: ['*'],
          name: 't',
        });
      },
      message: /webhook_url/,
    },
    {
      name: 'a secret requires a value',
      template: () => {
        return one('secret', { name: 'no_value' });
      },
      message: /`value` is required/,
    },
    {
      name: 'a project_price requires unit_price',
      template: () => {
        return one('project_price', {
          provider: 'openai',
          model: 'gpt-4o',
          component: 'output_tokens',
          unit: 'token',
        });
      },
      message: /`unit_price` is required/,
    },
    {
      name: 'a guardrail class is one of the literals',
      template: () => {
        return one('guardrail', { name: 'Bad Class', class: 'Z' });
      },
      message: /Guardrail 'class' literal must be one of/,
    },
    {
      name: 'a guardrail escalate is a boolean',
      template: () => {
        return one('guardrail', { name: 'Bad', class: 'A', escalate: 'yes' });
      },
      message: /Guardrail 'escalate' must be a boolean/,
    },
    {
      name: 'a file storage location is system-managed',
      template: () => {
        return one('file', { storage_type: 'local', filename: 'f.txt' });
      },
      message: /Unknown file field 'storage_type'/,
    },
    {
      name: 'cron belongs to a schedule trigger only',
      template: () => {
        return one('trigger', {
          name: 'Bad',
          type: 'manual',
          target_type: 'agent',
          target_id: agentId,
          cron: '0 8 * * *',
        });
      },
      message: /cron is only valid for schedule/i,
    },
    {
      name: 'a schedule trigger cron parses',
      template: () => {
        return one('trigger', {
          name: 'Bad',
          type: 'schedule',
          target_type: 'agent',
          target_id: agentId,
          cron: 'not a cron',
        });
      },
      message: /cron expression must have exactly 5 fields/,
    },
    {
      name: 'an action belongs to a tool target only',
      template: () => {
        return one('trigger', {
          name: 'Bad',
          type: 'manual',
          target_type: 'agent',
          target_id: agentId,
          action: 'do-thing',
        });
      },
      message: /action is only valid for tool/i,
    },
    {
      name: 'an agent declares tool_bindings, not tool_ids',
      template: () => {
        return one('agent', {
          ai_provider_id: aiProviderId,
          tool_ids: [converterToolId],
        });
      },
      message: /tool_ids/,
    },
    {
      name: 'an agent tool binding names a tool resource, not an inline tool',
      template: () => {
        return one('agent', {
          ai_provider_id: aiProviderId,
          tool_bindings: [{ tool: { name: 'inline', type: 'http' } }],
        });
      },
      message: /inline `tool` bindings are not supported/i,
    },
    {
      name: 'an agent boundary_policy names real actions',
      template: () => {
        return one('agent', {
          ai_provider_id: aiProviderId,
          boundary_policy: {
            statement: [{ effect: 'Deny', action: ['bogus:NotARealAction'] }],
          },
        });
      },
      message: /"bogus:NotARealAction" is not a known action/,
    },
    {
      name: 'an agent binds a provider or a route, not both',
      template: () => {
        return one('agent', {
          name: 'Both',
          ai_provider_id: aiProviderId,
          model_route_id: 'route_placeholder000',
        });
      },
      message: /mutually exclusive/,
    },
    {
      name: 'an agent bound to a route takes no model of its own',
      template: () => {
        return one('agent', {
          name: 'Route And Model',
          model_route_id: 'route_placeholder000',
          model: 'gpt-4o-mini',
        });
      },
      message: /each route target names its own model/,
    },
    {
      name: 'a model_route declares only schema fields',
      template: () => {
        return one('model_route', {
          name: 'r',
          targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o' }],
          strategy: 'cheapest',
        });
      },
      message: /strategy/,
    },
    {
      name: 'a model_route has at least one target',
      template: () => {
        return one('model_route', { name: 'r', targets: [] });
      },
      message: /targets must be a non-empty array/,
    },
    {
      name: 'a model_route keeps the REST attempt cap',
      template: () => {
        return one('model_route', {
          name: 'r',
          targets: [
            { ai_provider_id: aiProviderId, model: 'gpt-4o', max_retries: 9 },
            { ai_provider_id: aiProviderId, model: 'gpt-4o-mini' },
          ],
        });
      },
      message: /the maximum is 10/,
    },
    {
      name: 'a model_route retries on known classes only',
      template: () => {
        return one('model_route', {
          name: 'r',
          targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o' }],
          retry_on: ['gremlins'],
        });
      },
      message: /unknown class 'gremlins'/,
    },
    {
      name: 'a model_route failure_threshold is positive',
      template: () => {
        return one('model_route', {
          name: 'r',
          targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o' }],
          failure_threshold: 0,
        });
      },
      message: /failure_threshold must be a positive integer/,
    },
    {
      name: 'an ingestion_rule converter is a tool or an agent, not both',
      template: () => {
        return one('ingestion_rule', {
          content_type_glob: 'image/*',
          tool_id: converterToolId,
          agent_id: agentId,
        });
      },
      message: /tool_id and agent_id are mutually exclusive/,
    },
    {
      name: 'an ingestion_rule names a converter',
      template: () => {
        return one('ingestion_rule', { content_type_glob: 'image/*' });
      },
      message: /exactly one of tool_id or agent_id is required/,
    },
    {
      name: 'an orchestration declares only schema fields',
      template: () => {
        return one('orchestration', {
          name: 'X',
          nodes: [],
          edges: [],
          bogus_field: true,
        });
      },
      message: /bogus_field/,
    },
    {
      name: 'an orchestration requires nodes',
      template: () => {
        return one('orchestration', { name: 'X' });
      },
      message: /`nodes` is required/,
    },
    {
      name: 'an eval declares only schema fields',
      template: () => {
        return one('eval', {
          name: 'Bad Eval',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [],
          bogus_field: true,
        });
      },
      message: /bogus_field/,
    },
    {
      name: 'an eval requires its dataset',
      template: () => {
        return one('eval', { name: 'Incomplete', agent_id: agentId });
      },
      message: /`dataset_id` is required/,
    },
    {
      name: 'a dataset_item requires its parent dataset',
      template: () => {
        return one('dataset_item', { input: [{ role: 'user', content: 'x' }] });
      },
      message: /`dataset_id` is required/,
    },
  ];

  test.each(RULES)('$name', async ({ template, message }) => {
    const result = await validate(template());

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error) => {
        return message.test(error.message);
      })
    ).toBe(true);
  });
});

describe('POST /api/v1/formations — rules only the apply can check', () => {
  const FAILURES: Array<{
    name: string;
    template: () => unknown;
    parameters?: Record<string, string>;
    message: RegExp;
  }> = [
    {
      name: 'a policy document is valid',
      template: () => {
        return one('policy', { document: { statement: 'not an array' } });
      },
      message: /Policy document is invalid/,
    },
    {
      name: 'a model_route target names a provider of this project',
      template: () => {
        return one('model_route', {
          name: `cross-${seed()}`,
          targets: [{ ai_provider_id: 'aip_doesnotexist0', model: 'gpt-4o' }],
        });
      },
      message: /not found in this project/,
    },
    {
      name: 'an agent binds a provider or a route when the project has no default',
      template: () => {
        return one('agent', { name: 'Unbound' });
      },
      message: /binds neither ai_provider_id nor model_route_id/,
    },
    {
      name: 'a parameter substituted into a typed field still has that type',
      template: () => {
        return {
          parameters: { Limit: { type: 'string' } },
          resources: {
            Res: {
              type: 'quota',
              properties: {
                scope: 'project',
                metric: 'tokens',
                window: 'rolling_24h',
                limit: { param: 'Limit' },
              },
            },
          },
        };
      },
      parameters: { Limit: 'lots' },
      message: /limit/,
    },
  ];

  test.each(FAILURES)('$name', async ({ template, parameters, message }) => {
    const formation = await deploy(template(), parameters);

    expect(formation.status).toBe('failed');
    expect(formation.error.message).toMatch(message);
  });
});

describe('PUT /api/v1/formations/:formation_id — rules only the apply can check', () => {
  test('a policy update keeps a valid document', async () => {
    const document = {
      statement: [{ effect: 'Allow', action: ['tools:ListTools'] }],
    };
    const created = await deploy(one('policy', { name: 'Valid', document }));

    const updated = await redeploy(
      created.id,
      one('policy', { name: 'Valid', document: { statement: 'nope' } })
    );

    expect(updated.status).toBe('failed');
    expect(updated.error.message).toMatch(/Policy document is invalid/);
  });

  test('an ingestion_rule switches its converter from a tool to an agent', async () => {
    const glob = `video/${seed()}`;
    const created = await deploy(
      one('ingestion_rule', {
        content_type_glob: glob,
        tool_id: converterToolId,
        action: 'list-tools',
        native_extraction: 'skip',
        file_delivery: 'download_url',
      })
    );
    expect(created.status).toBe('active');
    const read = await planOne(
      created.id,
      one('ingestion_rule', {
        content_type_glob: glob,
        tool_id: converterToolId,
        action: 'list-tools',
        native_extraction: 'skip',
        file_delivery: 'download_url',
      })
    );
    expect(read.diff.current).toMatchObject({
      tool_id: converterToolId,
      native_extraction: 'skip',
      file_delivery: 'download_url',
    });

    const switched = one('ingestion_rule', {
      content_type_glob: glob,
      agent_id: agentId,
      tool_id: null,
    });
    const updated = await redeploy(created.id, switched);

    expect(updated.status).toBe('active');
    const after = await planOne(created.id, switched);
    expect(after.diff.current).toMatchObject({
      agent_id: agentId,
      tool_id: null,
    });
  });

  test('a dataset_item cannot move to another dataset', async () => {
    const otherRes = await client()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: `Other Suite ${seed()}` });
    const item = (dataset: string, content: string) => {
      return one('dataset_item', {
        dataset_id: dataset,
        input: [{ role: 'user', content }],
      });
    };
    const created = await deploy(item(datasetId, 'stays put'));

    const moved = await redeploy(created.id, item(otherRes.body.id, 'moved'));

    // Applying the rest would report success for an apply that left the item
    // in the dataset the template no longer names.
    expect(moved.status).toBe('failed');
    expect(moved.error.message).toMatch(/dataset_id is immutable/);
    const read = await planOne(created.id, item(datasetId, 'stays put'));
    expect(read.diff.current).toMatchObject({
      dataset_id: datasetId,
      input: [{ role: 'user', content: 'stays put' }],
    });
  });
});

describe('POST /api/v1/formations/plan — a resource removed out of band reads as drift', () => {
  const OUT_OF_BAND: Array<{
    name: string;
    route: string;
    template: () => unknown;
  }> = [
    {
      name: 'actor',
      route: 'actors',
      template: () => {
        return one('actor', { name: `Gone ${seed()}` });
      },
    },
    {
      name: 'session',
      route: 'sessions',
      template: () => {
        return one('session', { agent_id: agentId });
      },
    },
    {
      name: 'trigger',
      route: 'triggers',
      template: () => {
        return one('trigger', {
          name: `Gone ${seed()}`,
          type: 'manual',
          target_type: 'agent',
          target_id: agentId,
        });
      },
    },
    {
      name: 'dataset_item',
      route: 'datasets',
      template: () => {
        return one('dataset_item', {
          dataset_id: datasetId,
          input: [{ role: 'user', content: 'gone' }],
        });
      },
    },
    {
      name: 'model_route',
      route: 'model-routes',
      template: () => {
        return one('model_route', {
          name: `gone-${seed()}`,
          targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o' }],
        });
      },
    },
  ];

  test.each(OUT_OF_BAND)('$name', async ({ route, template }) => {
    const declared = template();
    const created = await deploy(declared);
    expect(created.status).toBe('active');
    const physicalId = physicalIdOf(created);
    const deletePath =
      route === 'datasets'
        ? `/api/v1/datasets/${datasetId}/items/${physicalId}`
        : `/api/v1/${route}/${physicalId}`;
    const deleted = await client().delete(deletePath);
    expect(deleted.status).toBe(204);

    const change = await planOne(created.id, declared);

    expect(change.action).toBe('update');
    expect(change.diff.current).toBeNull();
  });
});

describe('PUT /api/v1/formations/:formation_id — write-only and side-effecting types', () => {
  test('a secret is never read back, and a new value updates it in place', async () => {
    const name = `rules_secret_${seed()}`;
    const created = await deploy(one('secret', { name, value: 'v1' }));
    const secretId = physicalIdOf(created);

    const updated = await redeploy(
      created.id,
      one('secret', { name, value: 'v2' })
    );

    expect(updated.status).toBe('active');
    expect(physicalIdOf(updated)).toBe(secretId);
    const change = await planOne(
      created.id,
      one('secret', { name, value: 'v2' })
    );
    // Diffed against the stored snapshot, which never holds the value.
    expect(change.diff.current).toEqual({ name });
  });

  test('a project_price updates its row in place', async () => {
    const declared = {
      provider: 'openai',
      model: `gpt-rules-${seed()}`,
      component: 'output_tokens',
      unit: 'token',
      unit_price: 0.00001,
    };
    const created = await deploy(one('project_price', declared));
    expect(created.status).toBe('active');
    const priceId = physicalIdOf(created);
    const read = await planOne(created.id, one('project_price', declared));
    expect(read.diff.current).toMatchObject({
      ...declared,
      meter_type: 'llm_tokens',
      // Defaults to deploy time so the price is live immediately.
      effective_from: expect.any(String),
    });

    const repriced = { ...declared, unit_price: 0.5 };
    const updated = await redeploy(created.id, one('project_price', repriced));

    expect(updated.status).toBe('active');
    expect(physicalIdOf(updated)).toBe(priceId);
    const after = await planOne(created.id, one('project_price', repriced));
    expect(after.diff.current.unit_price).toBe(0.5);
    // An in-place update writes no new price version.
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    expect(
      await db.PriceBook.count({
        where: { projectId: project!.id, model: declared.model },
      })
    ).toBe(1);
  });

  const chunkCount = async (documentId: string): Promise<number> => {
    const doc = await db.Document.findOne({ where: { publicId: documentId } });
    return db.DocumentChunk.count({ where: { documentId: doc!.id } });
  };

  test('a document is chunked as declared and re-chunked when the strategy changes', async () => {
    const sized = one('document', {
      content: 'd'.repeat(2500),
      chunk_strategy: 'size',
      chunk_size: 1000,
      chunk_overlap: 0,
    });
    const created = await deploy(sized);
    const documentId = physicalIdOf(created);
    // 2500 characters in steps of 1000 with no overlap.
    expect(await chunkCount(documentId)).toBe(3);

    const updated = await redeploy(
      created.id,
      one('document', { content: 'd'.repeat(2500), chunk_strategy: 'whole' })
    );

    expect(updated.status).toBe('active');
    expect(await chunkCount(documentId)).toBe(1);
  });

  test('a document declared in camelCase is chunked the same way', async () => {
    const created = await deploy(
      one('document', {
        content: 'b'.repeat(2500),
        chunkStrategy: 'size',
        chunkSize: 1000,
        chunkOverlap: 0,
      })
    );

    expect(await chunkCount(physicalIdOf(created))).toBe(3);
  });

  test('a document with no strategy is one chunk', async () => {
    const created = await deploy(
      one('document', { content: 'c'.repeat(2500) })
    );

    expect(await chunkCount(physicalIdOf(created))).toBe(1);
  });

  describe.each([
    {
      type: 'trigger',
      declare: (name: string, toolContext?: unknown) => {
        return {
          name,
          type: 'manual',
          target_type: 'agent',
          target_id: agentId,
          ...(toolContext === undefined ? {} : { tool_context: toolContext }),
        };
      },
      stored: async (id: string) => {
        const row = await db.Trigger.findOne({ where: { publicId: id } });
        return row?.toolContext;
      },
    },
    {
      type: 'session',
      declare: (name: string, toolContext?: unknown) => {
        return {
          agent_id: agentId,
          name,
          ...(toolContext === undefined ? {} : { tool_context: toolContext }),
        };
      },
      stored: async (id: string) => {
        const row = await db.Session.findOne({ where: { publicId: id } });
        return row?.toolContext;
      },
    },
  ])('a $type tool_context', ({ type, declare, stored }) => {
    const deployWithContext = async (name: string) => {
      const created = await deploy(
        one(type, declare(name, { tenant: 'acme' }))
      );
      expect(created.status).toBe('active');
      return created;
    };

    test('is stored but never read back', async () => {
      const name = `Context ${seed()}`;
      const created = await deployWithContext(name);

      expect(await stored(physicalIdOf(created))).toEqual({ tenant: 'acme' });
      const change = await planOne(
        created.id,
        one(type, declare(name, { tenant: 'acme' }))
      );
      expect(change.diff.current).not.toHaveProperty('tool_context');
    });

    test('is left alone by an update that omits it', async () => {
      const created = await deployWithContext(`Context ${seed()}`);

      const updated = await redeploy(
        created.id,
        one(type, declare(`Renamed ${seed()}`))
      );

      expect(updated.status).toBe('active');
      expect(await stored(physicalIdOf(created))).toEqual({ tenant: 'acme' });
    });

    test('is cleared by an explicit null', async () => {
      const name = `Context ${seed()}`;
      const created = await deployWithContext(name);

      const updated = await redeploy(
        created.id,
        one(type, declare(name, null))
      );

      expect(updated.status).toBe('active');
      expect(await stored(physicalIdOf(created))).toBeNull();
    });
  });
});

describe('PUT /api/v1/formations/:formation_id — an agent bound to a model route', () => {
  const createRoute = async (): Promise<string> => {
    const res = await client()
      .post('/api/v1/model-routes')
      .send({
        project_id: projectId,
        name: `rules-route-${seed()}`,
        targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o-mini' }],
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  test('round-trips model_route_id', async () => {
    const routeId = await createRoute();
    const declared = one('agent', { name: 'Routed', model_route_id: routeId });
    const created = await deploy(declared);
    expect(created.status).toBe('active');

    const change = await planOne(created.id, declared);

    expect(change.diff.current).toMatchObject({
      model_route_id: routeId,
      ai_provider_id: null,
    });
  });

  test('switches from a pinned provider when the pin is cleared explicitly', async () => {
    const routeId = await createRoute();
    const created = await deploy(
      one('agent', { name: 'Switching', ai_provider_id: aiProviderId })
    );
    const switched = one('agent', {
      name: 'Switching',
      model_route_id: routeId,
      ai_provider_id: null,
    });

    const updated = await redeploy(created.id, switched);

    expect(updated.status).toBe('active');
    const change = await planOne(created.id, switched);
    expect(change.diff.current).toMatchObject({
      model_route_id: routeId,
      ai_provider_id: null,
    });
  });
});

const datasetItem = (content: string, extra: Record<string, unknown> = {}) => {
  return one('dataset_item', {
    dataset_id: datasetId,
    input: [{ role: 'user', content }],
    ...extra,
  });
};

describe('PUT /api/v1/formations/:formation_id — a dataset_item', () => {
  test('a dataset_item restating only some fields keeps the rest', async () => {
    const created = await deploy(
      datasetItem('first', {
        expected_output: 'Paris',
        metadata: { topic: 'geo' },
      })
    );

    const updated = await redeploy(
      created.id,
      datasetItem('second', { expected_output: 'Rome' })
    );

    expect(updated.status).toBe('active');
    const change = await planOne(
      created.id,
      datasetItem('second', { expected_output: 'Rome' })
    );
    expect(change.diff.current).toMatchObject({
      input: [{ role: 'user', content: 'second' }],
      expected_output: 'Rome',
      metadata: { topic: 'geo' },
    });
  });

  test('a dataset_item deleted out of band fails the update that changes it', async () => {
    const created = await deploy(datasetItem('first'));
    const itemId = physicalIdOf(created);
    const deleted = await client().delete(
      `/api/v1/datasets/${datasetId}/items/${itemId}`
    );
    expect(deleted.status).toBe(204);

    const updated = await redeploy(created.id, datasetItem('second'));

    expect(updated.status).toBe('failed');
    expect(updated.error.message).toBe(`Dataset item '${itemId}' not found.`);
  });
});

describe('DELETE /api/v1/formations/:formation_id — a resource already gone', () => {
  test('a dataset_item already gone still tears down', async () => {
    const created = await deploy(datasetItem('first'));
    const itemId = physicalIdOf(created);
    await client().delete(`/api/v1/datasets/${datasetId}/items/${itemId}`);

    const res = await client().delete(`/api/v1/formations/${created.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  test('a file already gone still tears down', async () => {
    const created = await deploy(
      one('file', { filename: `gone-${seed()}.txt` })
    );
    const deleted = await client().delete(
      `/api/v1/files/${physicalIdOf(created)}`
    );
    expect(deleted.status).toBe(204);

    const res = await client().delete(`/api/v1/formations/${created.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

describe('POST /api/v1/formations/validate — declarations resolved only at apply', () => {
  test('an ingestion_rule glob taken from a parameter validates', async () => {
    const result = await validate({
      parameters: { Glob: { type: 'string' } },
      resources: {
        Res: {
          type: 'ingestion_rule',
          properties: {
            content_type_glob: { param: 'Glob' },
            agent_id: agentId,
          },
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe('PUT /api/v1/formations/:formation_id — an explicit null clears a number', () => {
  test('an agent max_steps', async () => {
    const declare = (maxSteps: number | null) => {
      return one('agent', {
        name: `Steps ${seed()}`,
        ai_provider_id: aiProviderId,
        max_steps: maxSteps,
      });
    };
    const created = await deploy(declare(8));

    const cleared = declare(null);
    const updated = await redeploy(created.id, cleared);

    expect(updated.status).toBe('active');
    const change = await planOne(created.id, cleared);
    expect(change.diff.current.max_steps).toBeNull();
  });
});
