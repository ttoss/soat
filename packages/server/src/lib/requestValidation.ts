import createDebug from 'debug';

import { DomainError } from '../errors';
import { getRouteRequestSchemaFields } from './openapiSpec';

const log = createDebug('soat:requestValidation');

/**
 * Rejects request bodies that contain fields not declared in the route's
 * OpenAPI request schema. The allowed-field set is derived from the spec — the
 * single source of truth for the REST contract, SDK, CLI, and MCP surface — so
 * the allowlist can never drift from the schema.
 *
 * `path` is the route as registered on the router (e.g. `/agents/:agent_id`);
 * it is normalized to the OpenAPI path key internally. Fields are compared in
 * camelCase, matching the request body after the caseTransform middleware has
 * run.
 *
 * No-ops when the route has no property-based JSON body schema (no request body,
 * or an open `additionalProperties` map such as a tags endpoint).
 *
 * Validation is top-level only — nested object typos are not caught (see the
 * strict-field-validation PRD, Phase 3).
 *
 * @throws {DomainError} `VALIDATION_FAILED` (400) when any unknown field is present.
 */
export const rejectUnknownFields = (args: {
  method: string;
  path: string;
  body: Record<string, unknown>;
}): void => {
  const fields = getRouteRequestSchemaFields({
    method: args.method,
    path: args.path,
  });

  if (!fields) return;

  const unknownFields = Object.keys(args.body ?? {}).filter((key) => {
    return !fields.allowedFields.has(key);
  });

  if (unknownFields.length > 0) {
    log(
      'rejectUnknownFields: %s %s unknown=%o',
      args.method,
      args.path,
      unknownFields
    );
    throw new DomainError(
      'VALIDATION_FAILED',
      `Unknown field(s): ${unknownFields.join(', ')}. Allowed: ${[
        ...fields.allowedFields,
      ].join(', ')}`,
      { unknownFields }
    );
  }
};
