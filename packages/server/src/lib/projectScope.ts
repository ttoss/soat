/**
 * The project ids a read spans, as `resolveReadProjectIds` answers them:
 * `undefined` is no project filter (an unrestricted admin's unscoped read),
 * `[]` is no project at all.
 */
export type ProjectScope = number[] | undefined;

/** The `where` a {@link ProjectScope} compiles to. */
export const projectScopeWhere = (args: {
  projectIds: ProjectScope;
}): { projectId?: number[] } => {
  return args.projectIds === undefined ? {} : { projectId: args.projectIds };
};
