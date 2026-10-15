import { playbookCases } from 'src/lib/playbookCases';
import { playbooks } from 'src/lib/playbooks';

import { makeItemRouteAuthorizer } from './resourceAccess';

/** Every `/playbooks/:playbook_id` route authorizes against the playbook's SRN. */
export const playbookAccess = makeItemRouteAuthorizer({
  findScope: playbooks.findScope,
  resourceType: 'playbook',
  param: 'playbook_id',
  label: 'Playbook',
});

/** Every `/playbook-cases/:case_id` route authorizes against the case's SRN. */
export const playbookCaseAccess = makeItemRouteAuthorizer({
  findScope: playbookCases.findScope,
  resourceType: 'playbook_case',
  param: 'case_id',
  label: 'Playbook case',
});
