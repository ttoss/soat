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

const OPERATOR_NAMES = [...Object.keys(RANGE_OPERATORS), IN_OPERATOR];

type FieldFilter =
  | { kind: 'eq'; value: Scalar }
  | { kind: 'in'; values: Scalar[] }
  | { kind: 'range'; bounds: { operator: RangeOperator; value: Orderable }[] };

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

const readRange = (args: {
  name: string;
  field: string;
  operators: Record<string, unknown>;
}): FieldFilter => {
  const bounds: { operator: RangeOperator; value: Orderable }[] = [];
  for (const [key, operand] of Object.entries(args.operators)) {
    if (!isRangeOperator(key)) {
      return refuse(
        `${args.name} filter '${args.field}': '${key}' is not an operator. Use one of: ${OPERATOR_NAMES.join(', ')}.`,
        args.field
      );
    }
    if (typeof operand !== 'string' && typeof operand !== 'number') {
      return refuse(
        `${args.name} filter '${args.field}': ${key} compares against a string or a number.`,
        args.field
      );
    }
    bounds.push({ operator: key, value: operand });
  }
  return { kind: 'range', bounds };
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
  return readRange({
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
      case 'range':
        for (const bound of filter.bounds) {
          fragments.push(boundWhere({ ...bound, column: args.column, field }));
        }
        break;
    }
  }

  if (Object.keys(equality).length > 0) {
    fragments.push(containment({ attribute: args.attribute, bag: equality }));
  }

  return fragments;
};
