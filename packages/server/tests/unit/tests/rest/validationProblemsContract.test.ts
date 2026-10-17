import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A definition refused for its content answers one `meta` shape whatever the
 * module: `{ problems: [{ code, path, message }] }`, every problem listed, each
 * `code` UPPER_SNAKE. Orchestrations add their non-blocking `warnings` in the
 * same item shape. A dry-run validate endpoint answers the same items.
 */

const PROBLEM_CODE = /^[A-Z][A-Z0-9_]*$/;
const VALIDATION_CODES = [
  'ORCHESTRATION_VALIDATION_FAILED',
  'PLAYBOOK_VALIDATION_FAILED',
  'WORKFLOW_VALIDATION_FAILED',
];
const SRC_DIR = join(__dirname, '../../../../src');
const CHOKEPOINT = join('lib', 'validationProblems.ts');

const expectProblemList = (list: unknown) => {
  expect(Array.isArray(list)).toBe(true);
  for (const problem of list as Array<Record<string, unknown>>) {
    expect(Object.keys(problem).sort()).toEqual(['code', 'message', 'path']);
    expect(problem.code).toMatch(PROBLEM_CODE);
    expect(typeof problem.path).toBe('string');
    expect(typeof problem.message).toBe('string');
  }
};

const sourceFiles = (dir: string): string[] => {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

describe('validation problems contract', () => {
  let token: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'validationproblems',
      policyActions: [
        'orchestrations:CreateOrchestration',
        'playbooks:CreatePlaybook',
        'playbooks:ValidatePlaybook',
        'workflows:CreateWorkflow',
      ],
    });
    token = setup.userToken;
    projectId = setup.projectId;
  });

  describe('POST /api/v1/orchestrations', () => {
    test('lists every problem and the warnings under one meta shape', async () => {
      const res = await authenticatedTestClient(token)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'two problems and a warning',
          nodes: [
            { id: 'cond', type: 'condition', expression: 'yes' },
            {
              id: 'yes_node',
              type: 'transform',
              expression: 1,
              state_mapping: { 'state.branch': { var: 'output.result' } },
            },
            { id: 'no_node', type: 'transform', expression: 2 },
            {
              id: 'join',
              type: 'transform',
              expression: 1,
              input_mapping: {
                val: { var: 'branch' },
                prior: { var: 'nodes.ghost.output' },
              },
            },
            { id: 'a', type: 'agent' },
          ],
          edges: [
            { from: 'cond', to: 'yes_node', condition: 'yes' },
            { from: 'cond', to: 'no_node', condition: 'no' },
            { from: 'yes_node', to: 'join' },
            { from: 'no_node', to: 'join' },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
      expect(Object.keys(res.body.error.meta).sort()).toEqual([
        'problems',
        'warnings',
      ]);
      expectProblemList(res.body.error.meta.problems);
      expectProblemList(res.body.error.meta.warnings);
      expect(res.body.error.meta.problems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'MISSING_FIELD',
            path: 'nodes[4].agent_id',
          }),
          expect.objectContaining({
            code: 'NODE_NOT_UPSTREAM',
            path: 'nodes[3].input_mapping.prior',
          }),
        ])
      );
      expect(res.body.error.meta.warnings).toEqual([
        expect.objectContaining({
          code: 'CONDITIONAL_STATE_KEY',
          path: 'nodes[3].input_mapping.val',
        }),
      ]);
    });
  });

  describe('POST /api/v1/orchestrations/validate', () => {
    test('answers the same items as the refusal', async () => {
      const res = await authenticatedTestClient(token)
        .post('/api/v1/orchestrations/validate')
        .send({ nodes: [{ id: 'a', type: 'agent' }], edges: [] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        valid: false,
        problems: [
          {
            code: 'MISSING_FIELD',
            path: 'nodes[0].agent_id',
            message: expect.any(String),
          },
        ],
        warnings: [],
      });
    });
  });

  describe('POST /api/v1/playbooks', () => {
    test('lists every problem under one meta shape', async () => {
      const res = await authenticatedTestClient(token)
        .post('/api/v1/playbooks')
        .send({
          project_id: projectId,
          name: 'two problems',
          definition: {
            nodes: [
              {
                key: 'a',
                title: 'A',
                kind: 'execute',
                inputs: [
                  {
                    name: 'x',
                    schema: {},
                    required: true,
                    source: { node: 'missing', field: 'output' },
                  },
                ],
              },
            ],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PLAYBOOK_VALIDATION_FAILED');
      expect(Object.keys(res.body.error.meta)).toEqual(['problems']);
      expectProblemList(res.body.error.meta.problems);
      expect(res.body.error.meta.problems).toEqual([
        expect.objectContaining({
          code: 'EXECUTOR_REQUIRED',
          path: 'definition.nodes[0].executor',
        }),
        expect.objectContaining({
          code: 'MISSING_NODE',
          path: 'definition.nodes[0].inputs[0].source.node',
        }),
      ]);
    });
  });

  describe('POST /api/v1/playbooks/validate', () => {
    test('answers the same items as the refusal', async () => {
      const res = await authenticatedTestClient(token)
        .post('/api/v1/playbooks/validate')
        .send({
          definition: {
            nodes: [
              {
                key: 'a',
                title: 'A',
                kind: 'execute',
                inputs: [],
              },
            ],
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        valid: false,
        problems: [
          {
            code: 'EXECUTOR_REQUIRED',
            path: 'definition.nodes[0].executor',
            message: expect.any(String),
          },
        ],
      });
    });
  });

  describe('POST /api/v1/workflows', () => {
    test('lists every problem under one meta shape', async () => {
      const res = await authenticatedTestClient(token)
        .post('/api/v1/workflows')
        .send({
          project_id: projectId,
          name: 'two problems',
          states: [{ name: 'a' }, { name: 'b' }],
          transitions: [{ name: 'go', from: ['a'], to: 'ghost' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WORKFLOW_VALIDATION_FAILED');
      expect(Object.keys(res.body.error.meta)).toEqual(['problems']);
      expectProblemList(res.body.error.meta.problems);
      expect(res.body.error.meta.problems).toEqual([
        expect.objectContaining({
          code: 'INITIAL_STATE_COUNT',
          path: 'states',
        }),
        expect.objectContaining({
          code: 'UNKNOWN_STATE',
          path: 'transitions[0].to',
        }),
      ]);
    });
  });

  test('every validation refusal is raised through the chokepoint', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((file) => {
        return !file.endsWith(CHOKEPOINT);
      })
      .filter((file) => {
        const source = readFileSync(file, 'utf-8');
        return VALIDATION_CODES.some((code) => {
          return new RegExp(`DomainError\\(\\s*'${code}'`).test(source);
        });
      })
      .map((file) => {
        return file.slice(SRC_DIR.length + 1);
      });

    expect({ offenders }).toEqual({ offenders: [] });
  });
});
