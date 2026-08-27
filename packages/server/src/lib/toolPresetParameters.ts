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
 * The JSON Schema scalar type a parameter declares, or `undefined` when the
 * schema says nothing about it. Reads `type` only — a `oneOf`/`anyOf` union says
 * nothing unambiguous about what a string should become, so it is left alone.
 */
const readProperty = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!(key in value)) return undefined;
  const record: Record<string, unknown> = { ...value };
  return record[key];
};

const declaredType = (args: {
  schema?: unknown;
  key: string;
}): string | undefined => {
  const property = readProperty(
    readProperty(args.schema, 'properties'),
    args.key
  );
  const type = readProperty(property, 'type');
  if (typeof type === 'string') return type;
  // `type: ['integer', 'null']` — the nullable spelling. The first non-null
  // entry is what a value must become.
  if (Array.isArray(type)) {
    return type.find((entry): entry is string => {
      return typeof entry === 'string' && entry !== 'null';
    });
  }
  return undefined;
};

const coerceScalar = (args: { value: string; type: string }): unknown => {
  if (args.type === 'integer' || args.type === 'number') {
    // `Number('')` is 0 and `Number(' ')` is 0 — neither is a number the caller
    // wrote, so an empty/blank string stays a string and the target rejects it.
    if (args.value.trim() === '') return args.value;
    const parsed = Number(args.value);
    if (!Number.isFinite(parsed)) return args.value;
    if (args.type === 'integer' && !Number.isInteger(parsed)) return args.value;
    return parsed;
  }
  if (args.type === 'boolean') {
    if (args.value === 'true') return true;
    if (args.value === 'false') return false;
    return args.value;
  }
  return args.value;
};

/**
 * Retypes the preset values that came from a `{{context:<key>}}` token to what
 * the target's schema declares (#345).
 *
 * A `tool_context` value is a string — the bag is `Record<string, string>`,
 * because every entry must also survive the trip to an HTTP header — while the
 * same identity is often a string on one action and a number on another (the ad
 * account that is `adAccountId: "act_…"` here and `metaAdAccountId: 123` there).
 * Without this step the numeric half of a tool surface cannot be pinned from
 * context at all: the target sees `"123"` where its schema says `integer`.
 *
 * Only keys named in `contextResolvedKeys` are touched. An operator who pinned
 * the literal string `"123"` on a numeric field wrote a string deliberately (or
 * wrote a bug they can see in the stored config); a context-resolved value had
 * no other shape available to it. Narrowing by provenance is what keeps this
 * from being the key-blind rewrite `.claude/rules/case-convention.md` prohibits.
 *
 * A value the declared type cannot accept is left as the string it is, so the
 * target's own validation reports it rather than this function guessing.
 */
export const coercePresetParametersToSchema = (args: {
  presetParameters: Record<string, unknown> | null;
  contextResolvedKeys: string[];
  schema?: unknown;
}): Record<string, unknown> | null => {
  if (!args.presetParameters || args.contextResolvedKeys.length === 0) {
    return args.presetParameters;
  }
  return Object.fromEntries(
    Object.entries(args.presetParameters).map(([key, value]) => {
      if (
        typeof value !== 'string' ||
        !args.contextResolvedKeys.includes(key)
      ) {
        return [key, value];
      }
      const type = declaredType({ schema: args.schema, key });
      if (!type) return [key, value];
      return [key, coerceScalar({ value, type })];
    })
  );
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
