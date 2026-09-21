import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { DomainError } from '../errors';
import type { OrderableJsonType } from './metadataSchemas';
import { declaredDocumentFieldTypes } from './metadataSchemas';
import { isPlainObject } from './plainObject';

/**
 * A structured question about a `metadata` bag.
 *
 * Equality and `in` are containment — the `@>` match `?tags=` already uses —
 * so they read a value exactly as it is stored, and a number never answers to
 * its string spelling.
 *
 * Ordering cannot be asked that way. It compares the stored value to a JSON
 * operand and is guarded by the value's own type, because JSONB orders every
 * string below every number: without the guard a `lt` would return each row
 * whose field holds unrelated text. The guard and the comparison are one
 * expression per bound, so neither can be evaluated without the other.
 *
 * An ordering also has to know which comparison is meant, and only a metadata
 * schema says. A range over a field no declaration types is refused rather
 * than guessed — which is also what answers a misspelled field, where the
 * alternative is an empty page that reads as "nothing matched".
 */

type Scalar = string | number | boolean | null;

/** Operands an ordering can be asked about: the JSON types a schema orders. */
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

export type MetadataFilter = Record<string, FieldFilter>;

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

const readIn = (args: { field: string; value: unknown }): FieldFilter => {
  const values = args.value;
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !values.every(isScalar)
  ) {
    return refuse(
      `metadata filter '${args.field}': in needs a non-empty list of values.`,
      args.field
    );
  }
  return { kind: 'in', values };
};

const readRange = (args: {
  field: string;
  operators: Record<string, unknown>;
}): FieldFilter => {
  const bounds: { operator: RangeOperator; value: Orderable }[] = [];
  for (const [key, operand] of Object.entries(args.operators)) {
    if (!isRangeOperator(key)) {
      return refuse(
        `metadata filter '${args.field}': '${key}' is not an operator. Use one of: ${OPERATOR_NAMES.join(', ')}.`,
        args.field
      );
    }
    if (typeof operand !== 'string' && typeof operand !== 'number') {
      return refuse(
        `metadata filter '${args.field}': ${key} compares against a string or a number.`,
        args.field
      );
    }
    bounds.push({ operator: key, value: operand });
  }
  return { kind: 'range', bounds };
};

const readFieldFilter = (args: {
  field: string;
  value: unknown;
}): FieldFilter => {
  if (isScalar(args.value)) return { kind: 'eq', value: args.value };
  if (!isPlainObject(args.value)) {
    return refuse(
      `metadata filter '${args.field}' must be a value or an operator object; a list of values is written { "in": [...] }.`,
      args.field
    );
  }

  const keys = Object.keys(args.value);
  if (keys.length === 0) {
    return refuse(
      `metadata filter '${args.field}' names no operator.`,
      args.field
    );
  }
  if (keys.includes(IN_OPERATOR)) {
    if (keys.length > 1) {
      return refuse(
        `metadata filter '${args.field}': in is a set of values, so it stands alone.`,
        args.field
      );
    }
    return readIn({ field: args.field, value: args.value[IN_OPERATOR] });
  }
  return readRange({ field: args.field, operators: args.value });
};

/**
 * Reads the filter as a request body carries it: a JSON object, whose values
 * already say what type they are.
 */
export const readMetadataFilter = (
  value: unknown
): MetadataFilter | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    return refuse('metadata must be an object of field filters.');
  }
  const filter: MetadataFilter = {};
  for (const [field, raw] of Object.entries(value)) {
    filter[field] = readFieldFilter({ field, value: raw });
  }
  return filter;
};

/**
 * Reads the same filter from a query string, where it travels as JSON: a
 * `key:value` spelling like `?tags=` cannot say whether `3` is the number or
 * the string, and containment tells those apart.
 */
