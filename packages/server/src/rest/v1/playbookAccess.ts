import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { resolveStartingPrincipal } from 'src/lib/orchestrationRunToken';
import type { PlaybookAuthor } from 'src/lib/playbookAuthor';
import { findCasePinnedFields, playbookCases } from 'src/lib/playbookCases';
import { playbooks } from 'src/lib/playbooks';

import { authorizeResource, makeItemRouteAuthorizer } from './resourceAccess';
import { resourcePins } from './resourcePins';

/** Every `/playbooks/:playbook_id` route authorizes against the playbook's SRN. */
export const playbookAccess = makeItemRouteAuthorizer({
  findScope: playbooks.findScope,
  resourceType: 'playbook',
  param: 'playbook_id',
  label: 'Playbook',
});

const caseAuthorizer = makeItemRouteAuthorizer({
  findScope: playbookCases.findScope,
  resourceType: 'playbook_case',
  param: 'case_id',
  label: 'Playbook case',
});

type CaseAuthorize = typeof caseAuthorizer.authorizeRead;

export const playbookCasePins = resourcePins({
  listOperation: 'listPlaybookCases',
});

/**
 * The case pins ride on authorization, so no case route can act without them:
 * a call naming `?actor_id` reaches that actor's cases only.
 */
const pinnedCase = (authorize: CaseAuthorize): CaseAuthorize => {
  return async (args) => {
    const access = await authorize(args);
    if (playbookCasePins.isPinned(args.ctx)) {
      const id = args.ctx.params.case_id;
      playbookCasePins.assertItem({
        ctx: args.ctx,
        item: await findCasePinnedFields({ id }),
        notFound: () => {
          return playbookCases.notFound(id);
        },
      });
    }
    return access;
  };
};

/**
 * Every `/playbook-cases/:case_id` route authorizes against the case's SRN and
 * honours its pins.
 */
export const playbookCaseAccess = {
  authorizeRead: pinnedCase(caseAuthorizer.authorizeRead),
  authorizeWrite: pinnedCase(caseAuthorizer.authorizeWrite),
};

/**
 * The caller as the author of a version it writes, by the same rule a run
 * records the principal that started it.
 */
export const playbookAuthorOf = (ctx: Context): PlaybookAuthor => {
  return {
    principal: resolveStartingPrincipal({ authUser: ctx.authUser }),
    isAllowed: ctx.authUser!.isAllowed,
  };
};

/**
 * Whether the caller may read a case, by the same check `GET` of it makes; a
 * case the caller cannot read is one it cannot bind.
 */
export const caseReadableBy = (ctx: Context) => {
  return async (casePublicId: string): Promise<boolean> => {
    return authorizeResource({
      ctx,
      scope: await playbookCases.findScope({ id: casePublicId }),
      resourceType: 'playbook_case',
      resourceId: casePublicId,
      action: 'playbooks:GetPlaybookCase',
      onDenied: 'hide',
      label: 'Playbook case',
    }).then(
      () => {
        return true;
      },
      (error: unknown) => {
        if (error instanceof DomainError) return false;
        throw error;
      }
    );
  };
};
