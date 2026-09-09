import { SENSITIVE_PLACEHOLDER } from './formationsSensitive';
import { isPlainObject } from './plainObject';

/**
 * Fields of an `http` tool's `execute.auth` that are the credential itself
 * (`toolAuthConfig.ts`). `access_key_id` is left readable: it names the key
 * rather than being the secret half, and it is what a reader needs to tell two
 * records apart.
 */
const AUTH_SECRET_FIELDS = [
  'secret_access_key',
  'session_token',
  'credentials',
];

/**
 * Header names whose value is a credential. Matched case-insensitively, since a
 * caller writes the header however they like.
 */
const CREDENTIAL_HEADER_PATTERN =
  /authorization|cookie|api[-_]?key|token|secret|password/i;

/**
 * A value carrying a template reference (`{{secret:sec_…}}`) is the wiring
 * rather than the credential, so it stays readable: masking it would leave a
 * reader unable to see which secret a tool uses, or that it uses one at all.
 * Presence of a reference is the test rather than the value being nothing but
 * one, because the real shape is a scheme around it (`Bearer {{secret:…}}`).
 */
const carriesReference = (value: string): boolean => {
  return /\{\{[^}]*\}\}/.test(value);
};

const redactValue = (value: unknown): unknown => {
  if (typeof value !== 'string' || carriesReference(value)) return value;
  return SENSITIVE_PLACEHOLDER;
};

const redactHeaders = (headers: unknown): unknown => {
  if (!isPlainObject(headers)) return headers;
  const redacted: Record<string, unknown> = { ...headers };
  for (const [name, value] of Object.entries(headers)) {
    if (CREDENTIAL_HEADER_PATTERN.test(name)) {
      redacted[name] = redactValue(value);
    }
  }
  return redacted;
};

const redactAuth = (auth: unknown): unknown => {
  if (!isPlainObject(auth)) return auth;
  const redacted: Record<string, unknown> = { ...auth };
  for (const field of AUTH_SECRET_FIELDS) {
    if (field in redacted) redacted[field] = redactValue(redacted[field]);
  }
  return redacted;
};

/**
 * Masks the credential-bearing parts of one `execute` / `mcp` bag. A tool
 * definition is readable by anyone holding `tools:GetTool`, which is a wider
 * audience than whoever wrote the credential into it — the same rule formations
 * follow, and the same placeholder, so a read-edit-write round trip fails the
 * schema's `type: string` check instead of writing the mask back as the
 * credential.
 */
const redactTransport = (transport: unknown): unknown => {
  if (!isPlainObject(transport)) return transport;
  const redacted: Record<string, unknown> = { ...transport };
  if ('headers' in redacted) {
    redacted.headers = redactHeaders(redacted.headers);
  }
  if ('auth' in redacted) redacted.auth = redactAuth(redacted.auth);
  return redacted;
};

export const redactToolSecrets = <
  T extends { execute?: unknown; mcp?: unknown },
>(
  tool: T
): T => {
  return {
    ...tool,
    execute: redactTransport(tool.execute),
    mcp: redactTransport(tool.mcp),
  };
};
