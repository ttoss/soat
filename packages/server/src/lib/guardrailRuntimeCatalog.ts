/**
 * The `runtime.*` guardrail catalog, as one table.
 *
 * Every key reads `runtime.<module>.<identity>` or
 * `runtime.<module>.<metric>.<window>`, plus the module-less request fact
 * `runtime.action`. A module answers about the entity of that module in the
 * current call: `projects` the project, `agents` the calling agent, `tools` the
 * tool, `guardrails` the guardrail being evaluated, `orchestrations` the
 * current run. The served combinations are {@link RUNTIME_SERVED}; the catalog
 * is derived from it, so a key cannot be served without a row here, and
 * `guardrails.md` carries the same table (pinned by
 * `guardrailRuntimeCatalog.test.ts`).
 */

export const RUNTIME_METRICS = [
  'tool_calls',
  'tokens',
  'cost_usd',
  'errors',
] as const;

export type RuntimeMetric = (typeof RUNTIME_METRICS)[number];

// `total` is the entity's lifetime: "this run so far" for `orchestrations`,
// all-time for a tool. The others are rolling and end at evaluation time.
export const RUNTIME_WINDOWS = ['1h', '24h', '7d', '30d', 'total'] as const;

export type RuntimeWindow = (typeof RUNTIME_WINDOWS)[number];

export const RUNTIME_MODULES = [
  'projects',
  'guardrails',
  'agents',
  'tools',
  'orchestrations',
] as const;

export type RuntimeModule = (typeof RUNTIME_MODULES)[number];

type ServedModule = {
  identity: readonly string[];
  metrics: readonly RuntimeMetric[];
  windows: readonly RuntimeWindow[];
};

const ROLLING = ['1h', '24h', '7d', '30d'] as const;

export const RUNTIME_SERVED: { readonly [M in RuntimeModule]: ServedModule } = {
  projects: {
    identity: ['id'],
    metrics: ['tool_calls', 'tokens', 'cost_usd', 'errors'],
    windows: ROLLING,
  },
  guardrails: { identity: [], metrics: ['tool_calls'], windows: ROLLING },
  agents: {
    identity: ['id'],
    metrics: ['tool_calls', 'tokens', 'cost_usd'],
    windows: ROLLING,
  },
  tools: {
    identity: ['id', 'name'],
    metrics: ['tool_calls', 'errors'],
    windows: [...ROLLING, 'total'],
  },
  orchestrations: {
    identity: ['node_attempt'],
    metrics: ['tool_calls', 'tokens', 'cost_usd'],
    windows: ['total'],
  },
};

export const RUNTIME_ACTION_KEY = 'runtime.action';

export type RuntimeKey =
  | { kind: 'action' }
  | { kind: 'identity'; module: RuntimeModule; field: string }
  | {
      kind: 'metric';
      module: RuntimeModule;
      metric: RuntimeMetric;
      window: RuntimeWindow;
    };

const isModule = (value: string): value is RuntimeModule => {
  return (RUNTIME_MODULES as readonly string[]).includes(value);
};

const parseModuleLeaf = (args: {
  module: RuntimeModule;
  second: string;
  third: string | undefined;
}): RuntimeKey | null => {
  const { module, second, third } = args;
  const served = RUNTIME_SERVED[module];
  if (third === undefined) {
    return served.identity.includes(second)
      ? { kind: 'identity', module, field: second }
      : null;
  }
  const metric = served.metrics.find((candidate) => {
    return candidate === second;
  });
  const window = served.windows.find((candidate) => {
    return candidate === third;
  });
  return metric && window ? { kind: 'metric', module, metric, window } : null;
};

/**
 * Reads a `runtime.*` path against {@link RUNTIME_SERVED}. `null` for anything
 * the table does not serve — an unknown module, a non-leaf path, an unserved
 * metric or window.
 */
export const parseRuntimeKey = (path: string): RuntimeKey | null => {
  if (path === RUNTIME_ACTION_KEY) return { kind: 'action' };
  const [root, module, second, third, ...rest] = path.split('.');
  if (root !== 'runtime' || rest.length > 0) return null;
  if (!module || !second || !isModule(module)) return null;
  return parseModuleLeaf({ module, second, third });
};

const servedKeys = (module: RuntimeModule): string[] => {
  const served = RUNTIME_SERVED[module];
  return [
    ...served.identity.map((field) => {
      return `runtime.${module}.${field}`;
    }),
    ...served.metrics.flatMap((metric) => {
      return served.windows.map((window) => {
        return `runtime.${module}.${metric}.${window}`;
      });
    }),
  ];
};

/**
 * Every `runtime.*` key a guardrail may reference. A key outside it is refused
 * at write time rather than resolving to `null` at evaluation time.
 */
export const RUNTIME_CONTEXT_CATALOG: ReadonlySet<string> = new Set([
  RUNTIME_ACTION_KEY,
  ...RUNTIME_MODULES.flatMap(servedKeys),
]);
