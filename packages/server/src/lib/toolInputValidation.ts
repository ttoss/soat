import createDebug from 'debug';

import { DomainError } from '../errors';
import { compileJsonSchema, describeSchemaErrors } from './jsonSchemaValidator';

const log = createDebug('soat:toolInputValidation');

/**
 * Types whose `parameters` are the input contract. An `mcp` tool's actions
 * declare their own on the server, a `builtin` tool's come from the spec, and
 * a `client` tool runs on the caller's side.
 */
const VALIDATED_TYPES = new Set(['http', 'pipeline']);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * `VALIDATION_FAILED` when `input`, presets merged in, does not satisfy the
 * tool's `parameters`. A schema ajv cannot compile is not checked.
 */
export const assertToolInputValid = (args: {
  tool: { name: string; type?: string | null; parameters?: unknown };
  input: Record<string, unknown>;
}): void => {
  if (!VALIDATED_TYPES.has(args.tool.type ?? 'http')) return;
  if (!isRecord(args.tool.parameters)) return;
  const validate = compileJsonSchema(args.tool.parameters);
  if (!validate || validate(args.input)) return;
  log('assertToolInputValid: refused tool=%s', args.tool.name);
  throw new DomainError(
    'VALIDATION_FAILED',
    `The input does not satisfy tool '${args.tool.name}' parameters: ${describeSchemaErrors(validate.errors)}`
  );
};
