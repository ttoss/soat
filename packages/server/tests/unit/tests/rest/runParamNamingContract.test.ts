import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load as parseYaml } from 'js-yaml';

/**
 * A parameter that names a *run* is qualified by the resource the run belongs
 * to — `eval_run_id`, `orchestration_run_id` — never a
 * bare `run_id`.
 *
 * SOAT has three unrelated run concepts, and a parameter name is not a local
 * detail: it is the SDK argument, the CLI flag (`--eval_run_id`), and the MCP
 * tool argument, all generated verbatim from the spec's own property name
 * (`.claude/rules/case-convention.md`). A bare `--run_id` on one command and
 * `--orchestration_run_id` on the next reads as two spellings of one thing, so
 * the wrong id gets pasted into the wrong flag — and the failure is a `404` at
 * runtime, not a compile error.
 *
 * The response side already qualifies: `EvalResult.eval_run_id` and
 * `AgentVersion.eval_run_id` name the same value the path parameter takes. This
 * check keeps the parameter matching the field rather than drifting back.
 *
 * Static on the specs, like the other contract tests here: the drift it guards
 * is a convention break that would pass a new endpoint's own tests perfectly.
 */

const SPEC_DIR = join(__dirname, '../../../../src/rest/openapi/v1');

type ParameterSpec = {
  name?: string;
  in?: string;
  $ref?: string;
};

type OperationSpec = {
  parameters?: ParameterSpec[];
};

/**
 * A path item holds its methods alongside `parameters` (shared by every method
 * on the path), so its values are not uniformly operations — hence `unknown`
 * plus a guard rather than a cast.
 */
type PathItem = { parameters?: ParameterSpec[] } & Record<string, unknown>;

type SpecDocument = {
  paths?: Record<string, PathItem>;
  components?: { parameters?: Record<string, ParameterSpec> };
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const asOperation = (value: unknown): OperationSpec | null => {
  return typeof value === 'object' && value !== null ? value : null;
};

/**
 * A parameter may be declared inline or pulled from `components/parameters`
 * (orchestrations does the latter). Both reach the generated clients as the
 * same flag, so both have to be checked.
 */
const resolveParameter = (args: {
  param: ParameterSpec;
  doc: SpecDocument;
}): ParameterSpec => {
  const { param, doc } = args;
  if (!param.$ref) return param;

  const key = param.$ref.split('/').pop();
  return (key ? doc.components?.parameters?.[key] : undefined) ?? param;
};

/** Every declared parameter across the v1 specs, flattened with its origin. */
const allParameters = (): Array<{ label: string; name: string }> => {
  const parameters: Array<{ label: string; name: string }> = [];

  for (const file of readdirSync(SPEC_DIR).filter((name) => {
    return name.endsWith('.yaml');
  })) {
    const doc = parseYaml(
      readFileSync(join(SPEC_DIR, file), 'utf-8')
    ) as SpecDocument;

    for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
      for (const [method, value] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;

        const operation = asOperation(value);
        if (!operation) continue;

        const declared = [
          ...(pathItem.parameters ?? []),
          ...(operation.parameters ?? []),
        ];

        for (const declaredParam of declared) {
          const param = resolveParameter({ param: declaredParam, doc });
          if (!param.name) continue;
          parameters.push({
            label: `${method.toUpperCase()} ${path} (${file})`,
            name: param.name,
          });
        }
      }
    }
  }

  return parameters;
};

describe('run parameter naming contract', () => {
  test('the specs declare run parameters at all', () => {
    // A guard on the guard: if the run endpoints ever disappear from the specs
    // the check below would pass vacuously.
    const runParams = allParameters().filter(({ name }) => {
      return name.endsWith('run_id');
    });

    expect(runParams.length).toBeGreaterThanOrEqual(5);
  });

  test('no parameter is named a bare `run_id`', () => {
    const offenders = allParameters()
      .filter(({ name }) => {
        return name === 'run_id';
      })
      .map(({ label }) => {
        return label;
      });

    expect(offenders).toEqual([]);
  });

  test('every run parameter is qualified by its own resource', () => {
    const QUALIFIED = new Set(['eval_run_id', 'orchestration_run_id']);

    const offenders = allParameters()
      .filter(({ name }) => {
        return name.endsWith('run_id') && !QUALIFIED.has(name);
      })
      .map(({ label, name }) => {
        return `${name} — ${label}`;
      });

    expect(offenders).toEqual([]);
  });
});
