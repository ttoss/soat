/**
 * RFC 7230 `token` characters — the grammar for a valid HTTP header name.
 * Exported as a character class because `toolContext.ts` and
 * `toolTemplates.ts` compose it into their own key and token grammars.
 */
export const HEADER_TOKEN_CHARS = "A-Za-z0-9!#$%&'*+\\-.^_`|~";

const HEADER_TOKEN_RE = new RegExp(`^[${HEADER_TOKEN_CHARS}]+$`);

export const DEFAULT_HEADER_PREFIX = 'X-Soat-';

/**
 * The prefix on every header SOAT names, inbound and outbound: context
 * headers, tool assertions, webhook and formation-handler signatures. One
 * setting, so a platform fronting SOAT renames all of them at once and a new
 * header cannot be added outside it (`tests/harness/headerPrefix.test.mjs`).
 *
 * Read per call, so the value set is the value used whenever the module graph
 * was loaded. Empty or unset keeps the default.
 */
export const headerPrefix = (): string => {
  const configured = process.env.SOAT_HEADER_PREFIX;
  if (!configured) return DEFAULT_HEADER_PREFIX;
  // Outside the grammar, `fetch` fails every request with a `TypeError`
  // naming neither the variable nor the prefix.
  if (!HEADER_TOKEN_RE.test(configured)) {
    throw new Error(
      `SOAT_HEADER_PREFIX '${configured}' is not a valid HTTP header-name prefix — it may only contain letters, digits and the characters !#$%&'*+-.^_\`|~.`
    );
  }
  return configured;
};

/** `name` under the deployment's prefix: `Signature` → `X-Soat-Signature`. */
export const soatHeader = (name: string): string => {
  return `${headerPrefix()}${name}`;
};
