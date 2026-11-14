import {
  ACTOR_ID_VARIABLE,
  REQUEST_TAG_KEY_PREFIX,
  RESOURCE_TAG_KEY_PREFIX,
  RESOURCE_TYPE_KEY,
} from './iamConditionKeys';
import {
  findIamActionRegistration,
  isRegisteredIamModule,
} from './iamRegistrations';
import { listAllActions, listModuleNames } from './permissionCatalog';
import {
  hasUnboundPolicyVariable,
  unknownPolicyVariables,
} from './policyVariables';

export type Effect = 'Allow' | 'Deny';

export type ConditionOperator =
  'StringEquals' | 'StringNotEquals' | 'StringLike';

export type Condition = {
  [operator in ConditionOperator]?: Record<string, string>;
};

export type Statement = {
  effect: Effect;
  action: string[];
  resource?: string[];
  condition?: Condition;
};

export type PolicyDocument = {
  statement: Statement[];
};

/**
 * A caller's effective policies as sets that must each allow: a credential's
 * boundary (its key policies, an OAuth consent) is a set beside its owner's.
 */
export type PolicySets = PolicyDocument[][];

const VALID_EFFECTS: Effect[] = ['Allow', 'Deny'];
const VALID_OPERATORS: ConditionOperator[] = [
  'StringEquals',
  'StringNotEquals',
  'StringLike',
];

/**
 * The context keys the platform supplies to `evaluateCondition`, and the only
 * keys a condition may name.
 *
 * `iam:ResourceTag/<tag>` and `iam:RequestTag/<tag>` carry an arbitrary tag
 * name after the slash — tag keys are opaque
 * (`.claude/rules/case-convention.md`), so only the prefix is checked and the
 * name must be non-empty.
 */
const CONDITION_KEYS = new Set([RESOURCE_TYPE_KEY]);

const TAG_KEY_PREFIXES = [RESOURCE_TAG_KEY_PREFIX, REQUEST_TAG_KEY_PREFIX];

const isValidConditionKey = (key: string): boolean => {
  if (CONDITION_KEYS.has(key)) return true;
  return TAG_KEY_PREFIXES.some((prefix) => {
    return key.startsWith(prefix) && key.length > prefix.length;
  });
};

const isValidAction = (action: string): boolean => {
  if (action === '*') return true;
  if (/^[a-zA-Z0-9_-]+:\*$/.test(action)) return true;
  if (/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(action)) return true;
  return false;
};

const isValidSrnPattern = (srn: string): boolean => {
  if (srn === '*') return true;
  // srn:<projectPublicId>:<resourceType>:<resourceId|*>
  return /^srn:[^:]+:[^:]+:[^:]+$/.test(srn);
};

const validateEffectField = (
  effect: unknown,
  prefix: string,
  errors: string[]
): void => {
  if (!VALID_EFFECTS.includes(effect as Effect)) {
    errors.push(`${prefix}.effect: must be one of ${VALID_EFFECTS.join(', ')}`);
  }
};

const validateActionField = (
  action: unknown,
  prefix: string,
  errors: string[]
): void => {
  if (!Array.isArray(action) || action.length === 0) {
    errors.push(`${prefix}.action: must be a non-empty array`);
  } else {
    for (const act of action) {
      if (typeof act !== 'string' || !isValidAction(act)) {
        errors.push(
          `${prefix}.action: "${act}" is invalid — must be *, module:*, or module:Operation`
        );
      }
    }
  }
};

const validateResourceField = (
  resource: unknown,
  prefix: string,
  errors: string[]
): void => {
  if (resource === undefined) {
    return;
  }

  if (!Array.isArray(resource) || resource.length === 0) {
    errors.push(`${prefix}.resource: must be a non-empty array when present`);
  } else {
    for (const res of resource) {
      if (typeof res !== 'string' || !isValidSrnPattern(res)) {
        errors.push(
          `${prefix}.resource: "${res}" is invalid — must be * or srn:<project>:<type>:<id>`
        );
      }
    }
  }
};

const validateConditionBlock = (args: {
  block: Record<string, unknown>;
  op: string;
  prefix: string;
  errors: string[];
}): void => {
  if (
    !args.block ||
    typeof args.block !== 'object' ||
    Array.isArray(args.block)
  ) {
    args.errors.push(`${args.prefix}.condition.${args.op}: must be an object`);
    return;
  }

  // A key the platform never supplies is absent from the evaluation context,
  // so the statement carrying it can never match: an `Allow` silently stops
  // granting and a `Deny` silently stops denying. The second is a fail-open
  // from a typo, so the key set is checked here rather than the `iam:` prefix
  // alone — the rule `isValidAction` already applies to action strings.
  for (const key of Object.keys(args.block)) {
    if (!isValidConditionKey(key)) {
      args.errors.push(
        `${args.prefix}.condition.${args.op}: key "${key}" is not a condition key — must be ${[
          ...CONDITION_KEYS,
          ...TAG_KEY_PREFIXES.map((prefix) => {
            return `${prefix}<tag>`;
          }),
        ].join(', ')}`
      );
    }
    const value = args.block[key];
    if (typeof value !== 'string') continue;
    for (const variable of unknownPolicyVariables(value)) {
      args.errors.push(
        `${args.prefix}.condition.${args.op}: "${variable}" is not a policy variable — must be \${${ACTOR_ID_VARIABLE}}`
      );
    }
  }
};

