import { rootVarPaths } from './jsonLogicVars';

/**
 * Every root `var` path a JSON Logic mapping value reads from the run state
 * (`applyInputMapping` evaluates it against the state). The empty path (whole
 * state) is left out: it cannot be resolved to a single key.
 */
export const collectVarRefs = (expr: unknown): string[] => {
  return rootVarPaths(expr).filter((path) => {
    return path.length > 0;
  });
};
