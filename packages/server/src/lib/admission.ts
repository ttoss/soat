/**
 * Admission: a service the deployment registers (`admission` in the
 * `IAM_REGISTRATIONS_CONFIG` file) is asked before a declared runtime write
 * executes, after authorization allowed it. It may refuse; it can never turn a
 * refusal into a pass. Asked by `middleware/admission.ts` (REST and `builtin`),
 * `defineFormationModule` (formation create and update), and for work the
 * runtime does on its own by `assertAllowedUnder` and the embedding writes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import createDebug from 'debug';

import { DomainError } from '../errors';
import { readCappedText } from './cappedBody';
import {
  type FormationHandlerConfig,
  parseHandler,
} from './formationResourceTypeConfig';
import { signatureHeader, timestampedSignature } from './hmacSignature';
import { readIamRegistrationFile } from './iamRegistrations';
import { isObjectRecord } from './openapiSchemaFields';
import { listWriteActions } from './openapiSpec';
import type { RequestPrincipal } from './principals';
import { PROTOCOL_ANSWER_MAX_BYTES } from './requestBounds';
import { isTimeoutError } from './timeoutError';

const log = createDebug('soat:admission');

/** What an unanswered ask about internal work comes to; REST, `builtin` and formations always refuse. */
export type OnUnavailable = 'refuse' | 'allow';

export type AdmissionRegistration = {
  handler: FormationHandlerConfig;
  actions: ReadonlySet<string>;
  onUnavailable: OnUnavailable;
};

const fail = (args: { source: string; message: string }): never => {
  throw new Error(
    `Invalid IAM registrations config (${args.source}): ${args.message}`
  );
};

/** Only a runtime write can be gated: a read or a deployment's own action is refused at boot. */
const parseActions = (args: {
  value: unknown;
  source: string;
}): Set<string> => {
  const { value, source } = args;
  if (!Array.isArray(value) || value.length === 0) {
    return fail({
      source,
      message: '`admission.actions` must be a non-empty array',
    });
  }
  const writes = listWriteActions();
  const actions = new Set<string>();
  for (const action of value) {
    if (typeof action !== 'string' || !writes.has(action)) {
      return fail({
        source,
        message: `\`admission.actions\`: '${String(action)}' is not a runtime write action`,
      });
    }
    actions.add(action);
  }
  return actions;
};

const parseOnUnavailable = (args: {
  value: unknown;
  source: string;
}): OnUnavailable => {
  if (args.value === undefined) return 'refuse';
  if (args.value === 'refuse' || args.value === 'allow') return args.value;
  return fail({
    source: args.source,
    message: "`admission.on_unavailable` must be 'refuse' or 'allow'",
  });
};

export const parseAdmissionRegistration = (args: {
  config: unknown;
  source: string;
  env: Record<string, string | undefined>;
}): AdmissionRegistration | null => {
  const { source, env } = args;
  const value = isObjectRecord(args.config) ? args.config.admission : undefined;
  if (value === undefined) return null;
  if (!isObjectRecord(value)) {
    return fail({ source, message: '`admission` must be an object' });
  }
  return {
    handler: parseHandler({
      handler: value.handler,
      env,
      source,
      at: 'admission: ',
      fail,
    }),
    actions: parseActions({ value: value.actions, source }),
    onUnavailable: parseOnUnavailable({ value: value.on_unavailable, source }),
  };
};

let registered: AdmissionRegistration | null = null;

/** `null` unregisters; tests must not leak a registration into another file. */
export const registerAdmission = (args: {
  registration: AdmissionRegistration | null;
}): void => {
  registered = args.registration;
};

export const isAdmissionDeclared = (action: string): boolean => {
  return registered?.actions.has(action) ?? false;
};

/** Called once at boot; any problem fails the boot. */
export const initAdmission = (): void => {
  const file = readIamRegistrationFile({ env: process.env });
  if (!file) return;
  registerAdmission({
    registration: parseAdmissionRegistration({ ...file, env: process.env }),
  });
};

export type AdmissionRequest = {
  action: string;
  projectPublicId: string | null;
  resourceType: string | null;
  /** The resource an edit targets; `null` on a create. */
  targetId: string | null;
  /** The write as it will be applied. */
  body: unknown;
  principal: RequestPrincipal;
};

const unavailable = (args: { action: string; detail: string }): DomainError => {
  return new DomainError(
    'ADMISSION_UNAVAILABLE',
    `The admission service did not answer for ${args.action}: ${args.detail}`,
    { action: args.action }
  );
};

/**
 * `AdmissionRefusal.error.code`'s pattern in `admission.yaml`;
 * `admission.test.ts` holds the two equal.
 */
export const REFUSAL_CODE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

type ServiceRefusal = {
  code: string;
  message: string;
  hint: string | undefined;
  meta: Record<string, unknown> | undefined;
};

const isOptionalHint = (hint: unknown): hint is string | undefined => {
  return hint === undefined || (typeof hint === 'string' && hint !== '');
};

/** The `{ error: { code, message, hint?, meta? } }` a refusal carries, or `null` when it is malformed. */
const readRefusal = (raw: string): ServiceRefusal | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const error = isObjectRecord(parsed) ? parsed.error : undefined;
  if (!isObjectRecord(error)) return null;
  const { code, message, hint, meta } = error;
  if (typeof code !== 'string' || !REFUSAL_CODE_PATTERN.test(code)) return null;
  if (typeof message !== 'string') return null;
  if (!isOptionalHint(hint)) return null;
  if (meta !== undefined && !isObjectRecord(meta)) return null;
  return { code, message, hint, meta };
};

