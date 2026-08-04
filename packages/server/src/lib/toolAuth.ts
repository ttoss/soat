import { signAwsSigV4 } from './toolAuthAwsSigV4';
import type { HttpToolAuthConfig } from './toolAuthConfig';
import { getGcpAccessToken } from './toolAuthGcp';

export { signAwsSigV4 } from './toolAuthAwsSigV4';
export {
  type AwsSigV4AuthConfig,
  type GcpServiceAccountAuthConfig,
  type HttpToolAuthConfig,
  parseHttpToolAuthConfig,
  validateExecuteAuth,
  validateHttpToolAuth,
} from './toolAuthConfig';

/**
 * Computes the credential headers for one request. Returns only the headers to
 * merge — the caller owns the request, so signing stays a pure function of the
 * already-final method, url, headers and body.
 */
export const applyHttpToolAuth = async (args: {
  auth: HttpToolAuthConfig;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  now?: Date;
}): Promise<Record<string, string>> => {
  const now = args.now ?? new Date();

  if (args.auth.type === 'aws_sigv4') {
    return signAwsSigV4({
      auth: args.auth,
      method: args.method,
      url: args.url,
      headers: args.headers,
      body: args.body,
      now,
    }).headers;
  }

  const accessToken = await getGcpAccessToken({ auth: args.auth, now });

  return { Authorization: `Bearer ${accessToken}` };
};

/**
 * Merges credential headers over the request headers, dropping any existing
 * entry with the same name in a different casing. Two keys differing only by
 * case both survive an object spread and `Headers` would join their values with
 * a comma — which for `Authorization` or `X-Amz-Date` sends something other
 * than what was signed.
 */
export const mergeAuthHeaders = (args: {
  headers: Record<string, string>;
  authHeaders: Record<string, string>;
}): Record<string, string> => {
  const authNames = new Set(
    Object.keys(args.authHeaders).map((name) => {
      return name.toLowerCase();
    })
  );

  const kept = Object.entries(args.headers).filter(([name]) => {
    return !authNames.has(name.toLowerCase());
  });

  return { ...Object.fromEntries(kept), ...args.authHeaders };
};
