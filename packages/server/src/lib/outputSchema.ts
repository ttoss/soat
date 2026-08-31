import { jsonSchema, Output } from 'ai';
import { Ajv, type ValidateFunction } from 'ajv';
import createDebug from 'debug';

import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:generation');

const MARKDOWN_JSON_FENCE = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i;

/**
 * Strips a single markdown code fence (` ```json ... ``` ` or plain
 * ` ``` ... ``` `) wrapping the entire string — the shape a model commonly
 * returns structured JSON in even when instructed to return bare JSON, which
 * a plain `JSON.parse` rejects outright. Returns the input unchanged when no
 * fence wraps the whole string, so a genuinely bare JSON response (or
 * genuinely non-JSON prose) is left untouched for the caller to parse or
 * reject on its own.
 */
export const stripMarkdownJsonFence = (content: string): string => {
  const match = content.match(MARKDOWN_JSON_FENCE);
  return match ? match[1] : content;
};

/**
 * Validates an agent's `outputSchema`. It must be a JSON Schema object (or
 * null/undefined to leave the agent unconstrained). Deep validation of the
 * schema itself is left to the AI SDK / model provider at generation time.
 */
export const validateOutputSchema = (schema: unknown): void => {
  if (schema === null || schema === undefined) return;
  if (!isPlainObject(schema)) {
    throw new DomainError(
      'INVALID_OUTPUT_SCHEMA',
      'output_schema must be a JSON Schema object.'
    );
  }
};

/**
 * `strict: false` because an `output_schema` is author-written and routinely
 * carries keywords ajv does not know — provider-specific hints, `$comment`,
 * vendor `x-*` extensions. In strict mode ajv *throws* on those at compile
 * time, which would turn a harmless annotation into a failed generation.
 * `allErrors` so the thrown message names every violated field, not just the
 * first: the message is what a board author reads to fix their agent.
 *
 * `format` is deliberately left unimplemented (no `ajv-formats`). In JSON
 * Schema, `format` is an annotation unless a validator opts into asserting it;
 * turning every existing `format` into an assertion would reject output that
 * the schema's author never claimed was invalid.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Compiled validators, keyed by the schema's serialization. An `output_schema`
 * comes from an agent row (or an archived version snapshot), so the key set is
 * bounded by the project's agents rather than by traffic; the cap is a backstop
 * against a pathological caller, not an expected path.
 */
const validatorCache = new Map<string, ValidateFunction | null>();
const VALIDATOR_CACHE_MAX = 500;

/**
 * A schema ajv cannot compile is an **authoring** bug, not a bad generation.
 * Failing every generation on it would turn one malformed agent config into an
 * outage, so the generation proceeds unvalidated and the compile failure is
 * logged. `null` marks "known-uncompilable" so the throw is not repaid on
 * every subsequent generation.
 */
const compileValidator = (schema: Record<string, unknown>) => {
  const key = JSON.stringify(schema);
  const cached = validatorCache.get(key);
  if (cached !== undefined) return cached;

  let compiled: ValidateFunction | null = null;
  try {
    compiled = ajv.compile(schema);
  } catch (error) {
    log(
      'compileValidator: output_schema could not be compiled, generations will not be validated against it: %s',
      error instanceof Error ? error.message : String(error)
    );
  }

  if (validatorCache.size >= VALIDATOR_CACHE_MAX) validatorCache.clear();
  validatorCache.set(key, compiled);
  return compiled;
};

export type StructuredOutputValidation =
  { success: true; value: unknown } | { success: false; error: Error };

/**
 * Validates a model-produced object against an agent's `output_schema`.
 *
 * A schema handed to the provider is only a `response_format` hint, and
 * `jsonSchema()` with no `validate` makes the SDK's `safeValidateTypes` a
 * pass-through — so without this check a model could return every required key
 * with correct types and garbage values, and a workflow's `payload_writes`
 * would propagate it as an answer.
 *
 * Constraints beyond `required`/`type` are the point — `minLength`, `enum`,
 * `pattern`, `minItems` separate a real answer from filler — which is why this
 * delegates to a full JSON Schema implementation rather than hand-checking a
 * subset that would silently ignore them.
 */
export const validateStructuredOutput = (schema: unknown) => {
  return (value: unknown): StructuredOutputValidation => {
    if (!isPlainObject(schema)) return { success: true, value };

    const validate = compileValidator(schema);
    if (!validate) return { success: true, value };

    if (validate(value)) return { success: true, value };

    const detail = (validate.errors ?? [])
      .map((entry) => {
        const path = entry.instancePath || '(root)';
        return `${path} ${entry.message ?? 'is invalid'}`;
      })
      .join('; ');
    return {
      success: false,
      error: new Error(
        `output does not satisfy output_schema: ${detail || 'unknown violation'}`
      ),
    };
  };
};

/**
 * Builds the AI SDK `output` specification used to constrain `generateText`
 * to return structured JSON matching the agent's `outputSchema`, alongside
 * ordinary tool calling. Returns `undefined` when no schema is configured.
 *
 * The `validate` hook is what makes the schema binding rather than advisory —
 * on a violation the SDK throws `NoObjectGeneratedError`, which
 * `toProviderDomainError` maps to `OUTPUT_SCHEMA_VALIDATION_FAILED` so the
 * generation is recorded `failed` instead of completing with a bad object.
 */
export const buildStructuredOutput = (
  schema: unknown
): ReturnType<typeof Output.object> | undefined => {
  if (!isPlainObject(schema)) return undefined;
  return Output.object({
    schema: jsonSchema(schema, { validate: validateStructuredOutput(schema) }),
  });
};

/**
 * Streaming generation pipes raw text chunks to the client and cannot also
 * enforce a structured-output schema, so the combination is rejected upfront.
 */
export const assertStreamingSupportsOutputSchema = (
  outputSchema: unknown
): void => {
  if (!outputSchema) return;
  throw new DomainError(
    'OUTPUT_SCHEMA_STREAMING_UNSUPPORTED',
    'Streaming generation does not support output_schema. Set stream to false, or remove output_schema from the agent.'
  );
};