const validateConditionField = (
  condition: unknown,
  prefix: string,
  errors: string[]
): void => {
  if (condition === undefined) {
    return;
  }

  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    errors.push(`${prefix}.condition: must be an object`);
    return;
  }

  const cond = condition as Record<string, unknown>;
  for (const op of Object.keys(cond)) {
    if (!VALID_OPERATORS.includes(op as ConditionOperator)) {
      errors.push(
        `${prefix}.condition: "${op}" is not a valid operator — must be one of ${VALID_OPERATORS.join(', ')}`
      );
    } else {
      const block = cond[op] as Record<string, unknown>;
      validateConditionBlock({ block, op, prefix, errors });
    }
  }
};

const validateStatement = (
  stmt: unknown,
  index: number,
  errors: string[]
): void => {
  const prefix = `statement[${index}]`;

  if (!stmt || typeof stmt !== 'object' || Array.isArray(stmt)) {
    errors.push(`${prefix}: must be an object`);
    return;
  }

  const stmtObj = stmt as Record<string, unknown>;

  validateEffectField(stmtObj.effect, prefix, errors);
  validateActionField(stmtObj.action, prefix, errors);
  validateResourceField(stmtObj.resource, prefix, errors);
  validateConditionField(stmtObj.condition, prefix, errors);
};

export const validatePolicyDocument = (
  doc: unknown
): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    errors.push('Policy document must be an object');
    return { valid: false, errors };
  }

  const d = doc as Record<string, unknown>;

  if (!Array.isArray(d.statement)) {
    errors.push('Policy document must have a "statement" array');
    return { valid: false, errors };
  }

  for (let i = 0; i < d.statement.length; i++) {
    validateStatement(d.statement[i], i, errors);
  }

  return { valid: errors.length === 0, errors };
};

/**
 * True when `action` names a real, enforceable permission: the `*` super
 * wildcard, a `module:*` wildcard for a module that exists, or an exact
 * `module:Operation` present in the permission catalog (`src/permissions/*`)
 * or registered by the deployment (`iamRegistrations.ts`).
 *
 * Degrades safely: if the catalog could not be loaded (empty — e.g. a bundle
 * where the permission files are not shipped), every action is treated as known
 * so we never reject a legitimate policy. This only relaxes the authoring-time
 * typo check; runtime enforcement is unaffected.
 */
const isKnownAction = (action: string): boolean => {
  if (action === '*') return true;
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

export const evaluatePolicies = (args: {
  policies: PolicyDocument[];
  action: string;
  resource?: string;
  context?: Record<string, string>;
}): boolean => {
  const resource = args.resource ?? '*';
  const context = args.context ?? {};

  let allowed = false;

  for (const policy of args.policies) {
    for (const statement of policy.statement) {
      if (
        statementMatches({ statement, action: args.action, resource, context })
      ) {
        if (statement.effect === 'Deny') {
          return false; // Explicit deny, short-circuit
        }
        allowed = true;
      }
    }
  }

  return allowed;
};

const checkPoliciesForResource = (args: {
  resource: string;
  policies: PolicyDocument[];
  action: string;
  context: Record<string, string>;
}): { denied: boolean; allowed: boolean } => {
  let allowed = false;

  for (const policy of args.policies) {
    for (const statement of policy.statement) {
      if (
        statementMatches({
          statement,
          action: args.action,
          resource: args.resource,
          context: args.context,
        })
      ) {
        if (statement.effect === 'Deny') {
          return { denied: true, allowed: false };
        }
        allowed = true;
      }
    }
  }

  return { denied: false, allowed };
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
}): boolean => {
  const context = args.context ?? {};
  let allowed = false;

  for (const resource of args.resources) {
    const result = checkPoliciesForResource({
      resource,
      policies: args.policies,
      action: args.action,
      context,
    });
    if (result.denied) {
      return false;
    }
    if (result.allowed) {
      allowed = true;
    }
  }

  return allowed;
};

export {
  extractProjectIdsFromPolicies,
  policySetsConcernProject,
} from './policyProjectIds';
