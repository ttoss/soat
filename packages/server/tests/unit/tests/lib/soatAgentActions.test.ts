import { resolveSoatTools } from 'src/lib/agentToolResolverExternalTools';
import {
  AGENT_EXCLUDED_ACTIONS,
  isAgentExcludedAction,
  withoutAgentExcludedActions,
} from 'src/lib/soatAgentActions';
import { soatTools } from 'src/lib/soatTools';

/**
 * The exclusions are declared in the OpenAPI specs, so these assert against the
 * real catalog rather than a fixture: a spec that loses its annotation, or an
 * operationId that is renamed out from under one, fails here.
 */
describe('actions withheld from the agent tool surface', () => {
  // Named one by one rather than by a pattern: each is on the list for a reason
  // that a rule over names would not capture, and a rule would quietly admit
  // whatever a later spec happens to call something.
  test.each([
    // Settling an approval is what the gate exists to put a person in front of.
    ['approve-approval'],
    ['reject-approval'],
    // Minting or reading a credential.
    ['create-api-key'],
    ['update-api-key'],
    ['delete-api-key'],
    ['get-api-key'],
    ['login-user'],
    ['bootstrap-user'],
    ['get-trigger-secret'],
    ['rotate-trigger-secret'],
    ['get-webhook-secret'],
    ['rotate-webhook-secret'],
    ['create-secret'],
    ['update-secret'],
    ['delete-secret'],
    // Changing who may do what.
    ['attach-user-policies'],
    ['create-policy'],
    ['update-policy'],
    ['delete-policy'],
    ['create-user'],
    ['delete-user'],
    ['list-users'],
    ['get-user'],
    // Rewriting the meter its own spend is priced against.
    ['update-ai-provider-prices'],
    ['update-project-prices'],
  ])('%s is excluded', (action) => {
    expect(isAgentExcludedAction(action)).toBe(true);
  });

  // The exclusion is per surface, not a removal: an MCP client is a person
  // acting as themselves, and these are ordinary operations for them.
  test('every excluded action is still in the catalog', () => {
    for (const action of AGENT_EXCLUDED_ACTIONS) {
      expect(
        soatTools.some((tool) => {
          return tool.name === action;
        })
      ).toBe(true);
    }
  });

  test.each([
    ['search-knowledge'],
    ['create-agent-generation'],
    ['get-secret'],
    ['list-approvals'],
    ['get-ai-provider-prices'],
  ])('%s stays available', (action) => {
    expect(isAgentExcludedAction(action)).toBe(false);
  });

  // `get-secret` answers `has_value` rather than the value, so reading a
  // secret's metadata is not reading its material — which is why the three
  // writes are excluded and the read is not.
  test('get-secret returns no secret material', () => {
    const def = soatTools.find((tool) => {
      return tool.name === 'get-secret';
    });
    expect(def?.acceptedBodyFields ?? []).not.toContain('value');
  });

  describe('withoutAgentExcludedActions', () => {
    test('drops excluded actions and keeps the rest', () => {
      expect(
        withoutAgentExcludedActions({
          actions: ['search-knowledge', 'approve-approval', 'list-agents'],
          toolName: 'mixed',
        })
      ).toEqual(['search-knowledge', 'list-agents']);
    });

    test('leaves an unexcluded binding untouched', () => {
      const actions = ['search-knowledge', 'list-agents'];
      expect(withoutAgentExcludedActions({ actions, toolName: 't' })).toEqual(
        actions
      );
    });
  });

  // The write refuses these now, so a row naming one predates the rule — the
  // surface must still not carry it.
  test('a stored binding naming an excluded action resolves without it', () => {
    const resolved = resolveSoatTools({
      typedTool: {
        name: 'legacy',
        description: null,
        actions: ['approve-approval', 'list-approvals'],
      },
      buildContextHeaders: () => {
        return {};
      },
      isSoatActionAllowedByBoundary: () => {
        return true;
      },
      logToolCallingError: () => {},
    });

    expect(Object.keys(resolved)).toEqual(['legacy_list-approvals']);
  });
});
