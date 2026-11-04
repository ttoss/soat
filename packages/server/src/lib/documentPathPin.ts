import { DomainError } from '../errors';
import { normalizePath } from './filePaths';

/**
 * The directory a `path_prefix` names, with the same boundary rule as the
 * listing filter (`pathPrefixPattern`): `/a` and `/a/` both mean `/a/`, so a
 * pin on `/x/actor_ab` never reaches `/x/actor_abc/`.
 */
const pinDirectory = (pin: string): string => {
  const normalized = normalizePath(pin);
  return normalized === '/' ? '/' : `${normalized}/`;
};

export const isUnderPathPin = (args: {
  path: string | null | undefined;
  pin: string;
}): boolean => {
  if (!args.path) return false;
  return normalizePath(args.path).startsWith(pinDirectory(args.pin));
};

/** A document the pinned call could reach is one it may see; others are `404`. */
export const assertDocumentUnderPathPin = (args: {
  path: string | null | undefined;
  pin: string | undefined;
}): void => {
  if (
    args.pin === undefined ||
    isUnderPathPin({ path: args.path, pin: args.pin })
  )
    return;
  throw new DomainError('RESOURCE_NOT_FOUND', 'Document not found');
};

/** Where a write would file a document, refused when outside the pin. */
export const assertPathInsidePin = (args: {
  path: string | null;
  pin: string | undefined;
}): void => {
  if (
    args.pin === undefined ||
    isUnderPathPin({ path: args.path, pin: args.pin })
  )
    return;
  throw new DomainError(
    'DOCUMENT_PATH_OUTSIDE_PREFIX',
    `The document would be filed at ${args.path ?? 'no path'}, outside '${args.pin}'.`,
    { path: args.path, path_prefix: args.pin }
  );
};
