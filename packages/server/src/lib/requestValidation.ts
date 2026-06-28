import createDebug from 'debug';

import { DomainError } from '../errors';
import { getRequestSchemaFields } from './openapiSpec';

const log = createDebug('soat:requestValidation');

/**
 * Rejects request bodies that contain fields not declared in the given OpenAPI
 * request schema. The allowed-field set is derived from the spec — the single
 * source of truth for the REST contract, SDK, CLI, and MCP surface — so the
 * allowlist can never drift from the schema.
 *
 * Fields are compared in camelCase: the spec stores snake_case property names
 * and `getRequestSchemaFields` returns them as camelCase, matching the request
 * body after the caseTransform middleware has run.
 *
 * Validation is top-level only — nested object typos are not caught (see the
 * strict-field-validation PRD, Phase 3).
 *
 * @throws {DomainError} `VALIDATION_FAILED` (400) when any unknown field is present.
 */
export const rejectUnknownFields = (args: {
  schemaName: string;
  body: Record<string, unknown>;
}): void => {
  const { allowedFields } = getRequestSchemaFields({
    schemaName: args.schemaName,
  });

  const unknownFields = Object.keys(args.body).filter((key) => {
    return !allowedFields.has(key);
  });

  if (unknownFields.length > 0) {
    log(
      'rejectUnknownFields: schema=%s unknown=%o',
      args.schemaName,
      unknownFields
    );
    throw new DomainError(
      'VALIDATION_FAILED',
      `Unknown field(s): ${unknownFields.join(', ')}. Allowed: ${[
        ...allowedFields,
      ].join(', ')}`,
      { unknownFields }
    );
  }
};
