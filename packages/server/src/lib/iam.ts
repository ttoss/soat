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
    const stmt = d.statement[i] as Record<string, unknown>;
    const prefix = `statement[${i}]`;

    if (!stmt || typeof stmt !== 'object' || Array.isArray(stmt)) {
      errors.push(`${prefix}: must be an object`);
      continue;
    }

    // Validate effect
    if (!VALID_EFFECTS.includes(stmt.effect as Effect)) {
      errors.push(
        `${prefix}.effect: must be one of ${VALID_EFFECTS.join(', ')}`
      );
    }

    // Validate action
    if (!Array.isArray(stmt.action) || stmt.action.length === 0) {
      errors.push(`${prefix}.action: must be a non-empty array`);
    } else {
      for (const act of stmt.action) {
        if (typeof act !== 'string' || !isValidAction(act)) {
          errors.push(
            `${prefix}.action: "${act}" is invalid — must be *, module:*, or module:Operation`
          );
        }
      }
    }

    // Validate resource (optional)
    if (stmt.resource !== undefined) {
      if (!Array.isArray(stmt.resource) || stmt.resource.length === 0) {
        errors.push(
          `${prefix}.resource: must be a non-empty array when present`
        );
      } else {
        for (const res of stmt.resource) {
          if (typeof res !== 'string' || !isValidSrnPattern(res)) {
            errors.push(
              `${prefix}.resource: "${res}" is invalid — must be * or soat:<project>:<type>:<id>`
            );
          }
        }
      }
    }

    // Validate condition (optional)
    if (stmt.condition !== undefined) {
      if (
        !stmt.condition ||
        typeof stmt.condition !== 'object' ||
        Array.isArray(stmt.condition)
      ) {
        errors.push(`${prefix}.condition: must be an object`);
      } else {
        const cond = stmt.condition as Record<string, unknown>;
        for (const op of Object.keys(cond)) {
          if (!VALID_OPERATORS.includes(op as ConditionOperator)) {
            errors.push(
              `${prefix}.condition: "${op}" is not a valid operator — must be one of ${VALID_OPERATORS.join(', ')}`
            );
          } else {
            const block = cond[op] as Record<string, unknown>;
            if (!block || typeof block !== 'object' || Array.isArray(block)) {
              errors.push(`${prefix}.condition.${op}: must be an object`);
            } else {
              for (const key of Object.keys(block)) {
                if (!key.startsWith('soat:')) {
                  errors.push(
                    `${prefix}.condition.${op}: key "${key}" must start with "soat:"`
                  );
                }
              }
            }
          }
        }
      }
    }
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

  // module:* matches module:Anything
  if (pattern.endsWith(':*')) {
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

      if (op === 'StringEquals') {
        if (actual !== expected) return false;
      } else if (op === 'StringNotEquals') {
        if (actual === expected) return false;
      } else if (op === 'StringLike') {
        if (!matchesPattern({ pattern: expected, value: actual ?? '' }))
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

const matchesWildcardRequest = (statement: Statement): boolean => {
  const policyResources = statement.resource ?? ['*'];
  // Allow grants access to at least some resources (per-item filtering handles the rest).
  // Deny only blocks when it applies globally (resource: '*').
  if (statement.effect === 'Allow') return true;
  return policyResources.some((r) => {
    return r === '*';
  });
};

const matchesExactResource = (
  statement: Statement,
  resource: string
): boolean => {
  const policyResources = statement.resource ?? ['*'];
  return policyResources.some((pattern) => {
    return matchesPattern({ pattern, value: resource });
  });
};

const checkStatement = (args: {
  statement: Statement;
  action: string;
  resource: string;
  context: Record<string, string>;
  isWildcardRequest: boolean;
}): 'allow' | 'deny' | 'skip' => {
  const { statement, action, resource, context, isWildcardRequest } = args;

  const actionMatch = statement.action.some((pattern) => {
    return matchesPattern({ pattern, value: action });
  });
  if (!actionMatch) return 'skip';

  const resourceMatch = isWildcardRequest
    ? matchesWildcardRequest(statement)
    : matchesExactResource(statement, resource);
  if (!resourceMatch) return 'skip';

  if (statement.condition) {
    if (!evaluateCondition({ condition: statement.condition, context }))
      return 'skip';
  }

  return statement.effect === 'Deny' ? 'deny' : 'allow';
};

export const evaluatePolicies = (args: {
  policies: PolicyDocument[];
  action: string;
  resource?: string;
  context?: Record<string, string>;
}): boolean => {
  const resource = args.resource ?? '*';
  const context = args.context ?? {};
  const isWildcardRequest = resource === '*';

  let allowed = false;

  for (const policy of args.policies) {
    for (const statement of policy.statement) {
      const result = checkStatement({
        statement,
        action: args.action,
        resource,
        context,
        isWildcardRequest,
      });
      if (result === 'deny') return false;
      if (result === 'allow') allowed = true;
    }
  }

  return allowed;
};
