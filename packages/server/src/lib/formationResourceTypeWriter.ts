/**
 * What a registered formation type does when written, as its registration
 * declares it: the action each lifecycle request takes, and the actions each
 * property carries, on the resource it names or keyed by its value. The runtime asserts all of them for the
 * deployer before calling the handler, which does no authorization of its own.
 */
import { DomainError } from '../errors';
import { isObjectRecord } from './openapiSchemaFields';
import type { CarriedAction } from './writerRule';

const ACTION_PATTERN = /^[a-z][a-z0-9-]*:[A-Z][A-Za-z0-9]*$/;
const RESOURCE_TYPE_PATTERN = /^[a-z][A-Za-z0-9_]*$/;
/** `default.agent_id`, `tools[]`, `routes[].agent_id`. */
const PROPERTY_PATTERN =
  /^[a-z_][a-z0-9_]*(\[\])?(\.[a-z_][a-z0-9_]*(\[\])?)*$/;

export const WRITER_REQUESTS = ['create', 'update', 'delete'] as const;

export type WriterRequest = (typeof WRITER_REQUESTS)[number];

export type KeyedAction = { action: string; resourceType: string };

/**
 * A property naming a resource carries `action` on it; one keyed `byValue`
 * carries each key's actions on the whole type, and accepts no other value.
 */
export type CarriedProperty =
  | { property: string; action: string; resourceType: string }
  | { property: string; byValue: ReadonlyMap<string, readonly KeyedAction[]> };

export type FormationTypeWriter = {
  /** The SRN type the lifecycle actions are checked on. */
  resourceType: string;
  actions: Readonly<Record<WriterRequest, string>>;
  carries: readonly CarriedProperty[];
};

type Fail = (message: string) => never;

const readAction = (args: { value: unknown; at: string; fail: Fail }) => {
  if (typeof args.value === 'string' && ACTION_PATTERN.test(args.value)) {
    return args.value;
  }
  return args.fail(
    `${args.at} must be an IAM action <module>:<Operation>, got '${String(args.value)}'`
  );
};

const readResourceType = (args: { value: unknown; at: string; fail: Fail }) => {
  if (
    typeof args.value === 'string' &&
    RESOURCE_TYPE_PATTERN.test(args.value)
  ) {
    return args.value;
  }
  return args.fail(`${args.at} must be an SRN resource type`);
};

const readKeyedActions = (args: {
  value: unknown;
  at: string;
  fail: Fail;
}): KeyedAction[] => {
  if (!Array.isArray(args.value)) {
    return args.fail(`${args.at} must be an array of actions`);
  }
  return args.value.map((entry, index) => {
    const at = `${args.at}[${index}]`;
    const record = isObjectRecord(entry) ? entry : {};
    return {
      action: readAction({
        value: record.action,
        at: `${at}.action`,
        fail: args.fail,
      }),
      resourceType: readResourceType({
        value: record.resource_type,
        at: `${at}.resource_type`,
        fail: args.fail,
      }),
    };
  });
};

const readByValue = (args: {
  value: unknown;
  at: string;
  fail: Fail;
}): ReadonlyMap<string, readonly KeyedAction[]> => {
  if (!isObjectRecord(args.value) || Object.keys(args.value).length === 0) {
    return args.fail(
      `${args.at}.by_value must map each accepted value to its actions`
    );
  }
  return new Map(
    Object.entries(args.value).map(([key, actions]) => {
      return [
        key,
        readKeyedActions({
          value: actions,
          at: `${args.at}.by_value.${key}`,
          fail: args.fail,
        }),
      ];
    })
  );
};

