import { jsonSchema, Output } from 'ai';

import { DomainError } from '../errors';

export const isPlainObject = (
  value: unknown
): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

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
 * Builds the AI SDK `output` specification used to constrain `generateText`
 * to return structured JSON matching the agent's `outputSchema`, alongside
 * ordinary tool calling. Returns `undefined` when no schema is configured.
 */
export const buildStructuredOutput = (
  schema: unknown
): ReturnType<typeof Output.object> | undefined => {
  if (!isPlainObject(schema)) return undefined;
  return Output.object({ schema: jsonSchema(schema) });
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
