import { Ajv, type ValidateFunction } from 'ajv';
import createDebug from 'debug';

const log = createDebug('soat:schema');

/**
 * `strict: false` because these schemas are author-written and routinely carry
 * keywords ajv does not know — provider-specific hints, `$comment`, vendor
 * `x-*` extensions. In strict mode ajv *throws* on those at compile time,
 * which would turn a harmless annotation into a refusal. `allErrors` so a
 * message names every violated field rather than only the first: the message
 * is what the author reads to fix their config.
 *
 * `format` is deliberately left unimplemented (no `ajv-formats`). In JSON
 * Schema, `format` is an annotation unless a validator opts into asserting it;
 * turning every existing `format` into an assertion would reject values whose
 * schema author never claimed they were invalid.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Compiled validators, keyed by the schema's serialization. Every schema here
 * comes from a stored row — an agent's `output_schema`, a tool's `parameters` —
 * so the key set is bounded by what a project has authored rather than by
 * traffic; the cap is a backstop against a pathological caller, not an
 * expected path.
 */
const validatorCache = new Map<string, ValidateFunction | null>();
const VALIDATOR_CACHE_MAX = 500;

/**
 * The compiled validator for a stored schema, or `null` when ajv cannot compile
 * it.
 *
 * A schema ajv rejects is an **authoring** bug rather than a bad value, so
 * every caller treats `null` as "cannot check this" and proceeds: refusing on
 * it would turn one malformed row into an outage on a path that never had the
 * check to begin with. `null` is cached too, so the throw is not repaid on
 * every subsequent call.
 */
export const compileJsonSchema = (
  schema: Record<string, unknown>
): ValidateFunction | null => {
  const key = JSON.stringify(schema);
  const cached = validatorCache.get(key);
  if (cached !== undefined) return cached;

  let compiled: ValidateFunction | null = null;
  try {
    compiled = ajv.compile(schema);
  } catch (error) {
    log(
      'compileJsonSchema: schema could not be compiled, values will not be validated against it: %s',
      error instanceof Error ? error.message : String(error)
    );
  }

  if (validatorCache.size >= VALIDATOR_CACHE_MAX) validatorCache.clear();
  validatorCache.set(key, compiled);
  return compiled;
};

/** ajv's errors as one line, each naming the field it is about. */
export const describeSchemaErrors = (
  errors: ValidateFunction['errors']
): string => {
  const detail = (errors ?? [])
    .map((entry) => {
      const path = entry.instancePath || '(root)';
      return `${path} ${entry.message ?? 'is invalid'}`;
    })
    .join('; ');
  return detail || 'unknown violation';
};
