import { isObjectRecord } from 'src/lib/openapiSchemaFields';
import { getMergedOpenApiSpec } from 'src/lib/openapiSpec';
import { STRICT_FIELDS_OPT_OUT } from 'src/middleware/strictFields';

/**
 * Drift guardrail — the spec is the field list, so a schema that declares one
 * has to say the list is the whole list.
 *
 * `requestValidation` and the formation template walk both refuse a key no
 * closed object level declares. A level is closed when it declares
 * `properties` and does not open itself with `additionalProperties`. Writing
 * `false` is therefore not what makes the server strict — it is what makes the
 * published contract say so, which is the half a generated client, a mirror of
 * these specs, or a tenant validating locally reads.
 *
 * Three rules, all derived from the specs rather than a list kept by hand:
 *
 * 1. A declared field list is never paired with `additionalProperties: true`.
 *    That pairing is self-contradictory — the list is decoration, every key
 *    passes, and the level a validator skips is the level an author trusts.
 * 2. A level only a strict route or a formation template reaches declares
 *    `additionalProperties: false`.
 * 3. A level only a `STRICT_FIELDS_OPT_OUT` route reaches declares no
 *    `additionalProperties: false`: those routes take extra fields on purpose
 *    (LLM passthrough, the accept-and-ignore file create), so publishing
 *    closedness there would document a refusal that never happens.
 *
 * A level a response also reaches is exempt from rule 2: `false` there is a
 * claim about what the server *returns*, and responses carry undeclared keys
 * today (`tests/unit/openapiContract.ts`). Declaring it is allowed where the
 * write path guarantees the stored value is closed — a guardrail document,
 * whose every write path runs `validateGuardrailDocument`.
 */

type Level = {
  /** Where the walk found it, for a failure message that names a place. */
  label: string;
  schema: Record<string, unknown>;
};

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const spec = getMergedOpenApiSpec();

const resolve = (
  node: unknown
): { schema: Record<string, unknown>; name?: string } | null => {
  if (!isObjectRecord(node)) return null;
  const ref = node.$ref;
  if (typeof ref !== 'string') return { schema: node };
  const name = ref.split('/').pop();
  const named = name ? spec.components.schemas[name] : undefined;
  return isObjectRecord(named) ? { schema: named, name } : null;
};

type Frame = { node: unknown; label: string };

/** Every schema node one level names: properties, items, branches, the map. */
const childFrames = (args: {
  schema: Record<string, unknown>;
  label: string;
}): Frame[] => {
  const { schema, label } = args;
  const frames: Frame[] = [];

  if (isObjectRecord(schema.properties)) {
    for (const [key, value] of Object.entries(schema.properties)) {
      frames.push({ node: value, label: `${label}.${key}` });
    }
  }
  if (schema.items !== undefined) {
    frames.push({ node: schema.items, label: `${label}[]` });
  }
  for (const keyword of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const [index, branch] of branches.entries()) {
      frames.push({ node: branch, label: `${label}.${keyword}[${index}]` });
    }
  }
  if (isObjectRecord(schema.additionalProperties)) {
    frames.push({ node: schema.additionalProperties, label: `${label}{*}` });
  }

  return frames;
};

/**
 * Every object level reachable from `root` that declares `properties`, keyed by
 * schema object identity so a named schema reached twice is one level.
 */
const collectLevels = (args: {
  root: unknown;
  label: string;
  into: Map<Record<string, unknown>, Level>;
}): void => {
  const stack: Frame[] = [{ node: args.root, label: args.label }];
  const seen = new Set<Record<string, unknown>>();

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;

    const resolved = resolve(frame.node);
    if (!resolved) continue;
    const { schema, name } = resolved;
    if (seen.has(schema)) continue;
    seen.add(schema);

    if (isObjectRecord(schema.properties) && !args.into.has(schema)) {
      args.into.set(schema, {
        label: name ? `${name} (${frame.label})` : frame.label,
        schema,
      });
    }

    stack.push(...childFrames({ schema, label: frame.label }));
  }
};

