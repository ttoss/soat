export type Effect = 'Allow' | 'Deny';

export type ConditionOperator =
  | 'StringEquals'
  | 'StringNotEquals'
  | 'StringLike';

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

const VALID_EFFECTS: Effect[] = ['Allow', 'Deny'];
const VALID_OPERATORS: ConditionOperator[] = [
  'StringEquals',
  'StringNotEquals',
  'StringLike',
];

const isValidAction = (action: string): boolean => {
  if (action === '*') return true;
  if (/^[a-zA-Z0-9_-]+:\*$/.test(action)) return true;
  if (/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(action)) return true;
  return false;
};

const isValidSrnPattern = (srn: string): boolean => {
  if (srn === '*') return true;
  // soat:<projectPublicId>:<resourceType>:<resourceId|*>
  return /^soat:[^:]+:[^:]+:[^:]+$/.test(srn);
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
          `${prefix}.resource: "${res}" is invalid — must be * or soat:<project>:<type>:<id>`
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

  for (const key of Object.keys(args.block)) {
    if (!key.startsWith('soat:')) {
      args.errors.push(
        `${args.prefix}.condition.${args.op}: key "${key}" must start with "soat:"`
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

export const buildSrn = (args: {
  projectPublicId: string;
  resourceType: string;
  resourceId: string;
}): string => {
  return `soat:${args.projectPublicId}:${args.resourceType}:${args.resourceId}`;
};

export const matchesPattern = (args: {
  pattern: string;
  value: string;
}): boolean => {
  const { pattern, value } = args;

  if (pattern === '*') return true;
  if (pattern === value) return true;

  // module:* matches module:Anything (but only if there's a single wildcard)
  if (pattern.endsWith(':*') && !pattern.includes('*:*')) {
    const prefix = pattern.slice(0, -1); // e.g. "files:"
    return value.startsWith(prefix);
  }

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
  if (statement.condition) {
    if (!evaluateCondition({ condition: statement.condition, context }))
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

/**
 * Extracts distinct project publicIds from the Allow statements of a set of
 * policies by parsing SRN resource patterns.
 *
 * Returns `undefined` when any statement grants access to all projects
 * (wildcard `*` or `soat:*:...`), meaning the caller should treat the result
 * as "all projects".
 *
 * Returns a (possibly empty) string[] of project publicIds when all patterns
 * are scoped to specific projects.
 */
export const extractProjectIdsFromPolicies = (
  policies: PolicyDocument[]
): string[] | undefined => {
  const projectIds = new Set<string>();

  for (const policy of policies) {
    for (const statement of policy.statement) {
      if (statement.effect !== 'Allow') continue;
      const resources = statement.resource ?? ['*'];
      for (const resource of resources) {
        if (resource === '*') return undefined;
        if (!resource.startsWith('soat:')) continue;
        const parts = resource.split(':');
        if (parts.length < 4) continue;
        const projectId = parts[1];
        if (projectId === '*') return undefined;
        projectIds.add(projectId);
      }
    }
  }

  return Array.from(projectIds);
};
