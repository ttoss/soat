import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { DomainError } from '../errors';
import { asJsonb, jsonbFn } from './jsonbQuery';
import { isPlainObject } from './plainObject';

/**
 * A structured question about a JSON field, such as a `metadata` bag.
 *
 * Equality and `in` are containment — the `@>` match `?tags=` already uses —
 * so they read a value exactly as it is stored, and a number never answers to
 * its string spelling.
 *
 * Ordering cannot be asked that way. It compares the stored value to a JSON
 * operand, and the operand says which comparison is meant: a number orders
 * numerically, a string lexicographically. The guard is what keeps that honest
 * — JSONB orders every string below every number, so without it a `lt` would
 * return each row whose field holds unrelated text. The guard and the
 * comparison are one expression per bound, so neither can be evaluated without
 * the other.
 *
 * A prefix asks the same way: only a string field is compared, and the operand
 * is literal text, never a pattern.
 */

type Scalar = string | number | boolean | null;

/** Operands an ordering can be asked about: the JSON types that order. */
type Orderable = string | number;

type RangeOperator = 'gt' | 'gte' | 'lt' | 'lte';

const RANGE_OPERATORS: Record<RangeOperator, symbol> = {
  gt: Op.gt,
  gte: Op.gte,
  lt: Op.lt,
  lte: Op.lte,
};

const IN_OPERATOR = 'in';

const PREFIX_OPERATOR = 'prefix';

const OPERATOR_NAMES = [
  ...Object.keys(RANGE_OPERATORS),
  PREFIX_OPERATOR,
  IN_OPERATOR,
];

/** One condition on a field; every condition on a field must hold. */
type Condition =
  | { operator: RangeOperator; value: Orderable }
  | { operator: typeof PREFIX_OPERATOR; value: string };

type FieldFilter =
  | { kind: 'eq'; value: Scalar }
  | { kind: 'in'; values: Scalar[] }
  | { kind: 'conditions'; conditions: Condition[] };

export type StructuredFilter = Record<string, FieldFilter>;

const refuse = (message: string, field?: string): never => {
  throw new DomainError(
    'VALIDATION_FAILED',
    message,
    field === undefined ? undefined : { field }
  );
};

const isScalar = (value: unknown): value is Scalar => {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
};

const isRangeOperator = (key: string): key is RangeOperator => {
  return key in RANGE_OPERATORS;
};

const readIn = (args: {
  name: string;
  field: string;
  value: unknown;
}): FieldFilter => {
  const values = args.value;
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !values.every(isScalar)
  ) {
    return refuse(
      `${args.name} filter '${args.field}': in needs a non-empty list of values.`,
      args.field
    );
  }
  return { kind: 'in', values };
};

const readCondition = (args: {
  name: string;
  field: string;
  key: string;
  operand: unknown;
}): Condition => {
  const { name, field, key, operand } = args;
  if (key === PREFIX_OPERATOR) {
    if (typeof operand !== 'string') {
      return refuse(
        `${name} filter '${field}': prefix matches the start of a string, so it takes a string.`,
        field
      );
    }
    return { operator: PREFIX_OPERATOR, value: operand };
  }
  if (!isRangeOperator(key)) {
    return refuse(
      `${name} filter '${field}': '${key}' is not an operator. Use one of: ${OPERATOR_NAMES.join(', ')}.`,
      field
    );
  }
  if (typeof operand !== 'string' && typeof operand !== 'number') {
    return refuse(
      `${name} filter '${field}': ${key} compares against a string or a number.`,
      field
    );
  }
  return { operator: key, value: operand };
};

const readConditions = (args: {
  name: string;
  field: string;
  operators: Record<string, unknown>;
}): FieldFilter => {
  return {
    kind: 'conditions',
    conditions: Object.entries(args.operators).map(([key, operand]) => {
      return readCondition({
        name: args.name,
        field: args.field,
        key,
        operand,
      });
    }),
  };
};

const readFieldFilter = (args: {
  name: string;
  field: string;
  value: unknown;
}): FieldFilter => {
  if (isScalar(args.value)) return { kind: 'eq', value: args.value };
  if (!isPlainObject(args.value)) {
    return refuse(
      `${args.name} filter '${args.field}' must be a value or an operator object; a list of values is written { "in": [...] }.`,
      args.field
    );
  }

  const keys = Object.keys(args.value);
  if (keys.length === 0) {
    return refuse(
      `${args.name} filter '${args.field}' names no operator.`,
      args.field
    );
  }
  if (keys.includes(IN_OPERATOR)) {
    if (keys.length > 1) {
      return refuse(
        `${args.name} filter '${args.field}': in is a set of values, so it stands alone.`,
        args.field
      );
    }
    return readIn({
      name: args.name,
      field: args.field,
      value: args.value[IN_OPERATOR],
    });
  }
  return readConditions({
    name: args.name,
    field: args.field,
    operators: args.value,
  });
};

