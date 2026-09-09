/**
 * Wildcard match with a single backtrack pointer, deliberately not a regex: a
 * glob is caller-supplied, and `*`-separated literals compiled into `.*a.*a…`
 * backtrack catastrophically on a near-miss — a 24-character glob against a
 * 60-character content type does not return.
 */
const matchesGlob = (args: { glob: string; value: string }): boolean => {
  const { glob, value } = args;
  let globIndex = 0;
  let valueIndex = 0;
  let lastStar = -1;
  let resumeAt = 0;

  while (valueIndex < value.length) {
    const pattern = glob[globIndex];
    if (pattern === '*') {
      lastStar = globIndex;
      globIndex += 1;
      resumeAt = valueIndex;
    } else if (pattern === value[valueIndex]) {
      globIndex += 1;
      valueIndex += 1;
    } else if (lastStar === -1) {
      return false;
    } else {
      // Give the last `*` one more character and retry from there. Each retry
      // advances `resumeAt`, so the whole match stays linear in `value`.
      globIndex = lastStar + 1;
      resumeAt += 1;
      valueIndex = resumeAt;
    }
  }

  while (glob[globIndex] === '*') globIndex += 1;
  return globIndex === glob.length;
};

export const matchesContentTypeGlob = (args: {
  glob: string;
  contentType: string;
}): boolean => {
  return matchesGlob({ glob: args.glob, value: args.contentType });
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
