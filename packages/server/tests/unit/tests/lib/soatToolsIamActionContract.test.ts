import { validatePolicyActions } from 'src/lib/iam';
import { soatTools } from 'src/lib/soatTools';

/**
 * Every `soat` tool action must resolve to an IAM action a policy author is
 * allowed to write.
 *
 * `boundary_policy` is evaluated at runtime against `def.iamAction ?? def.name`
 * (`buildSoatActionTool` in `agentToolResolverExternalTools`), while
 * `validatePolicyActions` rejects any action that is not a real
 * `module:Operation` from the permission catalog. When those two disagree the
 * boundary silently cannot express the action, and the failure has a direction:
 *
 * - an `Allow` boundary over-denies — annoying, but safe;
 * - a `Deny` boundary matches nothing at all — **fail-open**, which is exactly
 *   what `collectUnknownActionErrors` claims authoring-time validation prevents.
 *
 * Before the catalog fallback landed, only 9 of 267 operations declared
 * `x-iam-action`, so 258 evaluated against a kebab-case tool name
 * (`update-document`) that no author could put in a policy. This test is the
 * ratchet: a new operation that reaches the tool surface without a resolvable
 * IAM action fails here rather than silently widening a boundary.
 */

/**
 * Operations that intentionally have no IAM action, with the reason each is
 * unauthorized-by-design. They are reachable without a policy at all, so there
 * is nothing for a boundary to express.
 */
const PERMISSIONLESS_OPERATIONS = new Map([
  ['login-user', 'unauthenticated — exchanges credentials for a token'],
  ['bootstrap-user', 'unauthenticated — creates the first admin'],
  ['get-current-user', 'self-scoped — reads the caller behind the token'],
  [
    'upload-file-with-token',
    'the upload token is the credential, not a policy',
  ],
  [
    'complete-ingestion-callback',
    'internal ingestion callback, not user-facing',
  ],
]);

describe('soat tool IAM action contract (real OpenAPI specs)', () => {
  test('derives a tool surface from the specs on disk', () => {
    expect(soatTools.length).toBeGreaterThan(0);
  });

  test('every tool action resolves to an authorable IAM action', () => {
    const unresolvable = soatTools
      .filter((tool) => {
        return !PERMISSIONLESS_OPERATIONS.has(tool.name);
      })
      .filter((tool) => {
        const iamAction = tool.iamAction ?? tool.name;
        // The same gate policy authoring uses. If a boundary cannot legally
        // contain this string, the runtime must not be evaluating against it.
        return !validatePolicyActions({
          statement: [{ effect: 'Allow', action: [iamAction] }],
        }).valid;
      })
      .map((tool) => {
        return `${tool.name} → ${tool.iamAction ?? tool.name}`;
      });

    expect(unresolvable).toEqual([]);
  });

  test('a documented example action resolves to its module:Operation form', () => {
    // The tutorial and the agents module docs both promise that a boundary
    // written as `documents:UpdateDocument` governs the `update-document`
    // action. That is only true if the tool carries the IAM name.
    const updateDocument = soatTools.find((tool) => {
      return tool.name === 'update-document';
    });

    expect(updateDocument?.iamAction).toBe('documents:UpdateDocument');
  });

  test('an explicit x-iam-action still wins over the catalog', () => {
    // `getDocumentStatus` is a distinct operation that deliberately reuses the
    // read action, declared in the spec rather than inferred.
    const status = soatTools.find((tool) => {
      return tool.name === 'get-document-status';
    });

    expect(status?.iamAction).toBe('documents:GetDocument');
  });

  test('every permissionless operation is still on the tool surface', () => {
    // Guards the allowlist against rot: an entry that no longer names a real
    // operation would silently excuse nothing, hiding a future regression.
    const toolNames = new Set(
      soatTools.map((tool) => {
        return tool.name;
      })
    );
    const stale = [...PERMISSIONLESS_OPERATIONS.keys()].filter((name) => {
      return !toolNames.has(name);
    });

    expect(stale).toEqual([]);
  });
});
