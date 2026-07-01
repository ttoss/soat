// Segments between '*' never contain '*' (we already split on it), so each
// segment is escaped in full and the wildcarded gaps become '.*'.
const escapeRegExp = (value: string): string => {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
};

const globToRegExp = (glob: string): RegExp => {
  const pattern = glob.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${pattern}$`);
};

export const matchesContentTypeGlob = (args: {
  glob: string;
  contentType: string;
}): boolean => {
  return globToRegExp(args.glob).test(args.contentType);
};

/**
 * Most-specific-wins comparator: fewer wildcards beats more wildcards;
 * among equal wildcard counts, a longer literal pattern beats a shorter one;
 * ties are broken alphabetically for determinism (the project_id +
 * content_type_glob uniqueness constraint makes true ties on identical
 * globs impossible).
 */
export const compareGlobSpecificity = (a: string, b: string): number => {
  const wildcardsA = (a.match(/\*/g) ?? []).length;
  const wildcardsB = (b.match(/\*/g) ?? []).length;
  if (wildcardsA !== wildcardsB) return wildcardsA - wildcardsB;
  if (a.length !== b.length) return b.length - a.length;
  return a.localeCompare(b);
};