export const readMetadataQuery = (
  raw: string | string[] | undefined
): MetadataFilter | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    return refuse('metadata is one JSON object, not a repeated parameter.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse('metadata must be a JSON object.');
  }
  return readMetadataFilter(parsed);
};

/** Whether a filter narrows anything: an empty one matches every row. */
export const hasMetadataFilter = (
  filter: MetadataFilter | undefined
): filter is MetadataFilter => {
  return filter !== undefined && Object.keys(filter).length > 0;
};

const containment = (bag: Record<string, Scalar>) => {
  return { metadata: { [Op.contains]: bag } };
};

const jsonTypeOf = (value: Orderable): OrderableJsonType => {
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
  const path = db.sequelize.literal(
    `${args.column} -> ${db.sequelize.escape(args.field)}`
  );
  return {
    [Op.and]: [
      db.sequelize.where(
        db.sequelize.fn(
          'jsonb_typeof',
          db.sequelize.literal(
            `${args.column} -> ${db.sequelize.escape(args.field)}`
          )
        ),
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
 * The project whose declarations type a range. Declarations are project-scoped,
 * so a query spanning several — or every one a JWT reaches — has no single
 * answer to what a field is, and is told so rather than served one project's.
 */
const onlyProject = (projectIds: number[] | undefined): number => {
  if (projectIds?.length !== 1) {
    return refuse(
      'A metadata range needs project_id: the declaration that types the field is project-scoped.'
    );
  }
  return projectIds[0];
};

const compileRanges = async (args: {
  ranges: [string, { operator: RangeOperator; value: Orderable }[]][];
  column: string;
  projectIds?: number[];
}): Promise<unknown[]> => {
  const declared = await declaredDocumentFieldTypes({
    projectId: onlyProject(args.projectIds),
  });

  const fragments: unknown[] = [];
  for (const [field, bounds] of args.ranges) {
    const type = declared.get(field);
    if (!type) {
      refuse(
        `metadata filter '${field}': no metadata schema in this project declares an orderable type for it, so gt/gte/lt/lte have no comparison to make.`,
        field
      );
    }
    for (const bound of bounds) {
      if (jsonTypeOf(bound.value) !== type) {
        refuse(
          `metadata filter '${field}' is declared as ${type}, so ${bound.operator} compares against a ${type}.`,
          field
        );
      }
      fragments.push(boundWhere({ ...bound, column: args.column, field }));
    }
  }
  return fragments;
};

/**
 * ANDs compiled fragments into a where a caller is already building.
 *
 * Appends rather than assigns: a compiled IAM policy lands under the same
 * `Op.and`, and replacing it would drop the constraint that decides which rows
 * the caller may see at all.
 */
export const applyMetadataWhere = (args: {
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
 * @param column the `metadata` column qualified by the alias its query roots
 *   the document at — a raw comparison names the column itself, where the
 *   containment halves let Sequelize qualify it.
 */
export const compileMetadataWhere = async (args: {
  filter: MetadataFilter | undefined;
  column: string;
  projectIds?: number[];
}): Promise<unknown[]> => {
  if (!hasMetadataFilter(args.filter)) return [];

  const equality: Record<string, Scalar> = {};
  const ranges: [string, { operator: RangeOperator; value: Orderable }[]][] =
    [];
  const fragments: unknown[] = [];

  for (const [field, filter] of Object.entries(args.filter)) {
    switch (filter.kind) {
      case 'eq':
        equality[field] = filter.value;
        break;
      case 'in':
        fragments.push({
          [Op.or]: filter.values.map((value) => {
            return containment({ [field]: value });
          }),
        });
        break;
      case 'range':
        ranges.push([field, filter.bounds]);
        break;
    }
  }

  if (Object.keys(equality).length > 0) fragments.push(containment(equality));
  if (ranges.length > 0) {
    fragments.push(
      ...(await compileRanges({
        ranges,
        column: args.column,
        projectIds: args.projectIds,
      }))
    );
  }

  return fragments;
};
