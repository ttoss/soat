import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

let adminToken: string;
let projectId: string;
let formationCounter = 0;

const client = () => {
  return authenticatedTestClient(adminToken);
};

let folderCounter = 0;

/** Documents share the project's path space, so each template takes its own folder. */
const docs = (entries: Record<string, string>, folder?: string) => {
  folderCounter += 1;
  const root = folder ?? `kb-${String(folderCounter)}`;
  return {
    resources: {
      Docs: {
        type: 'document',
        for_each: entries,
        properties: {
          path: { sub: `/${root}/\${each.key}` },
          content: { each: 'value' },
        },
      },
    },
  };
};

type FormationResourceWire = {
  logical_id: string;
  physical_resource_id: string;
  status: string;
};

const physicalIds = (resources: FormationResourceWire[]) => {
  return Object.fromEntries(
    resources
      .filter((r) => {
        return r.status !== 'deleted';
      })
      .map((r) => {
        return [r.logical_id, r.physical_resource_id];
      })
  );
};

const createFormation = async (template: unknown) => {
  formationCounter += 1;
  const res = await client()
    .post('/api/v1/formations')
    .send({
      project_id: projectId,
      name: `for-each-${String(formationCounter)}`,
      template,
    });
  expect({ status: res.status, error: res.body.error }).toEqual({
    status: 201,
    error: null,
  });
  expect(res.body.status).toBe('active');
  return res.body;
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

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'foreach',
    policyActions: ['formations:GetFormation'],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  projectId = setup.projectId;
});

describe('POST /api/v1/formations with for_each', () => {
  test('creates one resource per entry, keyed by the entry', async () => {
    const formation = await createFormation(
      docs({ 'guide/start.md': 'Start here.', 'faq.md': 'Questions.' }, 'kb')
    );

    const ids = physicalIds(formation.resources);
    expect(Object.keys(ids).sort()).toEqual([
      'Docs[faq.md]',
      'Docs[guide/start.md]',
    ]);

    const doc = await client().get(
      `/api/v1/documents/${ids['Docs[guide/start.md]']}`
    );
    expect(doc.status).toBe(200);
    expect(doc.body.path).toBe('/kb/guide/start.md');
    expect(doc.body.content).toBe('Start here.');
  });

  test('stores the expanded template', async () => {
    const formation = await createFormation(docs({ 'a.md': 'A' }, 'stored'));

    expect(formation.template.resources).toEqual({
      'Docs[a.md]': {
        type: 'document',
        properties: { path: { sub: '/stored/a.md' }, content: 'A' },
      },
    });
  });

  test('an empty map declares nothing', async () => {
    const formation = await createFormation({
      resources: {
        Docs: {
          type: 'document',
          for_each: {},
          properties: { content: { each: 'value' } },
        },
      },
    });

    expect(formation.resources).toEqual([]);
  });

  test('depends_on naming the group waits on every instance', async () => {
    const formation = await createFormation({
      resources: {
        ...docs({ 'a.md': 'A', 'b.md': 'B' }).resources,
        Index: {
          type: 'document',
          depends_on: ['Docs'],
          properties: { path: '/index.md', content: 'Index' },
        },
      },
    });

    expect(formation.template.resources.Index.depends_on).toEqual([
      'Docs[a.md]',
      'Docs[b.md]',
    ]);
  });
});

describe('PUT /api/v1/formations/:formation_id with for_each', () => {
  test('touches only the entries that changed', async () => {
    const formation = await createFormation(
      docs({ 'keep.md': 'Same', 'edit.md': 'Old', 'drop.md': 'Gone' }, 'upd')
    );
    const before = physicalIds(formation.resources);

    const res = await client()
      .put(`/api/v1/formations/${formation.id}`)
      .send({
        template: docs(
          { 'keep.md': 'Same', 'edit.md': 'New', 'add.md': 'Hi' },
          'upd'
        ),
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');

    const after = physicalIds(res.body.resources);
    expect(Object.keys(after).sort()).toEqual([
      'Docs[add.md]',
      'Docs[edit.md]',
      'Docs[keep.md]',
    ]);
    expect(after['Docs[keep.md]']).toBe(before['Docs[keep.md]']);

    const events = await client().get(
      `/api/v1/formations/${formation.id}/events`
    );
    const latest = events.body.data[events.body.data.length - 1].events as {
      logical_id: string;
      action: string;
    }[];
    const touched = Object.fromEntries(
      latest.map((e) => {
        return [e.logical_id, e.action];
      })
    );
    expect(touched['Docs[keep.md]']).toBe('no-op');
    expect(touched['Docs[edit.md]']).toBe('update');
    expect(touched['Docs[add.md]']).toBe('create');
    expect(touched['Docs[drop.md]']).toBe('delete');

    const dropped = await client().get(
      `/api/v1/documents/${before['Docs[drop.md]']}`
    );
    expect(dropped.status).toBe(404);
  });
});

describe('POST /api/v1/formations/validate with for_each', () => {
  test('an instance is addressable by ref and ref_attr', async () => {
    const result = await validate({
      ...docs({ 'a.md': 'A' }),
      outputs: {
        Id: { ref: 'Docs[a.md]' },
        Path: { ref_attr: 'Docs[a.md].path' },
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test.each([
    ['a list', ['a.md'], 'must be an object'],
    ['a key with a bracket', { 'a]b': 'x' }, "'a]b'"],
    ['an empty key', { '': 'x' }, 'empty'],
  ])('refuses for_each given %s', async (_label, forEach, message) => {
    const result = await validate({
      resources: {
        Docs: {
          type: 'document',
          for_each: forEach,
          properties: { content: { each: 'value' } },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'resources.Docs.for_each',
          message: expect.stringContaining(message),
        }),
      ])
    );
  });

  test('refuses an instance id another resource already uses', async () => {
    const result = await validate({
      resources: {
        ...docs({ 'a.md': 'A' }).resources,
        'Docs[a.md]': { type: 'document', properties: { content: 'B' } },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'resources.Docs.for_each',
          message: expect.stringContaining("'Docs[a.md]'"),
        }),
      ])
    );
  });

  test('refuses ${each.value} in a sub when a value is not text', async () => {
    const result = await validate({
      resources: {
        Docs: {
          type: 'document',
          for_each: { 'a.md': { title: 'A' } },
          properties: { content: { sub: 'x ${each.value}' } },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'resources.Docs.for_each' }),
      ])
    );
  });

  test('refuses an each expression naming neither key nor value', async () => {
    const result = await validate({
      resources: {
        Docs: {
          type: 'document',
          for_each: { 'a.md': 'A' },
          properties: { content: { each: 'title' } },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'resources.Docs.for_each' }),
      ])
    );
  });

  test.each([
    ['an each object', { each: 'key' }],
    ['an each token', { sub: '/kb/${each.key}' }],
  ])('refuses %s outside a for_each resource', async (_label, content) => {
    const result = await validate({
      resources: { Doc: { type: 'document', properties: { content } } },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'resources.Doc.properties',
          message: expect.stringContaining('for_each'),
        }),
      ])
    );
  });
});
