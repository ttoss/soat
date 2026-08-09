import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';

/**
 * Credential strategies for `http` tools. AWS and GCP are ordinary HTTPS+JSON
 * APIs — the only thing a static `headers` map cannot express is the
 * `Authorization` value itself: SigV4 is an HMAC computed per request over the
 * canonical request, and a GCP access token is minted from a signed JWT and
 * expires. Both are therefore modeled as an auth strategy on the existing
 * `http` transport rather than as new tool types, so `output_mapping`,
 * `body_mode`, guardrails, approvals, pipelines and error mapping keep working
 * unchanged.
 */
export type AwsSigV4AuthConfig = {
  type: 'aws_sigv4';
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type GcpServiceAccountAuthConfig = {
  type: 'gcp_service_account';
  credentials: string;
  scopes: string[];
};

export type HttpToolAuthConfig =
  AwsSigV4AuthConfig | GcpServiceAccountAuthConfig;

const AUTH_TYPES = ['aws_sigv4', 'gcp_service_account'] as const;

export const asString = (value: unknown): string | undefined => {
  return typeof value === 'string' && value ? value : undefined;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => {
    return typeof entry === 'string' && !!entry;
  });
};

// ── Config parsing (wire snake_case → internal camelCase) ───────────────────

const parseAwsSigV4Config = (
  value: Record<string, unknown>
): AwsSigV4AuthConfig | undefined => {
  const region = asString(value.region);
  const service = asString(value.service);
  const accessKeyId = asString(value.access_key_id);
  const secretAccessKey = asString(value.secret_access_key);

  if (!region || !service || !accessKeyId || !secretAccessKey) {
    return undefined;
  }

  return {
    type: 'aws_sigv4',
    region,
    service,
    accessKeyId,
    secretAccessKey,
    sessionToken: asString(value.session_token),
  };
};

const parseGcpConfig = (
  value: Record<string, unknown>
): GcpServiceAccountAuthConfig | undefined => {
  const credentials = asString(value.credentials);
  const scopes = asStringArray(value.scopes);

  if (!credentials || scopes.length === 0) {
    return undefined;
  }

  return { type: 'gcp_service_account', credentials, scopes };
};

/**
 * Reads the stored/authored `execute.auth` bag into its internal shape. The
 * bag is wire-shaped (nothing rewrites request keys), so only snake_case names
 * are read — unlike `body_mode`, this field has no pre-single-casing rows to
 * stay compatible with.
 */
export const parseHttpToolAuthConfig = (
  value: unknown
): HttpToolAuthConfig | undefined => {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const type = asString(value.type);

  if (type === 'aws_sigv4') return parseAwsSigV4Config(value);
  if (type === 'gcp_service_account') return parseGcpConfig(value);

  return undefined;
};

// ── Write-time validation ──────────────────────────────────────────────────

const requireField = (args: { value: unknown; field: string }): void => {
  if (!asString(args.value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `execute.auth.${args.field} is required and must be a non-empty string.`
    );
  }
};

const validateAwsSigV4Auth = (args: {
  auth: Record<string, unknown>;
  bodyMode?: 'json' | 'multipart';
}): void => {
  requireField({ value: args.auth.region, field: 'region' });
  requireField({ value: args.auth.service, field: 'service' });
  requireField({ value: args.auth.access_key_id, field: 'access_key_id' });
  requireField({
    value: args.auth.secret_access_key,
    field: 'secret_access_key',
  });

  // SigV4 signs a hash of the exact request payload, but in multipart mode
  // `fetch` generates the body and its boundary itself — the bytes that go on
  // the wire are not knowable at signing time, so any signature produced here
  // would be rejected upstream. Reject the combination instead of shipping a
  // request that always fails with an opaque 403.
  if (args.bodyMode === 'multipart') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'execute.auth type aws_sigv4 does not support body_mode "multipart"; the request payload must be hashable at signing time.'
    );
  }
};

const validateGcpAuth = (auth: Record<string, unknown>): void => {
  requireField({ value: auth.credentials, field: 'credentials' });

  if (asStringArray(auth.scopes).length === 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'execute.auth.scopes is required and must be a non-empty array of strings.'
    );
  }
};

/**
 * Validates an authored `execute.auth` bag at write time, so a malformed
 * credential config fails on `POST /tools` instead of at first call. Reads the
 * wire (snake_case) spelling, since it runs on the request body verbatim.
 */
export const validateHttpToolAuth = (args: {
  auth: unknown;
  bodyMode?: 'json' | 'multipart';
}): void => {
  if (args.auth === undefined || args.auth === null) {
    return;
  }

  if (!isPlainObject(args.auth)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'execute.auth must be an object.'
    );
  }

  const type = asString(args.auth.type);

  if (!type || !(AUTH_TYPES as readonly string[]).includes(type)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Unsupported execute.auth type '${type ?? ''}'. Supported types: ${AUTH_TYPES.join(', ')}.`
    );
  }

  if (type === 'aws_sigv4') {
    validateAwsSigV4Auth({ auth: args.auth, bodyMode: args.bodyMode });
    return;
  }

  validateGcpAuth(args.auth);
};

/**
 * Single source of truth for the `execute.auth` business rule, shared by the
 * REST create/update paths and the tools formation module (see
 * `.claude/rules/modules.md` — a business rule lives in the lib, never
 * duplicated per transport).
 */
export const validateExecuteAuth = (args: { execute: unknown }): void => {
  if (!isPlainObject(args.execute)) {
    return;
  }

  // Mirrors `parseHttpExecuteConfig`'s `bodyMode ?? body_mode` precedence
  // exactly. Reading only the wire spelling here would let an authored
  // `bodyMode: 'multipart'` pass validation and then be honored at execution,
  // producing a signature over a payload hash that does not match the body.
  const rawBodyMode = args.execute.bodyMode ?? args.execute.body_mode;

  validateHttpToolAuth({
    auth: args.execute.auth,
    bodyMode: rawBodyMode === 'multipart' ? 'multipart' : 'json',
  });
};

export const toolAuthFailed = (args: {
  message: string;
  meta?: Record<string, unknown>;
}): DomainError => {
  return new DomainError('TOOL_AUTH_FAILED', args.message, args.meta);
};
