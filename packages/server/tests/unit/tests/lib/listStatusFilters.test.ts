import { getMergedOpenApiSpec } from 'src/lib/openapiSpec';
import { ORCHESTRATION_RUN_STATUSES } from 'src/lib/orchestrations';
import {
  AUTOMATION_STATUS_NONE,
  TASK_AUTOMATION_STATUSES,
} from 'src/lib/tasksAutomationStatus';

/**
 * The listing filters of #1242 are only useful if the values a caller may send
 * are the values the column holds. Two lists say what those are — the code
 * constant the route validates against, and the spec enum the SDK, the CLI and
 * the MCP tool surface are generated from — and nothing else makes them agree:
 * a status added upstream reaches the constant through the type checker and the
 * spec through nobody.
 */
type QueryParameter = {
  name: string;
  in: string;
  schema?: { items?: { enum?: string[] } };
};

const parameterEnum = (args: { path: string; name: string }): string[] => {
  const spec = getMergedOpenApiSpec();
  const operation = (
    spec.paths[args.path] as { get: { parameters: QueryParameter[] } }
  ).get;
  const parameter = operation.parameters.find((p) => {
    return p.in === 'query' && p.name === args.name;
  });
  if (!parameter?.schema?.items?.enum) {
    throw new Error(`${args.path} declares no \`${args.name}\` enum`);
  }
  return parameter.schema.items.enum;
};

describe('list status filters (#1242)', () => {
  test('the run listing offers every status a run can hold', () => {
    expect(
      parameterEnum({ path: '/api/v1/orchestration-runs', name: 'status' })
    ).toEqual([...ORCHESTRATION_RUN_STATUSES]);
  });

  // The sentinel is on the wire only: it names the absence of a dispatch, which
  // the column stores as SQL NULL rather than as a value in this list.
  test('the task listing offers every automation status, plus the sentinel', () => {
    expect(
      parameterEnum({ path: '/api/v1/tasks', name: 'automation_status' })
    ).toEqual([...TASK_AUTOMATION_STATUSES, AUTOMATION_STATUS_NONE]);
  });
});
