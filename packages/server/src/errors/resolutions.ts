import { ERROR_CODES } from './codes';

/**
 * The resolution hint carried by every error response, alongside `code` and
 * `message`.
 *
 * A code and a message say *what* went wrong. An agent handling the response
 * has to decide *what to do next*, and until now that knowledge lived only in
 * prose docs a caller had to already know to read. `hint` puts it in the
 * response, so a client — human or agent — can act on a failure it has never
 * seen before without leaving the response body.
 *
 * Hints are resolved per code, falling back to the HTTP status class. The
 * fallback is what makes the guarantee total: a code added to the registry
 * without an explicit entry still answers with an actionable hint rather than
 * an empty string, and `resolutions.test.ts` pins that for every code.
 */

/** Where the generated per-code reference page is published. */
export const ERROR_CODES_DOCS_URL =
  'https://soat.ttoss.dev/docs/error-codes' as const;

/**
 * What to do about a specific code, where the status class alone is too vague
 * to act on. Codes not listed here fall back to `STATUS_RESOLUTIONS`.
 */
export const ERROR_RESOLUTIONS: Record<string, string> = {
  UNAUTHORIZED:
    'Send `Authorization: Bearer <token>` — a user token from `POST /api/v1/users/login`, a project API key (`sk_…`), or an OAuth access token. Discovery metadata for the OAuth flow is at `/.well-known/oauth-authorization-server`.',
  FORBIDDEN:
    'The credential authenticated but is not allowed this action. Attach an IAM policy granting the action to the caller, or use a credential that has it.',
  API_KEY_PROJECT_SCOPE:
    "This API key is scoped to a single project and the request targets another one (or none). Omit `project_id` to use the key's own project, or use an unscoped credential.",
  RESOURCE_NOT_FOUND:
    'Check the id, and check that the credential can see the project that owns the resource — a resource in another project is indistinguishable from one that does not exist. List the collection to confirm.',
  VALIDATION_FAILED:
    'Fix the request and retry. Unknown fields are rejected outright, so compare the payload against the operation in `/openapi.json`; `meta` names the offending field when the check can identify one.',
  QUOTA_EXCEEDED:
    'Wait until the window resets — `Retry-After` (seconds) and `meta.resets_at` both carry the time — or raise the quota with `PATCH /api/v1/quotas/{quota_id}`.',
  AI_PROVIDER_ERROR:
    'The upstream model provider failed, not SOAT. Check the provider credential and the account behind it (credits, rate limits, model access), then retry with backoff.',
  AI_PROVIDER_MISCONFIGURED:
    'The provider record is missing something it needs to make a call — usually the API key secret or the base URL. Update the AI provider and retry.',
  EMBEDDING_NOT_CONFIGURED:
    'Knowledge search needs an embedding model. Configure one on the project or the AI provider before ingesting or searching.',
  INTERNAL_ERROR:
    'Retry with backoff. The underlying exception is logged server-side and deliberately never forwarded, so the response carries nothing further to act on.',
  NOT_IMPLEMENTED:
    'The operation exists in the contract but is not implemented on this deployment. Retrying will not change the outcome.',
  REQUEST_REJECTED:
    'The HTTP layer rejected the request before it reached a route — method, content type, or size. The message names the reason.',
  GENERATION_ALREADY_IN_PROGRESS:
    'A generation is already running for this target. Poll it to completion, or cancel it, before starting another.',
  SINGLE_SESSION_CONFLICT:
    'The agent allows one open session per actor. Reuse the session named in `meta.session_id`, or close it first.',
  SESSION_EXPIRED:
    "Open a new session; an expired one cannot be revived. Raise the agent's session TTL if this happens sooner than the workload needs.",
  SESSION_CLOSED:
    'The session is closed and accepts no further messages. Open a new one, or fork this one to keep its history.',
  NAME_CONFLICT:
    'A resource with this name already exists in the project. Pick another name, or update the existing resource instead of creating a second one.',
  ORCHESTRATION_VALIDATION_FAILED:
    'The orchestration graph is not runnable as declared. `meta` names the failing node or edge; `POST /api/v1/orchestrations/{orchestration_id}/validate` reports every problem at once.',
  ORCHESTRATION_CYCLE_DETECTED:
    'The graph has a cycle, so no topological order exists. Break the cycle named in `meta` — a loop belongs in a workflow, not a DAG.',
  UPLOAD_TOKEN_EXPIRED:
    'Request a fresh upload token; tokens are single-use and short-lived by design.',
  UPLOAD_TOKEN_USED:
    'This upload token has already been redeemed. Request a new one for another upload.',
  UNSUPPORTED_FILE_TYPE:
    "The file's media type has no parser on this deployment. Convert it to a supported type, or add an ingestion rule that does.",
  FILE_TOO_LARGE_FOR_SYNC:
    'The file is too large to parse inside the request. Call the same operation without `wait=true` and poll the handle it returns.',
  BOOTSTRAP_ALREADY_COMPLETED:
    'The first admin already exists, so bootstrap is closed for good. Sign in instead, and create further users with `POST /api/v1/users`.',
};

