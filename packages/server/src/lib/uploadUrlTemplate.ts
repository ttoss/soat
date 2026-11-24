import { DomainError } from '../errors';

export const UPLOAD_URL_TEMPLATE_ENV = 'FILES_UPLOAD_URL_TEMPLATE';

const TOKEN_PLACEHOLDER = '{token}';
const PROJECT_PLACEHOLDER = '{project_id}';

/**
 * The template an upload token's `upload_url` is built from, for a deployment
 * serving the token route somewhere other than this server's own path (a
 * gateway that re-roots routes under a project). Read per call; validated at
 * boot by `loadBootConfig`.
 */
export const readUploadUrlTemplate = (): string | undefined => {
  const value = process.env[UPLOAD_URL_TEMPLATE_ENV]?.trim();
  if (!value) return undefined;
  if (!value.includes(TOKEN_PLACEHOLDER)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${UPLOAD_URL_TEMPLATE_ENV} must contain ${TOKEN_PLACEHOLDER}: without it every upload URL would name no token.`
    );
  }
  return value;
};

/**
 * `upload_url` for a token: the template when one is set, else this server's
 * own route, absolute when `SOAT_BASE_URL` is set.
 */
export const buildUploadUrl = (args: {
  projectPublicId: string;
  token: string;
}): string => {
  const template = readUploadUrlTemplate();
  if (template) {
    return template
      .replaceAll(PROJECT_PLACEHOLDER, encodeURIComponent(args.projectPublicId))
      .replaceAll(TOKEN_PLACEHOLDER, encodeURIComponent(args.token));
  }
  const baseUrl = process.env.SOAT_BASE_URL?.replace(/\/$/, '') ?? '';
  return `${baseUrl}/api/v1/files/upload/${args.token}`;
};