const parseCarried = (args: {
  entry: unknown;
  at: string;
  properties: ReadonlySet<string>;
  fail: Fail;
}): CarriedProperty => {
  const { at, fail } = args;
  const record = isObjectRecord(args.entry) ? args.entry : {};
  const property = record.property;
  if (typeof property !== 'string' || !PROPERTY_PATTERN.test(property)) {
    return fail(`${at}.property must be a path such as \`tools[]\``);
  }
  const root = property.split(/[.[]/)[0];
  if (!args.properties.has(root)) {
    return fail(
      `${at}.property names '${root}', which the schema does not declare`
    );
  }
  if ('by_value' in record) {
    if ('action' in record || 'resource_type' in record) {
      return fail(
        `${at} declares either \`action\` and \`resource_type\` or \`by_value\``
      );
    }
    return {
      property,
      byValue: readByValue({ value: record.by_value, at, fail }),
    };
  }
  return {
    property,
    action: readAction({ value: record.action, at: `${at}.action`, fail }),
    resourceType: readResourceType({
      value: record.resource_type,
      at: `${at}.resource_type`,
      fail,
    }),
  };
};

const parseCarries = (args: {
  value: unknown;
  properties: ReadonlySet<string>;
  fail: Fail;
}): CarriedProperty[] => {
  if (args.value === undefined) return [];
  if (!Array.isArray(args.value)) {
    return args.fail('`writer.carries` must be an array');
  }
  return args.value.map((entry, index) => {
    return parseCarried({
      entry,
      at: `\`writer.carries[${index}]\``,
      properties: args.properties,
      fail: args.fail,
    });
  });
};

/** Required: a registered type with no declaration could act unchecked. */
export const parseFormationTypeWriter = (args: {
  value: unknown;
  properties: ReadonlySet<string>;
  fail: Fail;
}): FormationTypeWriter => {
  const { value, fail } = args;
  if (!isObjectRecord(value)) {
    return fail(
      '`writer` is required: the actions its create, update and delete take, and what its properties carry'
    );
  }
  const actions = Object.fromEntries(
    WRITER_REQUESTS.map((request) => {
      return [
        request,
        readAction({
          value: value[request],
          at: `\`writer.${request}\``,
          fail,
        }),
      ];
    })
  ) as Record<WriterRequest, string>;
  return {
    resourceType: readResourceType({
      value: value.resource_type,
      at: '`writer.resource_type`',
      fail,
    }),
    actions,
    carries: parseCarries({
      value: value.carries,
      properties: args.properties,
      fail,
    }),
  };
};

/** Every value at `path`; `[]` descends into each element of an array. */
const valuesAt = (value: unknown, path: string[]): unknown[] => {
  if (path.length === 0) return [value];
  if (value === undefined || value === null) return [];
  const [head, ...rest] = path;
  const isList = head.endsWith('[]');
  const key = isList ? head.slice(0, -2) : head;
  if (!isObjectRecord(value)) return [value];
  const next = value[key];
  if (!isList) return valuesAt(next, rest);
  if (next === undefined || next === null) return [];
  if (!Array.isArray(next)) return [next];
  return next.flatMap((item) => {
    return valuesAt(item, rest);
  });
};

const actionsCarriedBy = (args: {
  properties: Record<string, unknown>;
  carried: CarriedProperty;
}): CarriedAction[] => {
  const { carried } = args;
  const values = valuesAt(args.properties, carried.property.split('.'));
  return values.flatMap((value): CarriedAction[] => {
    if (value === undefined || value === null) return [];
    if ('byValue' in carried) {
      const keyed =
        typeof value === 'string' ? carried.byValue.get(value) : undefined;
      if (keyed === undefined) {
        throw new DomainError(
          'VALIDATION_FAILED',
          `\`${carried.property}\` does not accept '${String(value)}'.`
        );
      }
      return keyed.map(({ action, resourceType }) => {
        return { action, resourceType, resourceId: '*' };
      });
    }
    if (typeof value === 'string' && value.length > 0) {
      return [
        {
          action: carried.action,
          resourceType: carried.resourceType,
          resourceId: value,
        },
      ];
    }
    throw new DomainError(
      'VALIDATION_FAILED',
      `\`${carried.property}\` must name a ${carried.resourceType} by id.`
    );
  });
};

/**
 * What a lifecycle request to a registered type performs: its own action, on
 * the resource or the whole type, and every action its properties carry.
 */
export const carriedActionsOfRegisteredWrite = (args: {
  writer: FormationTypeWriter;
  request: WriterRequest;
  physicalResourceId?: string;
  properties?: Record<string, unknown>;
}): CarriedAction[] => {
  const { writer } = args;
  const own: CarriedAction = {
    action: writer.actions[args.request],
    resourceType: writer.resourceType,
    resourceId: args.physicalResourceId ?? '*',
  };
  const properties = args.properties ?? {};
  return [
    own,
    ...writer.carries.flatMap((carried) => {
      return actionsCarriedBy({ properties, carried });
    }),
  ];
};

/** Each action a declaration names, with the SRN type it is checked on. */
export const declaredActionsOf = (
  writer: FormationTypeWriter
): Array<{ action: string; resourceType: string }> => {
  return [
    ...WRITER_REQUESTS.map((request) => {
      return {
        action: writer.actions[request],
        resourceType: writer.resourceType,
      };
    }),
    ...writer.carries.flatMap((carried): KeyedAction[] => {
      if ('byValue' in carried) return [...carried.byValue.values()].flat();
      return [{ action: carried.action, resourceType: carried.resourceType }];
    }),
  ];
};