const jsonBodySchema = (container: unknown): unknown => {
  if (!isObjectRecord(container)) return undefined;
  const { content } = container;
  if (!isObjectRecord(content)) return undefined;
  const json = content['application/json'];
  return isObjectRecord(json) ? json.schema : undefined;
};

const requestLevels = (args: {
  accepts: (route: string) => boolean;
}): Map<Record<string, unknown>, Level> => {
  const levels = new Map<Record<string, unknown>, Level>();
  for (const [template, pathItem] of Object.entries(spec.paths)) {
    if (!isObjectRecord(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObjectRecord(operation)) continue;
      const route = `${method.toUpperCase()} ${template}`;
      if (!args.accepts(route)) continue;
      const schema = jsonBodySchema(operation.requestBody);
      if (schema === undefined) continue;
      collectLevels({ root: schema, label: route, into: levels });
    }
  }
  return levels;
};

const responseLevels = (): Map<Record<string, unknown>, Level> => {
  const levels = new Map<Record<string, unknown>, Level>();
  for (const [template, pathItem] of Object.entries(spec.paths)) {
    if (!isObjectRecord(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObjectRecord(operation)) continue;
      const { responses } = operation;
      if (!isObjectRecord(responses)) continue;
      for (const [status, response] of Object.entries(responses)) {
        const schema = jsonBodySchema(response);
        if (schema === undefined) continue;
        collectLevels({
          root: schema,
          label: `${method.toUpperCase()} ${template} (${status})`,
          into: levels,
        });
      }
    }
  }
  return levels;
};

/**
 * The `<Type>ResourceProperties` schemas. No path references them — a formation
 * template is a free-form bag on the wire and `formationSpecLoader` loads them
 * by name — so they are walked from the component map.
 */
const templateLevels = (): Map<Record<string, unknown>, Level> => {
  const levels = new Map<Record<string, unknown>, Level>();
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    if (!name.endsWith('ResourceProperties')) continue;
    collectLevels({ root: schema, label: name, into: levels });
  }
  return levels;
};

const strict = requestLevels({
  accepts: (route) => {
    return !STRICT_FIELDS_OPT_OUT.has(route);
  },
});
const lenient = requestLevels({
  accepts: (route) => {
    return STRICT_FIELDS_OPT_OUT.has(route);
  },
});
const responses = responseLevels();
const templates = templateLevels();

const declaredFor = (schema: Record<string, unknown>): unknown => {
  return 'additionalProperties' in schema
    ? schema.additionalProperties
    : undefined;
};

const labelsOf = (levels: Level[]): string[] => {
  return levels.map((level) => {
    return level.label;
  });
};

describe('every schema a request or a template reaches states whether it is closed', () => {
  test('no declared field list is paired with additionalProperties: true', () => {
    const contradictory: Level[] = [];
    for (const levels of [strict, lenient, templates]) {
      for (const [schema, level] of levels) {
        if (declaredFor(schema) === true) contradictory.push(level);
      }
    }

    expect(labelsOf(contradictory)).toEqual([]);
  });

  test('a level only a strict route or a template reaches is closed', () => {
    const open: Level[] = [];
    for (const levels of [strict, templates]) {
      for (const [schema, level] of levels) {
        if (responses.has(schema)) continue;
        if (declaredFor(schema) !== false) open.push(level);
      }
    }

    expect(labelsOf(open)).toEqual([]);
  });

  test('a level only an opt-out route reaches is not closed', () => {
    const closed: Level[] = [];
    for (const [schema, level] of lenient) {
      if (strict.has(schema) || templates.has(schema)) continue;
      if (declaredFor(schema) === false) closed.push(level);
    }

    expect(labelsOf(closed)).toEqual([]);
  });

  // The nested half of the rule. Each `<Type>ResourceProperties` schema closes
  // its own top level, and every object level under one has to close too, or
  // the template path stops reading where the resource's own route keeps
  // going.
  test('every level under a <Type>ResourceProperties is closed', () => {
    const open: Level[] = [];
    for (const [schema, level] of templates) {
      if (declaredFor(schema) !== false) open.push(level);
    }

    expect(labelsOf(open)).toEqual([]);
  });
});
