import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';
import { getMergedOpenApiSpec } from 'src/lib/openapiSpec';
import { soatTools } from 'src/lib/soatTools';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A resource opts into actor ownership by declaring `actor_id` as an
 * `x-soat-pin` on its listing. Every operation on one of its items, read off
 * the tool catalog, is then held to the pin: another actor's item, or one of
 * no actor, is `404`. A module that opts in without an owner here fails the
 * first test.
 */
type Owner = {
  /** Creates an item of `actorId`, or of no actor; returns its id. */
  create: (actorId?: string) => Promise<string>;
  /** Fills the path's other parameters, given the item's id. */
  path: (template: string, id: string) => string;
  /** Where the item reads back, to show a refused call left it in place. */
  itemPath: (id: string) => string;
  bodies?: Record<string, Record<string, unknown>>;
  queries?: Record<string, Record<string, string>>;
};

const PLAYBOOK_DEFINITION = {
  nodes: [
    {
      id: 'revenue',
      title: 'Annual revenue',
      kind: 'collect',
      final: true,
      inputs: [
        {
          name: 'annual_revenue',
          schema: { type: 'number', minimum: 0 },
          required: true,
          source: 'manual',
        },
      ],
    },
  ],
};

const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/** Each list path whose operation declares an `actor_id` pin. */
const actorPinnedLists = (): Record<string, string> => {
  const lists: Record<string, string> = {};
  for (const [path, item] of Object.entries(getMergedOpenApiSpec().paths)) {
    if (!isRecord(item)) continue;
    const operation = item.get;
    if (!isRecord(operation) || !Array.isArray(operation.parameters)) continue;
    const pinned = operation.parameters.some((parameter) => {
      return (
        isRecord(parameter) &&
        isRecord(parameter['x-soat-pin']) &&
        parameter['x-soat-pin'].field === 'actor_id'
      );
    });
    if (pinned && typeof operation.operationId === 'string') {
      lists[operation.operationId] = path;
    }
  }
  return lists;
};

const itemOperationsOf = (listPath: string) => {
  return soatTools.filter((tool) => {
    return tool.pathTemplate.startsWith(`${listPath}/{`);
  });
};

describe('Actor ownership', () => {
  let adminToken: string;
  let projectId: string;
  let actorA: string;
  let actorB: string;
  let seq = 0;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const created = async (path: string, body: Record<string, unknown>) => {
    const res = await asAdmin().post(path).send(body);
    expect(res.status).toBeLessThan(300);
    return res.body.id as string;
  };

  const OWNERS: Record<string, Owner> = {
    listPlaybookCases: {
      create: async (actorId) => {
        const playbookId = await created('/api/v1/playbooks', {
          project_id: projectId,
          name: `owned-${(seq += 1)}`,
          definition: PLAYBOOK_DEFINITION,
        });
        return created(`/api/v1/playbooks/${playbookId}/cases`, {
          subject: `client-${seq}`,
          ...(actorId ? { actor_id: actorId } : {}),
        });
      },
      path: (template, id) => {
        return template
          .replace('{case_id}', id)
          .replace('{node}', 'revenue')
          .replace(/\{[a-z_]+\}/g, 'x_doesNotExist');
      },
      itemPath: (id) => {
        return `/api/v1/playbook-cases/${id}`;
      },
      bodies: {
        'write-playbook-case-inputs': { inputs: [] },
        'confirm-playbook-case-node': {
          decision: 'confirm',
          expected_revisions: {},
        },
      },
      queries: { 'get-playbook-case-missing': { node_id: 'revenue' } },
    },
    listMemories: {
      // A store per memory: the stub embedder answers every text with one
      // vector, so a second write into a store is absorbed as a duplicate.
      create: async (actorId) => {
        const storeId = await created('/api/v1/memory-stores', {
          project_id: projectId,
          name: `owned-${(seq += 1)}`,
        });
        return created('/api/v1/memories', {
          memory_store_id: storeId,
          content: `fact ${seq}`,
          ...(actorId ? { actor_id: actorId } : {}),
        });
      },
      path: (template, id) => {
        return template.replace('{memory_id}', id);
      },
      itemPath: (id) => {
        return `/api/v1/memories/${id}`;
      },
      bodies: {
        'update-memory': { metadata: { edited: true } },
        'replace-memory-tags': { owner: 'alice' },
        'merge-memory-tags': { owner: 'alice' },
      },
    },
  };

  const call = (args: {
    owner: Owner;
    tool: (typeof soatTools)[number];
    id: string;
    actorId: string;
  }) => {
    const method = args.tool.method.toLowerCase() as
      'get' | 'put' | 'post' | 'delete' | 'patch';
    return asAdmin()
      [method](args.owner.path(args.tool.pathTemplate, args.id))
      .query({
        ...args.owner.queries?.[args.tool.name],
        actor_id: args.actorId,
      })
      .send(args.owner.bodies?.[args.tool.name] ?? {});
  };

  beforeAll(async () => {
    process.env.PLAYBOOK_WORKER_DISABLED = 'true';
    const setup = await setupProjectWithUsers({
      prefix: 'actorownership',
      policyActions: ['memories:GetMemory'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    actorA = await created('/api/v1/actors', {
      project_id: projectId,
      name: 'A',
    });
    actorB = await created('/api/v1/actors', {
      project_id: projectId,
      name: 'B',
    });
  });

  afterAll(() => {
    delete process.env.PLAYBOOK_WORKER_DISABLED;
  });

  test('the item pin is declared once, in actor-ownership.yaml', () => {
    const declaredAt = fs.readdirSync(SPEC_DIR).filter((file) => {
      const spec = load(fs.readFileSync(path.join(SPEC_DIR, file), 'utf8'));
      const parameters =
        isRecord(spec) && isRecord(spec.components)
          ? spec.components.parameters
          : undefined;
      return (
        isRecord(parameters) &&
        Object.values(parameters).some((parameter) => {
          return isRecord(parameter) && parameter.name === 'actor_id';
        })
      );
    });

    expect(declaredAt).toEqual(['actor-ownership.yaml']);
  });

  test('every resource pinned by actor_id has an owner here', () => {
    expect(Object.keys(actorPinnedLists()).sort()).toEqual(
      Object.keys(OWNERS).sort()
    );
  });

  const cases = Object.entries(actorPinnedLists()).flatMap(
    ([listOperation, listPath]) => {
      return itemOperationsOf(listPath).map((tool) => {
        return [listOperation, tool.name, tool] as const;
      });
    }
  );

  test('every owned resource has item operations to hold', () => {
    for (const listPath of Object.values(actorPinnedLists())) {
      expect(itemOperationsOf(listPath).length).toBeGreaterThan(0);
    }
  });

  test.each(cases)(
    "%s %s refuses another actor's item as not found",
    async (listOperation, _name, tool) => {
      const owner = OWNERS[listOperation];
      const theirs = await owner.create(actorB);

      const res = await call({ owner, tool, id: theirs, actorId: actorA });

      expect(res.status).toBe(404);
      expect(res.body.error.message).not.toContain(actorB);
      const still = await asAdmin().get(owner.itemPath(theirs));
      expect(still.status).toBe(200);
    }
  );

  test.each(cases)(
    '%s %s refuses an item of no actor as not found',
    async (listOperation, _name, tool) => {
      const owner = OWNERS[listOperation];
      const nobodys = await owner.create();

      const res = await call({ owner, tool, id: nobodys, actorId: actorA });

      expect(res.status).toBe(404);
    }
  );
});