/**
 * Reads the filter as a request body carries it: a JSON object, whose values
 * already say what type they are.
 *
 * @param name the request field carrying the filter, named in refusals.
 */
export const readStructuredFilter = (args: {
  name: string;
  value: unknown;
}): StructuredFilter | undefined => {
  const { name, value } = args;
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    return refuse(`${name} must be an object of field filters.`);
  }
  const filter: StructuredFilter = {};
  for (const [field, raw] of Object.entries(value)) {
    filter[field] = readFieldFilter({ name, field, value: raw });
  }
  return filter;
};

/**
 * Reads the same filter from a query string, where it travels as JSON: a
 * `key:value` spelling like `?tags=` cannot say whether `3` is the number or
 * the string, and containment tells those apart.
 */
export const readStructuredQuery = (args: {
  name: string;
  query: Record<string, string | string[] | undefined>;
}): StructuredFilter | undefined => {
  const { name } = args;
  const raw = args.query[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    return refuse(`${name} is one JSON object, not a repeated parameter.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse(`${name} must be a JSON object.`);
  }
  return readStructuredFilter({ name, value: parsed });
};

/** Whether a filter narrows anything: an empty one matches every row. */
export const hasStructuredFilter = (
  filter: StructuredFilter | undefined
): filter is StructuredFilter => {
  return filter !== undefined && Object.keys(filter).length > 0;
};

/**
 * JSONB containment: the bag holds every requested pair with exactly that
 * value, read as it is stored.
 *
 * The one matching rule both bags are asked equality with — `?tags=` through
 * `tagContainment`, and the `metadata` filter's equality and `in` — so a
 * number never answers to its string spelling on either, and both can use the
 * column's index. The attribute is named rather than qualified: Sequelize
 * resolves it against the model the query is rooted at, which is what lets one
 * fragment serve a listing and a joined chunk scan alike.
 */
export const containment = (args: {
  attribute: string;
  bag: Record<string, Scalar>;
}): Record<string, Record<symbol, Record<string, Scalar>>> => {
  return { [args.attribute]: { [Op.contains]: args.bag } };
};

const jsonTypeOf = (value: Orderable): 'string' | 'number' => {
  return typeof value === 'number' ? 'number' : 'string';
};

/**
 * One bound, as the guard and the comparison it is only meaningful with.
 *
 * `jsonb_typeof` fences the comparison to rows whose field actually holds that
 * type; the comparison itself is JSONB against JSONB, so it never casts and
 * therefore never fails on a row holding something else.
 */
const boundWhere = (args: {
  column: string;
  field: string;
  operator: RangeOperator;
  value: Orderable;
}) => {
  const source = {
    sql: `${args.column} -> ${db.sequelize.escape(args.field)}`,
  };
  const path = asJsonb(source);
  return {
    [Op.and]: [
      db.sequelize.where(
        jsonbFn({ fn: 'typeof', source }),
        jsonTypeOf(args.value)
      ),
      db.sequelize.where(path, {
        [RANGE_OPERATORS[args.operator]]: db.sequelize.literal(
          `${db.sequelize.escape(JSON.stringify(args.value))}::jsonb`
        ),
      }),
    ],
  };
};

/** `%`, `_` and the escape character itself, read literally by `LIKE`. */
const likeLiteral = (value: string): string => {
  return value.replace(/[\\%_]/g, (char) => {
    return `\\${char}`;
  });
};

/**
 * A prefix, fenced like a bound: only a field holding a string is compared,
 * and `LIKE` reads the operand literally (backslash is its default escape).
 */
const prefixWhere = (args: {
  column: string;
  field: string;
  value: string;
}) => {
  const source = {
    sql: `${args.column} -> ${db.sequelize.escape(args.field)}`,
  };
  return {
    [Op.and]: [
      db.sequelize.where(jsonbFn({ fn: 'typeof', source }), 'string'),
      db.sequelize.where(
        db.sequelize.literal(
          `${args.column} ->> ${db.sequelize.escape(args.field)}`
        ),
        { [Op.like]: `${likeLiteral(args.value)}%` }
      ),
    ],
  };
};

const conditionWhere = (args: {
  column: string;
  field: string;
  condition: Condition;
}) => {
  const { condition } = args;
  if (condition.operator === PREFIX_OPERATOR) {
    return prefixWhere({
      column: args.column,
      field: args.field,
      value: condition.value,
    });
  }
  return boundWhere({
    column: args.column,
    field: args.field,
    operator: condition.operator,
    value: condition.value,
  });
};

/**
 * ANDs compiled fragments — either bag's — into a where a caller is already
 * building.
 *
 * Appends rather than assigns: a compiled IAM policy lands under the same
 * `Op.and`, and replacing it would drop the constraint that decides which rows
 * the caller may see at all.
 */
export const applyFilterWhere = (args: {
  where: Record<string, unknown>;
  fragments: unknown[];
}): void => {
  if (args.fragments.length === 0) return;
  const existing = Reflect.get(args.where, Op.and);
  const present = Array.isArray(existing)
    ? existing
    : existing === undefined
      ? []
      : [existing];
  Reflect.set(args.where, Op.and, [...present, ...args.fragments]);
};

/**
 * The where-fragments a filter compiles to, to be ANDed into the query the
 * caller is already building.
 *
 * @param attribute the JSON attribute filtered, as the model names it — the
 *   containment halves let Sequelize qualify it.
 * @param column the same column qualified by the alias its query roots the row
 *   at — a raw comparison names the column itself.
 */
export const compileStructuredWhere = (args: {
  filter: StructuredFilter | undefined;
  attribute: string;
  column: string;
}): unknown[] => {
  if (!hasStructuredFilter(args.filter)) return [];

  const equality: Record<string, Scalar> = {};
  const fragments: unknown[] = [];

  for (const [field, filter] of Object.entries(args.filter)) {
    switch (filter.kind) {
      case 'eq':
        equality[field] = filter.value;
        break;
      case 'in':
        fragments.push({
          [Op.or]: filter.values.map((value) => {
            return containment({
              attribute: args.attribute,
              bag: { [field]: value },
            });
          }),
        });
        break;
      case 'conditions':
        for (const condition of filter.conditions) {
          fragments.push(
            conditionWhere({ column: args.column, field, condition })
          );
        }
        break;
    }
  }

  if (Object.keys(equality).length > 0) {
    fragments.push(containment({ attribute: args.attribute, bag: equality }));
  }

  return fragments;
};

const boundHolds = (args: {
  operator: RangeOperator;
  actual: Orderable;
  value: Orderable;
}): boolean => {
  const { operator, actual, value } = args;
  if (operator === 'gt') return actual > value;
  if (operator === 'gte') return actual >= value;
  if (operator === 'lt') return actual < value;
  return actual <= value;
};

const isOrderable = (value: unknown): value is Orderable => {
  return typeof value === 'string' || typeof value === 'number';
};

const conditionHolds = (args: { condition: Condition; actual: unknown }) => {
  const { condition, actual } = args;
  if (condition.operator === PREFIX_OPERATOR) {
    return typeof actual === 'string' && actual.startsWith(condition.value);
  }
  return (
    isOrderable(actual) &&
    typeof actual === jsonTypeOf(condition.value) &&
    boundHolds({ operator: condition.operator, actual, value: condition.value })
  );
};

const fieldMatches = (args: { filter: FieldFilter; actual: unknown }) => {
  const { filter, actual } = args;
  if (filter.kind === 'eq') return actual === filter.value;
  if (filter.kind === 'in') {
    return filter.values.some((value) => {
      return value === actual;
    });
  }
  return filter.conditions.every((condition) => {
    return conditionHolds({ condition, actual });
  });
};

/**
 * The filter asked of one in-memory object, with the meaning the compiled
 * query gives it: equality and `in` compare a top-level value exactly, an
 * ordering holds only on a value of its operand's type, and a prefix only on a
 * string. An absent field never matches.
 */
export const matchesStructuredFilter = (args: {
  filter: StructuredFilter | undefined;
  data: unknown;
}): boolean => {
  if (!hasStructuredFilter(args.filter)) return true;
  const data = isPlainObject(args.data) ? args.data : {};
  return Object.entries(args.filter).every(([field, filter]) => {
    return (
      Object.hasOwn(data, field) &&
      fieldMatches({ filter, actual: data[field] })
    );
  });
};