/**
 * The fallback hint for a status class. Deliberately short and generic: it is
 * the hint a code gets when nothing more specific is known about it, so it must
 * be true of every code that shares the status.
 */
export const STATUS_RESOLUTIONS: Record<number, string> = {
  400: 'Fix the request and retry — the payload, parameters, or referenced ids are invalid. Compare the request against the operation in `/openapi.json`.',
  401: 'Authenticate the request: send a valid bearer token or project API key in the `Authorization` header.',
  403: 'The credential is authenticated but lacks this action, or is scoped to another project. Grant the action in an IAM policy, or use a credential that has it.',
  404: 'Check the id and the project the credential can see, then retry. Listing the collection confirms whether the resource exists.',
  409: 'The request is well-formed but the resource is not in a state that allows it. Resolve the conflicting state named in the message, then retry.',
  410: 'The resource existed and is gone for good. Create a new one; retrying against this id will keep failing.',
  413: 'The payload exceeds the accepted size. Send less in one request, or use the upload flow for large bodies.',
  422: 'The request was accepted and then could not be carried out. The failure is in the work, not the request shape — read `meta` and the trace for which step failed before retrying.',
  429: 'Back off and retry after the window named by `Retry-After`.',
  500: 'Retry with backoff. If it persists, the server log carries the detail the response deliberately omits.',
  501: 'Not implemented on this deployment. Retrying will not change the outcome.',
  502: 'An upstream dependency failed rather than SOAT itself. Retry with backoff and check that dependency.',
  503: 'A capability this operation needs is not configured on this deployment. Configure it — the message names which — rather than retrying.',
};

/**
 * The last-resort hint, for a code the registry does not know — `resolutionFor`
 * takes a plain string so the docs generators and log lines can call it, which
 * means "not a registered code" is a reachable input, not a defensive branch.
 */
export const DEFAULT_RESOLUTION =
  'Read `code` against the catalog at https://soat.ttoss.dev/errors.json to decide how to proceed.';

/**
 * Built once from the registry. Keyed by plain string so a caller that only has
 * the code as text — the docs generators, a log line — can look it up without
 * narrowing to `ErrorCode` first.
 */
const STATUS_BY_CODE = new Map<string, number>(
  Object.entries(ERROR_CODES).map(([code, entry]) => {
    return [code, entry.httpStatus];
  })
);

/**
 * What a caller should do about `code`. Never empty — an explicit entry, else
 * the status-class fallback, else `DEFAULT_RESOLUTION`.
 */
export const resolutionFor = (args: { code: string }): string => {
  const explicit = ERROR_RESOLUTIONS[args.code];
  if (explicit) return explicit;

  const status = STATUS_BY_CODE.get(args.code);
  return (
    (status !== undefined ? STATUS_RESOLUTIONS[status] : undefined) ??
    DEFAULT_RESOLUTION
  );
};

/** The reference-page anchor for `code`, as an absolute URL. */
export const docsUrlFor = (args: { code: string }): string => {
  return `${ERROR_CODES_DOCS_URL}#${args.code.toLowerCase()}`;
};
