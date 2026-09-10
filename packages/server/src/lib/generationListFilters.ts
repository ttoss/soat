/**
 * Resolving the public-id filters `list-generations` accepts into the internal
 * ids a `where` clause needs.
 *
 * Its own module because it only serves the list query: `generations.ts` writes
 * and updates generation records, and holding both jobs is what pushed that file
 * past its size ceiling. The resolution itself is shared
 * (`scopedIdFilters.ts`); what lives here is which column each filter fills.
 */
import type { ScopedIdResource } from './scopedIdFilters';
import { applyScopedIdFilters } from './scopedIdFilters';

type GenerationScopeFilters = {
  agentId?: string;
  traceId?: string;
  initiatorGenerationId?: string;
  sessionId?: string;
  actorId?: string;
};

// `actorId` fills `startedByActorId`: the generation names who started it,
// while the usage event copies the same actor under its own column.
const SCOPED_FILTERS: ReadonlyArray<{
  key: keyof GenerationScopeFilters;
  column: string;
  resource: ScopedIdResource;
}> = [
  { key: 'agentId', column: 'agentId', resource: 'agent' },
  { key: 'traceId', column: 'traceId', resource: 'trace' },
  {
    key: 'initiatorGenerationId',
    column: 'initiatorGenerationId',
    resource: 'generation',
  },
  { key: 'sessionId', column: 'sessionId', resource: 'session' },
  { key: 'actorId', column: 'startedByActorId', resource: 'actor' },
];

// Resolves the publicId filters into `where` (mutating it). Returns false when
// a referenced resource does not exist in scope.
export const applyGenerationScopeFilters = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: Record<string, any>,
  args: GenerationScopeFilters & { projectIds?: number[] }
): Promise<boolean> => {
  return applyScopedIdFilters({
    where,
    filters: SCOPED_FILTERS.map((filter) => {
      return {
        key: filter.column,
        resource: filter.resource,
        publicId: args[filter.key],
      };
    }),
    ...(args.projectIds !== undefined ? { projectIds: args.projectIds } : {}),
  });
};
