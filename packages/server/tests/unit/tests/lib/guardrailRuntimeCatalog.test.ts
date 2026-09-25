import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  parseRuntimeKey,
  RUNTIME_CONTEXT_CATALOG,
  RUNTIME_MODULES,
  RUNTIME_SERVED,
} from 'src/lib/guardrailRuntimeCatalog';

const GUARDRAILS_DOC = path.resolve(
  __dirname,
  '../../../../../website/docs/modules/guardrails.md'
);

// The served-combinations table in the docs, read row by row:
// | `projects` | `id` | `tool_calls` `tokens` | `1h` `24h` |
const readDocsServedTable = (): Record<
  string,
  { identity: string[]; metrics: string[]; windows: string[] }
> => {
  const lines = readFileSync(GUARDRAILS_DOC, 'utf8').split('\n');
  const header = lines.findIndex((line) => {
    return /^\|\s*Module\s*\|\s*Identity\s*\|\s*Metrics\s*\|\s*Windows\s*\|/.test(
      line
    );
  });
  expect(header).toBeGreaterThanOrEqual(0);
  const table: Record<
    string,
    { identity: string[]; metrics: string[]; windows: string[] }
  > = {};
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => {
        return [...cell.matchAll(/`([^`]+)`/g)].map((match) => {
          return match[1];
        });
      });
    const [[module], identity, metrics, windows] = cells;
    table[module] = { identity, metrics, windows };
  }
  return table;
};

describe('runtime.* catalog', () => {
  test('is exactly runtime.action plus every served (module, identity) and (module, metric, window)', () => {
    const expected = new Set(['runtime.action']);
    for (const module of RUNTIME_MODULES) {
      const served = RUNTIME_SERVED[module];
      for (const field of served.identity) {
        expected.add(`runtime.${module}.${field}`);
      }
      for (const metric of served.metrics) {
        for (const window of served.windows) {
          expected.add(`runtime.${module}.${metric}.${window}`);
        }
      }
    }
    expect([...RUNTIME_CONTEXT_CATALOG].sort()).toEqual([...expected].sort());
  });

  test('matches the served-combinations table in guardrails.md', () => {
    const docs = readDocsServedTable();
    const code = Object.fromEntries(
      RUNTIME_MODULES.map((module) => {
        const served = RUNTIME_SERVED[module];
        return [
          module,
          {
            identity: [...served.identity],
            metrics: [...served.metrics],
            windows: [...served.windows],
          },
        ];
      })
    );
    expect(docs).toEqual(code);
  });

  test.each([
    ['runtime.action', { kind: 'action' }],
    [
      'runtime.tools.name',
      { kind: 'identity', module: 'tools', field: 'name' },
    ],
    [
      'runtime.orchestrations.node_attempt',
      { kind: 'identity', module: 'orchestrations', field: 'node_attempt' },
    ],
    [
      'runtime.tools.tool_calls.24h',
      {
        kind: 'metric',
        module: 'tools',
        metric: 'tool_calls',
        window: '24h',
      },
    ],
    [
      'runtime.guardrails.tool_calls.7d',
      {
        kind: 'metric',
        module: 'guardrails',
        metric: 'tool_calls',
        window: '7d',
      },
    ],
  ])('parses %s', (key, expected) => {
    expect(parseRuntimeKey(key)).toEqual(expected);
  });

  test.each([
    // Non-leaf paths.
    'runtime',
    'runtime.tools',
    'runtime.tools.tool_calls',
    'runtime.projects.cost_usd',
    // A leaf with a trailing segment.
    'runtime.tools.tool_calls.24h.extra',
    // Unserved combinations.
    'runtime.tools.tokens.24h',
    'runtime.guardrails.errors.24h',
    'runtime.projects.tool_calls.total',
    'runtime.orchestrations.tool_calls.24h',
    'runtime.agents.errors.1h',
    'runtime.guardrails.id',
    'runtime.projects.cost_usd.90d',
    'runtime.generations.tool_calls.total',
    // Keys outside the grammar.
    'runtime.tool.id',
    'runtime.agent.id',
    'runtime.project.id',
    'runtime.activity.actions_24h',
    'runtime.usage.cost_usd_24h',
    'runtime.usage.orchestration_run_tokens',
    'runtime.orchestration_run.node_attempt',
  ])('refuses %s', (key) => {
    expect(parseRuntimeKey(key)).toBeNull();
    expect(RUNTIME_CONTEXT_CATALOG.has(key)).toBe(false);
  });
});
