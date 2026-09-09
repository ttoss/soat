import { DomainError } from '../errors';

/**
 * A URL a tenant stores for the deployment to request later — a webhook's
 * `url`, an AI provider's `base_url`.
 *
 * Shape only, and deliberately so: whether the destination may be *reached* is
 * the egress guard's question, and only the resolved address answers it. The
 * allowlist can also change between this write and the request, so a refusal
 * here would be a different answer from the one the request gets.
 *
 * What is settled here is what no later check would catch cleanly: a value that
 * is not a URL at all, a scheme the deployment never makes requests on, and
 * userinfo — a credential written into a URL is echoed by every log line and
 * every error that names it.
 */
export const assertTenantHttpUrl = (args: {
  url: string;
  field: string;
}): void => {
  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${args.field} must be an absolute http(s) URL.`,
      { field: args.field }
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${args.field} must use http or https, not '${parsed.protocol}'.`,
      { field: args.field }
    );
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${args.field} must not carry a username or password; link a secret instead.`,
      { field: args.field }
    );
  }
};
