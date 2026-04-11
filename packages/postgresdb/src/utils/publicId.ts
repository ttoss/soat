import { customAlphabet } from 'nanoid';

/**
 * Public ID prefixes for each entity type (Stripe-style)
 * They can have 2 to 6 characters before the underscore.
 */
export const PUBLIC_ID_PREFIXES = {
  file: 'file_',
  user: 'usr_',
  project: 'proj_',
  policy: 'pol_',
  apiKey: 'key_',
  document: 'doc_',
  actor: 'act_',
} as const;

/**
 * Prefix for raw API key values (shown once at creation, then hashed).
 * Format: sk_{random} — distinguishable from JWTs (which start with 'eyJ').
 */
export const API_KEY_RAW_PREFIX = 'sk_';

export type PublicIdPrefix =
  (typeof PUBLIC_ID_PREFIXES)[keyof typeof PUBLIC_ID_PREFIXES];

/**
 * Generates a Stripe-style public ID with the given prefix.
 * Format: {prefix}{16-character nanoid}
 * Example: file_V1StGXR8Z5jdHi6B
 *
 * @param prefix - The prefix for the entity type (e.g., 'file_')
 * @returns A unique public ID string
 */
export const generatePublicId = (prefix: PublicIdPrefix): string => {
  const nanoid = customAlphabet(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    16
  );
  return `${prefix}${nanoid()}`;
};

/**
 * Validates if a string matches a public ID format
 * @param id - The ID to validate
 * @param prefix - Expected prefix
 * @returns true if valid
 */
export const isValidPublicId = (
  id: string,
  prefix: PublicIdPrefix
): boolean => {
  const pattern = new RegExp(`^${prefix}[A-Za-z0-9]{16}$`);
  return pattern.test(id);
};
