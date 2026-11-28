import {
  findIamActionRegistration,
  findProjectGroupActionResourceTypes,
  isRegisteredIamModule,
} from './iamRegistrations';
import { listAllActions, listModuleNames } from './permissionCatalog';
import { collectUndeclaredDenialCodeErrors } from './policyDenial';
import { hasUnboundPolicyVariable } from './policyVariables';

export type Effect = 'Allow' | 'Deny';

export type ConditionOperator =
  'StringEquals' | 'StringNotEquals' | 'StringLike';

export type Condition = {
  [operator in ConditionOperator]?: Record<string, string>;
};

/**
 * What a `Deny` statement answers when it decides a request: a deployment's
 * declared `code`, its `message`, and `meta` beside the denial's own.
 */
export type PolicyDenial = {
  code: string;
  message: string;
  meta?: Record<string, unknown>;
};

export type Statement = {
  effect: Effect;
  action: string[];
  resource?: string[];
  condition?: Condition;
  denial?: PolicyDenial;
};

/** A check's answer: the `denial` of the `Deny` statement that decided it. */
export type PolicyDecision = { allowed: boolean; denial: PolicyDenial | null };

export type PolicyDocument = {
  statement: Statement[];
};

/**
 * A caller's effective policies as sets that must each allow: a credential's
 * boundary (its key policies, an OAuth consent) is a set beside its owner's.
 */
export type PolicySets = PolicyDocument[][];

/**
 * True when `action` names a real, enforceable permission: the `*` super
 * wildcard, a `module:*` wildcard for a module that exists, or an exact
 * `module:Operation` present in the permission catalog (`src/permissions/*`),
 * or a project group action, built-in or one the deployment registered
 * (`iamRegistrations.ts`).
 *
 * Degrades safely: if the catalog could not be loaded (empty — e.g. a bundle
 * where the permission files are not shipped), every action is treated as known
 * so we never reject a legitimate policy. This only relaxes the authoring-time
 * typo check; runtime enforcement is unaffected.
 */
const isKnownAction = (action: string): boolean => {
  if (action === '*' || findProjectGroupActionResourceTypes(action)) {
    return true;
  }
  const knownActions = listAllActions();
  if (knownActions.size === 0) return true;
  const wildcard = /^([a-zA-Z0-9_-]+):\*$/.exec(action);
  if (wildcard) {
    return (
      listModuleNames().has(wildcard[1]) || isRegisteredIamModule(wildcard[1])
    );
  }
  return (
    knownActions.has(action) || findIamActionRegistration(action) !== undefined
  );
};

/**
 * Semantic validation layered on top of `validatePolicyDocument`'s structural
 * checks: every `action` must name a real, enforceable permission. This is what
 * stops a mis-named `Deny` (a typo or a guessed action) from being silently
 * accepted and then never matching anything at evaluation time (fail-open at
 * authoring). Applied only at authoring boundaries (policy create/update,
 * formation validation) — never in the runtime evaluation path, so an
 * already-stored policy keeps evaluating unchanged.
 */
const collectUnknownActionErrors = (args: {
  stmt: unknown;
  index: number;
  errors: string[];
}): void => {
  const { stmt, index, errors } = args;
  if (!stmt || typeof stmt !== 'object' || Array.isArray(stmt)) return;
  const actions = (stmt as Record<string, unknown>).action;
  if (!Array.isArray(actions)) return;
  for (const act of actions) {
    if (typeof act === 'string' && !isKnownAction(act)) {
      errors.push(
        `statement[${index}].action: "${act}" is not a known action — ` +
          'see the Permissions Reference (/docs/permissions)'
      );
    }
  }
};

export const validatePolicyActions = (
  doc: unknown
): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { valid: true, errors };
  }
  const d = doc as Record<string, unknown>;
  if (!Array.isArray(d.statement)) return { valid: true, errors };

  for (const [index, stmt] of d.statement.entries()) {
    collectUnknownActionErrors({ stmt, index, errors });
  }
  collectUndeclaredDenialCodeErrors({ doc, errors });

  return { valid: errors.length === 0, errors };
};

export const buildSrn = (args: {
  projectPublicId: string;
  resourceType: string;
  resourceId: string;
}): string => {
  return `srn:${args.projectPublicId}:${args.resourceType}:${args.resourceId}`;
};

