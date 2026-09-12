/**
 * Readers for the `where` clause `compilePolicy` produces.
 *
 * That clause is keyed by Sequelize operator **symbols** (`Op.and`, `Op.or`,
 * `Op.not`), which `Object.keys` does not report. A call site that guarded on
 * `Object.keys(policyWhere).length > 0` therefore saw every compiled policy as
 * empty and dropped it — an access filter that silently stopped filtering, with
 * no error and no narrowed result to notice. The column references the compiler
 * emits (`$file.path$`, `tags`, `publicId`) sit nested inside those symbol keys
 * for the same reason, so scanning the top level finds nothing either.
 *
 * Every consumer of a compiled clause reads it through this module rather than
 * enumerating string keys.
 */

const isPlainObject = (value: unknown): value is object => {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  // A `Sequelize.where(...)` fragment is a class instance carrying its own
  // column reference; it is passed through untouched rather than rebuilt as a
  // plain object, which would strip its prototype and its meaning.
  return proto === Object.prototype || proto === null;
};

/**
 * Whether the clause constrains anything. `{}` means "no restriction"; anything
 * else — however deeply symbol-keyed — must reach the query.
 */
export const hasPolicyConstraints = (
  where: Record<string, unknown> | undefined
): where is Record<string, unknown> => {
  return where !== undefined && Reflect.ownKeys(where).length > 0;
};

const isAssociationRef = (key: string | symbol): key is string => {
  return typeof key === 'string' && key.startsWith('$') && key.endsWith('$');
};

/**
 * Whether the clause references an associated model's column (`$alias.column$`).
 * Sequelize can only resolve those with `subQuery: false`.
 */
export const referencesAssociation = (where: unknown): boolean => {
  if (Array.isArray(where)) return where.some(referencesAssociation);
  if (!isPlainObject(where)) return false;
  return Reflect.ownKeys(where).some((key) => {
    if (isAssociationRef(key)) return true;
    return referencesAssociation(Reflect.get(where, key));
  });
};
