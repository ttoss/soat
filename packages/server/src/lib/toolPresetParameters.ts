import type { JSONSchema7, Tool } from 'ai';

/**
 * `preset_parameters` precedence, defined once.
 *
 * A preset is a **pin**, not a default: it is the operator's fixed value for a
 * parameter, and it wins over whatever the model (or a `POST /tools/{id}/call`
 * caller) supplies for the same key. Every surface that dispatches a tool call
 * merges through {@link mergePresetParameters}, so the rule cannot drift between
 * the agent loop, the direct call route, pipeline steps and the guardrail gate —
 * a guardrail that classified the model's value while execution used the pinned
 * one would be gating a call that never happens.
 *
 * The complement is {@link stripPresetKeysFromSchema}: a pinned parameter is
 * removed from the schema the model sees, so it is never offered a field its
 * answer cannot affect. That strip is ergonomics; the merge is the guarantee.
 * The strip alone is not one — none of these schemas set
 * `additionalProperties: false`, so a model that emits a hidden key anyway is
 * not rejected, and before the merge order was fixed its value silently
 * overrode the pin (which is what the boundary-policy and multi-agent tutorials
 * relied on not happening).
 */
export const mergePresetParameters = (args: {
  presetParameters?: object | null;
  input?: unknown;
}): Record<string, unknown> => {
  const input =
    args.input && typeof args.input === 'object' && !Array.isArray(args.input)
      ? (args.input as Record<string, unknown>)
      : {};
  return { ...input, ...(args.presetParameters ?? {}) };
};

/**
 * The model-visible schema with every pinned key removed from `properties` and
 * from `required` — a pinned parameter the model can no longer omit by mistake,
 * and no longer waste a guess on.
 */
export const stripPresetKeysFromSchema = (
  schema: JSONSchema7,
  presetParameters?: object | null
): JSONSchema7 => {
  if (!presetParameters || Object.keys(presetParameters).length === 0) {
    return schema;
  }
  const presetKeys = new Set(Object.keys(presetParameters));
  const props = schema.properties
    ? Object.fromEntries(
        Object.entries(schema.properties).filter(([key]) => {
          return !presetKeys.has(key);
        })
      )
    : {};
  const required = (schema.required ?? []).filter((key: string) => {
    return !presetKeys.has(key);
  });
  return {
    ...schema,
    properties: props,
    ...(required.length > 0 ? { required } : { required: undefined }),
  };
};

/**
 * Symbol key under which a resolved `client` tool carries its presets.
 *
 * A client tool has no server-side `execute` to merge into — the call is handed
 * to the caller at the `requires_action` boundary and executed there — so the
 * resolver attaches the presets here and `findPendingClientTools` merges them
 * into the arguments the client receives. Same shape as `CLIENT_TOOL_GATE` in
 * `agentToolGuardrail.ts`, and for the same reason: the tool must stay
 * execute-less to remain a client tool downstream.
 */
export const CLIENT_TOOL_PRESETS: unique symbol = Symbol(
  'soat.clientToolPresets'
);

export type PresetClientTool = Tool & {
  [CLIENT_TOOL_PRESETS]?: object | null;
};

/** The presets a resolved client tool carries, if any. */
export const readClientToolPresets = (
  tool: Tool | undefined
): object | null | undefined => {
  if (!tool) return undefined;
  return (tool as PresetClientTool)[CLIENT_TOOL_PRESETS];
};
