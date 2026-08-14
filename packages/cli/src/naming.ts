/**
 * Flag-name spellings. The CLI accepts kebab-case (the documented convention),
 * snake_case (the wire spelling, so a body field can be typed exactly as the
 * spec names it), and camelCase alike; matching happens on the canonical form.
 */

/**
 * Normalize kebab-case, snake_case, or camelCase to camelCase for param matching.
 * e.g. agent-id → agentId, actor_id → actorId, agentId → agentId
 */
export const toCanonical = (s: string) => {
  return s.replace(/[-_]([a-z0-9])/g, (_, c: string) => {
    return c.toUpperCase();
  });
};

/** Convert kebab-case to snake_case for body/query keys (e.g. project-id → project_id). */
export const kebabToSnake = (s: string) => {
  return s.replace(/-/g, '_');
};

/**
 * Convert snake_case or camelCase to kebab-case for flag *display* in --help
 * (e.g. project_id → project-id). Kebab-case is the documented canonical CLI
 * flag convention (see the generated docs pages and tutorials); the parser is
 * lenient and accepts snake/kebab/camel alike via `toCanonical`, so this only
 * affects how flags are printed (#610).
 */
export const toKebab = (s: string) => {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
};
