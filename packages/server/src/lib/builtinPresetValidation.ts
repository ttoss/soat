import { findBuiltinAction } from './builtinActionCatalog';
import { isPlainObject } from './plainObject';
import {
  throwValidationProblems,
  type ValidationProblem,
} from './validationProblems';

type ToolPresets = {
  type: string;
  actions?: string[] | null;
  deniedActions?: string[] | null;
  presetParameters?: object | null;
  presetParametersByAction?: object | null;
};

const byActionShapeProblems = (args: {
  actions: string[];
  byAction: object;
}): ValidationProblem[] => {
  return Object.entries(args.byAction).flatMap(
    ([action, presets]): ValidationProblem[] => {
      const path = `preset_parameters_by_action.${action}`;
      if (!args.actions.includes(action)) {
        return [
          {
            code: 'UNKNOWN_ACTION',
            path,
            message: `"${action}" is not in the tool's \`actions\`.`,
          },
        ];
      }
      if (!isPlainObject(presets)) {
        return [
          {
            code: 'INVALID_PRESET_PARAMETERS',
            path,
            message: "An action's presets must be an object.",
          },
        ];
      }
      return [];
    }
  );
};

/**
 * Every key one native action is sent must be a parameter its schema
 * declares. A tool-level `action` selects the action of a direct call rather
 * than reaching it. An added action's schema is its server's listing, read
 * per call, so it is not checked here.
 */
const undeclaredKeyProblems = (args: {
  action: string;
  presetParameters?: object | null;
  own: object | null;
}): ValidationProblem[] => {
  const found = findBuiltinAction(args.action);
  if (found?.kind !== 'native') return [];
  const properties = found.def.inputSchema.properties ?? {};
  const sources: Array<[string, object | null | undefined]> = [
    ['preset_parameters', args.presetParameters],
    [`preset_parameters_by_action.${args.action}`, args.own],
  ];
  return sources.flatMap(([prefix, presets]) => {
    return Object.keys(presets ?? {}).flatMap((key): ValidationProblem[] => {
      const overridden =
        prefix === 'preset_parameters' &&
        args.own !== null &&
        Object.hasOwn(args.own, key);
      const selector = prefix === 'preset_parameters' && key === 'action';
      if (overridden || selector || Object.hasOwn(properties, key)) return [];
      return [
        {
          code: 'UNDECLARED_PRESET_PARAMETER',
          path: `${prefix}.${key}`,
          message: `Action "${args.action}" declares no parameter "${key}".`,
        },
      ];
    });
  });
};

/**
 * What refuses a tool's presets: per-action presets on a tool that is not
 * `builtin`, an entry for an action the tool does not list, and a key an
 * action the tool can run carries in its effective preset but its schema does
 * not declare. A denied action never runs, so its schema is not read.
 */
export const builtinPresetProblems = (
  tool: ToolPresets
): ValidationProblem[] => {
  const byAction = tool.presetParametersByAction ?? null;
  if (tool.type !== 'builtin') {
    return byAction === null
      ? []
      : [
          {
            code: 'INVALID_PRESET_PARAMETERS',
            path: 'preset_parameters_by_action',
            message: 'Only a `builtin` tool takes per-action presets.',
          },
        ];
  }
  const actions = tool.actions ?? [];
  const shape = byAction ? byActionShapeProblems({ actions, byAction }) : [];
  if (shape.length > 0) return shape;
  const denied = tool.deniedActions ?? [];
  const runnable = actions.filter((action) => {
    return !denied.includes(action);
  });
  return runnable.flatMap((action) => {
    const own: unknown = byAction ? Reflect.get(byAction, action) : undefined;
    return undeclaredKeyProblems({
      action,
      presetParameters: tool.presetParameters,
      own: isPlainObject(own) ? own : null,
    });
  });
};

export const assertBuiltinPresetsDeclared = (tool: ToolPresets): void => {
  const problems = builtinPresetProblems(tool);
  if (problems.length === 0) return;
  throwValidationProblems({
    code: 'VALIDATION_FAILED',
    subject: 'Tool',
    problems,
    warnings: null,
  });
};
