import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { normalizePath } from 'src/lib/filePaths';
import { isObjectRecord } from 'src/lib/openapiSchemaFields';
import { getMergedOpenApiSpec } from 'src/lib/openapiSpec';

/**
 * A pin is a list filter that also confines the resource's create and by-id
 * routes. The spec declares it once, as `x-soat-pin: { field, match }` on the
 * list operation's query parameter; this module is the only reader of a pin
 * and the only place its rule runs (`tests/harness/queryPins.test.mjs`).
 */
type PinMatch = 'equals' | 'path_prefix';

type Pin = { param: string; field: string; match: PinMatch };

type PinnedValues = Record<string, unknown>;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];

const readPinDeclaration = (parameter: unknown): Pin | null => {
  if (!isObjectRecord(parameter)) return null;
  const declaration = parameter['x-soat-pin'];
  if (declaration === undefined) return null;
  if (
    !isObjectRecord(declaration) ||
    typeof parameter.name !== 'string' ||
    typeof declaration.field !== 'string' ||
    (declaration.match !== 'equals' && declaration.match !== 'path_prefix')
  ) {
    throw new Error(`Malformed x-soat-pin on ${String(parameter.name)}`);
  }
  return {
    param: parameter.name,
    field: declaration.field,
    match: declaration.match,
  };
};

const findOperation = (operationId: string): Record<string, unknown> => {
  for (const pathItem of Object.values(getMergedOpenApiSpec().paths)) {
    if (!isObjectRecord(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (isObjectRecord(operation) && operation.operationId === operationId) {
        return operation;
      }
    }
  }
  throw new Error(`No operation ${operationId} in the OpenAPI spec`);
};

const declaredPins = (listOperation: string): Pin[] => {
  const { parameters } = findOperation(listOperation);
  if (!Array.isArray(parameters)) return [];
  return parameters.flatMap((parameter) => {
    const pin = readPinDeclaration(parameter);
    return pin ? [pin] : [];
  });
};

/** A repeated pin is refused rather than read as absent, which would drop it. */
const readQueryPin = (ctx: Context, name: string): string | undefined => {
  const value = ctx.query[name];
  if (value === undefined || typeof value === 'string') return value;
  throw new DomainError(
    'VALIDATION_FAILED',
    `${name} must be given at most once.`
  );
};

/**
 * The directory a `path_prefix` names, with the listing filter's boundary rule
 * (`pathPrefixPattern`): `/a` and `/a/` both mean `/a/`, so a pin on
 * `/x/actor_ab` never reaches `/x/actor_abc/`.
 */
const pinDirectory = (pin: string): string => {
  const normalized = normalizePath(pin);
  return normalized === '/' ? '/' : `${normalized}/`;
};

const holds = (args: { match: PinMatch; value: unknown; pin: string }) => {
  if (args.match === 'equals') return args.value === args.pin;
  if (typeof args.value !== 'string' || !args.value) return false;
  return normalizePath(args.value).startsWith(pinDirectory(args.pin));
};

export type PinViolation = {
  param: string;
  field: string;
  value: unknown;
  pin: string;
};

/**
 * The pins of one resource, read from its list operation's declaration.
 *
 * - `assertItem`: a loaded item outside a pin the call names is `notFound`,
 *   as if it did not exist; a missing item is `notFound` too. Returns the
 *   item.
 * - `assertWrite`: a write whose values would land outside a pin is refused
 *   with `refuseWrite`. Only the pinned fields present in `values` are checked,
 *   so a partial update leaves an untouched field alone.
 */
export const resourcePins = (args: { listOperation: string }) => {
  let pins: Pin[] | undefined;
  const pinsOf = (): Pin[] => {
    pins ??= declaredPins(args.listOperation);
    return pins;
  };

  const present = (ctx: Context) => {
    return pinsOf().flatMap((pin) => {
      const value = readQueryPin(ctx, pin.param);
      return value === undefined ? [] : [{ ...pin, value }];
    });
  };

  const firstViolation = (check: {
    pinned: ReturnType<typeof present>;
    values: PinnedValues;
    fields: 'given' | 'all';
  }): PinViolation | null => {
    for (const pin of check.pinned) {
      if (check.fields === 'given' && !(pin.field in check.values)) continue;
      const value = check.values[pin.field];
      if (!holds({ match: pin.match, value, pin: pin.value })) {
        return { param: pin.param, field: pin.field, value, pin: pin.value };
      }
    }
    return null;
  };

  return {
    /** One pin's value, for a listing that filters by it. */
    read: (ctx: Context, param: string): string | undefined => {
      if (
        !pinsOf().some((pin) => {
          return pin.param === param;
        })
      ) {
        throw new Error(`${param} is not a pin of ${args.listOperation}`);
      }
      return readQueryPin(ctx, param);
    },
    /** Whether the call names any of this resource's pins. */
    isPinned: (ctx: Context): boolean => {
      return present(ctx).length > 0;
    },
    assertItem: <Item extends PinnedValues>(input: {
      ctx: Context;
      item: Item | null | undefined;
      notFound: () => DomainError;
    }): Item => {
      // Read before the existence check, so a repeated pin is `400` either way.
      const pinned = present(input.ctx);
      if (
        !input.item ||
        firstViolation({ pinned, values: input.item, fields: 'all' })
      ) {
        throw input.notFound();
      }
      return input.item;
    },
    assertWrite: (input: {
      ctx: Context;
      values: PinnedValues;
      refuseWrite: (violation: PinViolation) => DomainError;
    }): void => {
      const violation = firstViolation({
        pinned: present(input.ctx),
        values: input.values,
        fields: 'given',
      });
      if (violation) throw input.refuseWrite(violation);
    },
  };
};