export const matchesPattern = (args: {
  pattern: string;
  value: string;
}): boolean => {
  const { pattern, value } = args;

  if (pattern === '*') return true;
  if (pattern === value) return true;

  // Glob: * = any chars, ? = single char
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(value);
};

const evaluateConditionForKey = (
  op: ConditionOperator,
  actual: string | undefined,
  expected: string
): boolean => {
  if (op === 'StringEquals') {
    return actual === expected;
  }
  if (op === 'StringNotEquals') {
    return actual !== expected;
  }
  if (op === 'StringLike') {
    return matchesPattern({ pattern: expected, value: actual ?? '' });
  }
  return true;
};

export const evaluateCondition = (args: {
  condition: Condition;
  context: Record<string, string>;
}): boolean => {
  const { condition, context } = args;

  for (const op of Object.keys(condition) as ConditionOperator[]) {
    const block = condition[op];
    if (!block) continue;

    for (const [key, expected] of Object.entries(block)) {
      // A variable nothing bound has no value to compare, so the condition
      // fails under every operator, `StringNotEquals` included.
      if (hasUnboundPolicyVariable(expected)) return false;
      const actual = context[key];
      if (!evaluateConditionForKey(op, actual, expected)) {
        return false;
      }
    }
  }

  return true;
};

export const statementMatches = (args: {
  statement: Statement;
  action: string;
  resource: string;
  context: Record<string, string>;
}): boolean => {
  const { statement, action, resource, context } = args;

  // Check action
  const actionMatch = statement.action.some((pattern) => {
    return matchesPattern({ pattern, value: action });
  });
  if (!actionMatch) return false;

  // Check resource (omitted resource defaults to ["*"])
  const resources = statement.resource ?? ['*'];
  const resourceMatch = resources.some((pattern) => {
    return matchesPattern({ pattern, value: resource });
  });
  if (!resourceMatch) return false;

  // Check condition
  if (
    statement.condition &&
    !evaluateCondition({ condition: statement.condition, context })
  ) {
    return false;
  }

  return true;
};

/** The first matching `Deny` statement, else whether an `Allow` matched. */
const decideForResource = (args: {
  policies: PolicyDocument[];
  action: string;
  resource: string;
  context: Record<string, string>;
}): { deny: Statement } | { allowed: boolean } => {
  let allowed = false;
  for (const policy of args.policies) {
    for (const statement of policy.statement) {
      if (!statementMatches({ statement, ...args })) continue;
      if (statement.effect === 'Deny') return { deny: statement };
      allowed = true;
    }
  }
  return { allowed };
};

/** Every candidate resource must escape every `Deny`; one must match an `Allow`. */
const decide = (args: {
  policies: PolicyDocument[];
  action: string;
  resources: string[];
  context?: Record<string, string>;
}): PolicyDecision => {
  const context = args.context ?? {};
  let allowed = false;
  for (const resource of args.resources) {
    const result = decideForResource({ ...args, resource, context });
    if ('deny' in result) {
      return { allowed: false, denial: result.deny.denial ?? null };
    }
    allowed = allowed || result.allowed;
  }
  return { allowed, denial: null };
};

export const evaluatePolicies = (args: {
  policies: PolicyDocument[];
  action: string;
  resource?: string;
  context?: Record<string, string>;
}): PolicyDecision => {
  return decide({ ...args, resources: [args.resource ?? '*'] });
};

/**
 * Evaluates policies against multiple candidate resource SRNs (e.g. an ID-based
 * SRN and a path-based SRN). Access is granted when at least one resource
 * matches an Allow and no resource matches a Deny.
 */
export const evaluatePoliciesMultiResource = (args: {
  policies: PolicyDocument[];
  action: string;
  resources: string[];
  context?: Record<string, string>;
}): PolicyDecision => {
  return decide(args);
};

export { validatePolicyDocument } from './policyDocumentValidation';
export {
  extractProjectIdsFromPolicies,
  findAllowResourcesOutsideEveryProject,
  policySetsConcernProject,
  policySetsConcernProjectGroup,
  scopePolicyDocument,
} from './policyProjectIds';
