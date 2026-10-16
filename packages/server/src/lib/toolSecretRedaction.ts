import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';
import { SENSITIVE_PLACEHOLDER } from './sensitivePlaceholder';

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

/**
 * Query parameter names whose value is a credential, beyond the header names:
 * the bare `key` and request signatures several APIs take in the query string.
 */
const CREDENTIAL_QUERY_PATTERN = new RegExp(
  `${CREDENTIAL_HEADER_PATTERN.source}|^key$|^sig(nature)?$`,
  'i'
);

/** `{param}` is filled from the call's arguments, so it is no literal either. */
const isLiteral = (value: unknown): boolean => {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    !carriesReference(value) &&
    !/^\{[^{}]+\}$/.test(value)
  );
};

/** Userinfo (`https://user:pass@host`) or a credential-named query parameter. */
const urlCarriesLiteralCredential = (url: unknown): boolean => {
  if (typeof url !== 'string') return false;
  const userinfo = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@]*:([^/?#@]+)@/i.exec(url);
  if (userinfo && isLiteral(userinfo[1])) return true;
  const query = url.split('#')[0].split('?').slice(1).join('?');
  return query.split('&').some((pair) => {
    const [name, ...rest] = pair.split('=');
    return CREDENTIAL_QUERY_PATTERN.test(name) && isLiteral(rest.join('='));
  });
};

/**
 * Every place in one `execute` / `mcp` bag that holds a credential as a
 * literal, as a path relative to the bag. The one definition of a credential
 * slot: the write refusal and the read mask both walk it, so neither can cover
 * a slot the other misses.
 */
const literalCredentialSlots = (transport: unknown): string[] => {
  if (!isPlainObject(transport)) return [];
  const slots: string[] = [];
  if (urlCarriesLiteralCredential(transport.url)) slots.push('url');
  if (isPlainObject(transport.headers)) {
    for (const [name, value] of Object.entries(transport.headers)) {
      if (CREDENTIAL_HEADER_PATTERN.test(name) && isLiteral(value)) {
        slots.push(`headers.${name}`);
      }
    }
  }
  if (isPlainObject(transport.auth)) {
    for (const field of AUTH_SECRET_FIELDS) {
      if (isLiteral(transport.auth[field])) slots.push(`auth.${field}`);
    }
  }
  return slots;
};

/**
 * Every literal credential in a tool definition, inline pipeline steps
 * included, as a path into the definition.
 */
export const literalCredentialPaths = (tool: {
  execute?: unknown;
  mcp?: unknown;
  pipeline?: unknown;
}): string[] => {
  const paths: string[] = [];
  for (const field of ['execute', 'mcp'] as const) {
    for (const slot of literalCredentialSlots(tool[field])) {
      paths.push(`${field}.${slot}`);
    }
  }
  const { pipeline } = tool;
  if (isPlainObject(pipeline) && Array.isArray(pipeline.steps)) {
    for (const [index, step] of pipeline.steps.entries()) {
      if (!isPlainObject(step) || !isPlainObject(step.tool)) continue;
      for (const path of literalCredentialPaths(step.tool)) {
        paths.push(`pipeline.steps[${index}].tool.${path}`);
      }
    }
  }
  return paths;
};

/** Refuses a tool definition that carries any literal credential. */
export const assertNoLiteralCredentials = (tool: {
  execute?: unknown;
  mcp?: unknown;
  pipeline?: unknown;
}): void => {
  const paths = literalCredentialPaths(tool);
  if (paths.length === 0) return;
  throw new DomainError(
    'LITERAL_CREDENTIAL',
    `A credential cannot be written as a literal (${paths.join(', ')}); store it as a secret and reference it as {{secret:sec_...}}.`,
    { paths }
  );
};

/**
 * Masks the literal credentials of one `execute` / `mcp` bag. A tool
 * definition is readable by anyone holding `tools:GetTool`, a wider audience
 * than whoever wrote the credential into it; the placeholder is an object so a
 * read-edit-write round trip fails the schema's `type: string` check instead of
 * writing the mask back as the credential.
 */
const redactTransport = (transport: unknown): unknown => {
  const slots = literalCredentialSlots(transport);
  if (!isPlainObject(transport) || slots.length === 0) return transport;
  const redacted: Record<string, unknown> = { ...transport };
  for (const slot of slots) {
    const [field, key] = slot.split(/\.(.*)/s);
    if (key === undefined) {
      redacted[field] = SENSITIVE_PLACEHOLDER;
      continue;
    }
    const bag = { ...(redacted[field] as Record<string, unknown>) };
    bag[key] = SENSITIVE_PLACEHOLDER;
    redacted[field] = bag;
  }
  return redacted;
};

/**
 * Masks a tool definition, stored or inline, including every inline
 * definition nested in its pipeline steps. Applied where a definition leaves
 * the API, never in `mapTool` / `mapAgent`: a call builds its definition from
 * the mapped tool and a version archives the mapped agent, and both need the
 * real value.
 */
export const redactToolSecrets = <
  T extends { execute?: unknown; mcp?: unknown; pipeline?: unknown },
>(
  tool: T
): T => {
  const redacted: T = {
    ...tool,
    execute: redactTransport(tool.execute),
    mcp: redactTransport(tool.mcp),
  };
  const { pipeline } = tool;
  if (isPlainObject(pipeline) && Array.isArray(pipeline.steps)) {
    redacted.pipeline = {
      ...pipeline,
      steps: pipeline.steps.map((step: unknown) => {
        if (!isPlainObject(step) || !isPlainObject(step.tool)) return step;
        return { ...step, tool: redactToolSecrets(step.tool) };
      }),
    };
  }
  return redacted;
};

const redactToolBindings = (bindings: unknown): unknown => {
  if (!Array.isArray(bindings)) return bindings;
  return bindings.map((binding: unknown) => {
    if (!isPlainObject(binding) || !isPlainObject(binding.tool)) {
      return binding;
    }
    return { ...binding, tool: redactToolSecrets(binding.tool) };
  });
};

/**
 * Masks the inline tool definitions an agent — or an archived agent config —
 * carries in `tool_bindings`, on every surface an agent leaves through: its
 * routes, its version history and its `agents.*` event payloads.
 */
export const redactAgentToolSecrets = <T extends { tool_bindings?: unknown }>(
  agent: T
): T => {
  if (!('tool_bindings' in agent)) return agent;
  return { ...agent, tool_bindings: redactToolBindings(agent.tool_bindings) };
};