/** A 4xx refusal is relayed under its own status and code; anything else is a 502. */
const refusalFrom = (args: {
  action: string;
  status: number;
  raw: string;
}): DomainError => {
  const { action, status } = args;
  const refusal = status >= 400 && status < 500 ? readRefusal(args.raw) : null;
  if (!refusal) {
    return unavailable({
      action,
      detail: `HTTP ${status} outside the admission protocol`,
    });
  }
  return new DomainError('ADMISSION_REFUSED', refusal.message, refusal.meta, {
    relayed: { code: refusal.code, httpStatus: status, hint: refusal.hint },
  });
};

const wireBody = (request: AdmissionRequest): string => {
  return JSON.stringify({
    action: request.action,
    project_id: request.projectPublicId,
    resource_type: request.resourceType,
    resource_id: request.targetId,
    body: request.body,
    principal: {
      type: request.principal.principalType,
      id: request.principal.principalId,
    },
  });
};

const askService = async (args: {
  request: AdmissionRequest;
  handler: FormationHandlerConfig;
}): Promise<void> => {
  const { request, handler } = args;
  log(
    'askService: action=%s project=%s resource=%s',
    request.action,
    request.projectPublicId,
    request.targetId
  );

  const payload = wireBody(request);
  const unanswered = (failure: { error: unknown }) => {
    return unavailable({
      action: request.action,
      detail: isTimeoutError(failure)
        ? `timed out after ${handler.timeoutMs}ms`
        : 'unreachable',
    });
  };
  let response: Response;
  try {
    response = await fetch(handler.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [signatureHeader()]: timestampedSignature({
          payload,
          secret: handler.secret,
        }),
      },
      body: payload,
      signal: AbortSignal.timeout(handler.timeoutMs),
    });
  } catch (error) {
    throw unanswered({ error });
  }

  const raw = await readCappedText({
    response,
    maxBytes: PROTOCOL_ANSWER_MAX_BYTES,
    refusal: () => {
      return unavailable({
        action: request.action,
        detail: 'answer too large',
      });
    },
    onReadError: unanswered,
  });
  if (response.ok) {
    log('askService: admitted action=%s', request.action);
    return;
  }
  log(
    'askService: refused action=%s status=%d',
    request.action,
    response.status
  );
  throw refusalFrom({
    action: request.action,
    status: response.status,
    raw,
  });
};

/** The asks a request made, so the work it runs is not asked again. */
const askedInRequest = new AsyncLocalStorage<Set<string>>();

const askKey = (args: { action: string; targetId: string | null }): string => {
  return `${args.action} ${args.targetId ?? '*'}`;
};

/** Runs a request's handling in a scope of its own; a nested `builtin` call opens its own. */
export const runInAdmissionScope = <T>(fn: () => T): T => {
  return askedInRequest.run(new Set(), fn);
};

const askedAlready = (args: {
  action: string;
  targetId: string | null;
}): boolean => {
  const asked = askedInRequest.getStore();
  if (!asked) return false;
  return (
    asked.has(askKey(args)) ||
    asked.has(askKey({ action: args.action, targetId: null }))
  );
};

/**
 * Asks the registered service about a declared action; an undeclared one
 * costs nothing. Throws its refusal, or `ADMISSION_UNAVAILABLE` when it cannot
 * answer: an unanswered question is never a pass.
 */
export const assertAdmitted = async (
  request: AdmissionRequest
): Promise<void> => {
  const registration = registered;
  if (!registration?.actions.has(request.action)) return;
  askedInRequest.getStore()?.add(askKey(request));
  await askService({ request, handler: registration.handler });
};

/** The refusals `assertWorkAdmitted` threw, as opposed to a REST or `builtin` write's. */
const stepRefusals = new WeakSet<DomainError>();

/**
 * Asks about a step of work the runtime takes on its own (a generation, a
 * tool call, a start, an embedding write), unless the request it runs in
 * already asked. `body` is `null`: the step has no wire shape. An unanswered
 * ask passes only under `on_unavailable: allow`.
 */
export const assertWorkAdmitted = async (
  request: Omit<AdmissionRequest, 'body'>
): Promise<void> => {
  const registration = registered;
  if (!registration?.actions.has(request.action)) return;
  if (askedAlready(request)) return;
  try {
    await askService({
      request: { ...request, body: null },
      handler: registration.handler,
    });
  } catch (error) {
    if (
      registration.onUnavailable === 'allow' &&
      error instanceof DomainError &&
      error.code === 'ADMISSION_UNAVAILABLE'
    ) {
      log('assertWorkAdmitted: unanswered, allowed action=%s', request.action);
      return;
    }
    if (error instanceof DomainError) stepRefusals.add(error);
    throw error;
  }
};

/** The reason a refusal leaves on the work it pauses, within the `pause_reason` column. */
export const refusalPauseReason = (error: DomainError): string => {
  return `${error.wireCode}: ${error.message}`.slice(0, 256);
};

/**
 * Whether `error` is admission's refusal of a step of work, which pauses or
 * stops that work. A write a `builtin` call makes is refused as a REST call
 * and fails like any other tool call.
 */
export const isAdmissionRefusal = (error: unknown): error is DomainError => {
  return error instanceof DomainError && stepRefusals.has(error);
};
