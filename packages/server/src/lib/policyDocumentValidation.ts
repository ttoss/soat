import type { ConditionOperator, Effect } from './iam';
import {
  ACTOR_ID_VARIABLE,
  REQUEST_TAG_KEY_PREFIX,
  RESOURCE_TAG_KEY_PREFIX,
  RESOURCE_TYPE_KEY,
} from './iamConditionKeys';
import { validateDenialField } from './policyDenial';
import { unknownPolicyVariables } from './policyVariables';

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

const validateResourceField = (args: {
  resource: unknown;
  effect: unknown;
  allowResourceForm: string | undefined;
  prefix: string;
  errors: string[];
}): void => {
  const { resource, prefix, errors } = args;
  const form =
    args.effect === 'Allow' && args.allowResourceForm !== undefined
      ? args.allowResourceForm
      : '* or srn:<project>:<type>:<id>';
  if (resource === undefined) {
    return;
  }

  if (!Array.isArray(resource) || resource.length === 0) {
    errors.push(`${prefix}.resource: must be a non-empty array when present`);
  } else {
    for (const res of resource) {
      if (typeof res !== 'string' || !isValidSrnPattern(res)) {
        errors.push(
          `${prefix}.resource: "${res}" is invalid — must be ${form}`
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

const validateStatement = (args: {
  stmt: unknown;
  index: number;
  allowResourceForm: string | undefined;
  errors: string[];
}): void => {
  const { stmt, index, errors } = args;
  const prefix = `statement[${index}]`;

  if (!stmt || typeof stmt !== 'object' || Array.isArray(stmt)) {
    errors.push(`${prefix}: must be an object`);
    return;
  }

  const stmtObj = stmt as Record<string, unknown>;

  validateEffectField(stmtObj.effect, prefix, errors);
  validateActionField(stmtObj.action, prefix, errors);
  validateResourceField({
    resource: stmtObj.resource,
    effect: stmtObj.effect,
    allowResourceForm: args.allowResourceForm,
    prefix,
    errors,
  });
  validateConditionField(stmtObj.condition, prefix, errors);
  validateDenialField({
    denial: stmtObj.denial,
    effect: stmtObj.effect,
    prefix,
    errors,
  });
};

/**
 * `allowResourceForm` is what a refused `Allow` resource is told to be, for a
 * policy whose `Allow` accepts less than `*` (a project policy).
 */
export const validatePolicyDocument = (
  doc: unknown,
  options: { allowResourceForm?: string } = {}
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
    validateStatement({
      stmt: d.statement[i],
      index: i,
      allowResourceForm: options.allowResourceForm,
      errors,
    });
  }

  return { valid: errors.length === 0, errors };
};
