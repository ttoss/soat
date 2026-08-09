import type { db } from '../db';

/**
 * The `include` shape a Sequelize finder accepts, named without referencing
 * `sequelize` directly (it is a transitive dependency, and its types are not
 * portably nameable from an emitted declaration).
 *
 * An exported `xIncludes()` thunk needs an explicit return type; this is it.
 */
export type ResourceIncludes = NonNullable<
  NonNullable<Parameters<(typeof db)['Project']['findOne']>[0]>['include']
>;
