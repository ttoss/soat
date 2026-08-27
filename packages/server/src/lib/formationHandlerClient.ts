/**
 * The wire half of an operator-registered formation resource type (#1078): one
 * signed `POST` per lifecycle operation to the URL the registration names.
 * Ordering, `{ref}` resolution, apply, rollback, recording and drift stay in
 * SOAT; the handler owns only what its resource means.
 *
 * No retries. A create that timed out may well have created the resource, and a
 * blind retry would provision a second one with no id the engine knows. The
 * failure enters the normal apply-failure path instead.
 * `X-Soat-Idempotency-Key` covers the case that is safe to repeat — an operator
 * re-running a failed deploy.
 */

import createDebug from 'debug';

import { DomainError } from '../errors';
import type { FormationResourceTypeRegistration } from './formationResourceTypeConfig';
import {
  hmacHex,
  SIGNATURE_HEADER,
  timestampedSignature,
} from './hmacSignature';
import { isObjectRecord } from './openapiSchemaFields';

const log = createDebug('soat:formations:handler');

export const IDEMPOTENCY_HEADER = 'X-Soat-Idempotency-Key';

export type HandlerRequestType =
  'create' | 'update' | 'delete' | 'validate' | 'read';

/**
 * The request body, in the snake_case every other SOAT wire surface uses. It is
 * built key by key here — the properties bag is copied as a **value**, so a
 * handler-owned key inside it is never inspected or rewritten
 * (`.claude/rules/case-convention.md`).
 */
export type HandlerRequest = {
  requestType: HandlerRequestType;
  logicalId: string;
  /** Stable per (formation, logical id) — the idempotency anchor. */
  resourceKey: string;
  projectPublicId?: string;
  physicalResourceId?: string;
  properties?: Record<string, unknown>;
};

const buildBody = (args: {
  request: HandlerRequest;
  resourceType: string;
}): Record<string, unknown> => {
  const { request, resourceType } = args;
  return {
    request_type: request.requestType,
    resource_type: resourceType,
    logical_id: request.logicalId,
    ...(request.projectPublicId !== undefined
      ? { project_id: request.projectPublicId }
      : {}),
    ...(request.physicalResourceId !== undefined
      ? { physical_resource_id: request.physicalResourceId }
      : {}),
    ...(request.properties !== undefined
      ? { properties: request.properties }
      : {}),
  };
};

/**
 * Stable across re-applies of the same logical resource, distinct between
 * resources and between operations. Derived rather than random: a key a retry
 * cannot reproduce is not an idempotency key.
 */
const idempotencyKey = (args: {
  resourceType: string;
  request: HandlerRequest;
}): string => {
  return hmacHex({
    secret: args.resourceType,
    value: `${args.request.resourceKey}.${args.request.requestType}`,
  });
};

const failureMessage = (args: {
  resourceType: string;
  requestType: HandlerRequestType;
  detail: string;
}): string => {
  return `Formation handler for '${args.resourceType}' failed on ${args.requestType}: ${args.detail}`;
};

const handlerError = (args: {
  resourceType: string;
  requestType: HandlerRequestType;
  detail: string;
}): DomainError => {
  return new DomainError('FORMATION_HANDLER_FAILED', failureMessage(args), {
    resource_type: args.resourceType,
    request_type: args.requestType,
  });
};

/**
 * The handler's own `message`, when it sent a JSON body carrying one — the only
 * thing that can say *why* this resource was refused, so it is relayed verbatim.
 */
const errorDetail = (args: { raw: string; status: number }): string => {
  try {
    const parsed: unknown = JSON.parse(args.raw);
    if (isObjectRecord(parsed) && typeof parsed.message === 'string') {
      return `${parsed.message} (HTTP ${args.status})`;
    }
  } catch {
    // A non-JSON error body is reported by status alone.
  }
  return `HTTP ${args.status}`;
};

const parseResponse = async (args: {
  response: Response;
  resourceType: string;
  requestType: HandlerRequestType;
}): Promise<Record<string, unknown>> => {
  const { response, resourceType, requestType } = args;
  const raw = await response.text();

  if (!response.ok) {
    throw handlerError({
      resourceType,
      requestType,
      detail: errorDetail({ raw, status: response.status }),
    });
  }

  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    throw handlerError({
      resourceType,
      requestType,
      detail: 'response body was not JSON',
    });
  }

  if (!isObjectRecord(parsed)) {
    throw handlerError({
      resourceType,
      requestType,
      detail: 'response body was not a JSON object',
    });
  }

  return parsed;
};

/**
 * Performs one signed handler call and returns its parsed 2xx body.
 *
 * Every non-2xx, unreachable host, timeout, and non-object body throws — a
 * handler that cannot answer must never read as a silent success, which for a
 * `create` would record a resource that does not exist.
 */
export const callFormationHandler = async (args: {
  registration: FormationResourceTypeRegistration;
  request: HandlerRequest;
}): Promise<Record<string, unknown>> => {
  const { registration, request } = args;
  const resourceType = registration.name;
  const requestType = request.requestType;

  const payload = JSON.stringify(buildBody({ request, resourceType }));

  log(
    'calling handler: type=%s op=%s logicalId=%s',
    resourceType,
    requestType,
    request.logicalId
  );

  let response: Response;
  try {
    response = await fetch(registration.handler.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: timestampedSignature({
          payload,
          secret: registration.handler.secret,
        }),
        [IDEMPOTENCY_HEADER]: idempotencyKey({ resourceType, request }),
      },
      body: payload,
      signal: AbortSignal.timeout(registration.handler.timeoutMs),
    });
  } catch (error) {
    const detail =
      error instanceof Error && error.name === 'TimeoutError'
        ? `request timed out after ${registration.handler.timeoutMs}ms`
        : `request failed: ${error instanceof Error ? error.message : String(error)}`;
    throw handlerError({ resourceType, requestType, detail });
  }

  return parseResponse({ response, resourceType, requestType });
};

/**
 * The `physical_resource_id` a create or update must answer with. A 2xx that
 * omits it is a protocol violation rather than a resource without an id:
 * recording one would leave a resource the engine can never address again —
 * neither an update nor a delete would have anything to send.
 */
export const requirePhysicalResourceId = (args: {
  body: Record<string, unknown>;
  resourceType: string;
  requestType: HandlerRequestType;
}): string => {
  const value = args.body.physical_resource_id;
  if (typeof value !== 'string' || value.length === 0) {
    throw handlerError({
      resourceType: args.resourceType,
      requestType: args.requestType,
      detail: 'response did not carry a `physical_resource_id`',
    });
  }
  return value;
};
