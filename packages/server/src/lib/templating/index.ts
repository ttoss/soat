/**
 * The templating surface: the two substitution engines the whole server shares.
 *
 * - {@link ./jsonLogic} — JSON Logic value-mapping (`{ "var": … }`), used by
 *   orchestration nodes, pipeline steps, and tool output mapping to compute a
 *   value from a context.
 * - {@link ./stringTemplate} — the single string-interpolation engine
 *   (`${namespace.path}`), used by tool URLs/headers, secret references,
 *   formation `sub` expressions, and discussion prompts to splice values into
 *   a string.
 *
 * Both resolve dotted paths through the shared {@link ./path} helper, so
 * `${arg.a.b}` and `{ "var": "a.b" }` descend a context identically.
 */
export * from './jsonLogic';
export * from './path';
export * from './stringTemplate';
