import type { AuthUser, Context } from '../Context';
import { resolveGenerationIdentitySets } from '../lib/onBehalfOfIdentity';
import { narrowAuthority } from './authority';

/**
 * A request carrying the assertion of a generation's tool call runs as the key
 * capped by that generation's execution identity, so a tool server calling
 * back acts no further than a `builtin` call of the same turn. Never widens.
 */
export const narrowToOnBehalfOf = (args: {
  authUser: AuthUser;
  db: Context['db'];
}): AuthUser => {
  const { authUser } = args;
  const generationPublicId = authUser.onBehalfOf?.generation_id;
  const projectPublicId = authUser.apiKeyProjectPublicId;
  if (!generationPublicId || !projectPublicId) return authUser;

  return {
    ...authUser,
    ...narrowAuthority({
      authority: authUser,
      projectPublicId,
      bound: () => {
        return resolveGenerationIdentitySets({
          generationPublicId,
          projectPublicId,
        });
      },
      db: args.db,
    }),
  };
};
