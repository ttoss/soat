/**
 * `for_each` on a resource declaration: one resource per entry of a map, each
 * named `<LogicalId>[<key>]` and keyed by its entry, so adding or removing one
 * entry never touches another. `{ "each": "key" | "value" }` and
 * `${each.key}` / `${each.value}` inside a `sub` read the entry.
 *
 * Expanded where a template enters (`parseFormationTemplateInput`), so every
 * later stage, and the stored template, sees only ordinary resources. A
 * declaration whose `for_each` has a problem stays unexpanded, and validation
 * reports that problem from `forEachProblems`.
 */

import createDebug from 'debug';

import type { ValidationError } from './formationsTypes';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:formations');

type Entries = Record<string, unknown>;

const EACH_TOKEN_RE = /\$\{each\.([^}]*)\}/g;
const ANY_EACH_TOKEN_RE = /\$\{each\./;
const FORBIDDEN_KEY_CHARS = /[[\]{}]/;

const isEachExpression = (value: unknown): value is { each: unknown } => {
  return (
    isPlainObject(value) && Object.keys(value).length === 1 && 'each' in value
  );
};

const isSubExpression = (value: unknown): value is { sub: string } => {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    typeof value.sub === 'string'
  );
};

export const instanceLogicalId = (args: {
  logicalId: string;
  key: string;
}): string => {
  return `${args.logicalId}[${args.key}]`;
};

/** Whether a value carries an `each` expression anywhere inside it. */
const usesEach = (value: unknown): boolean => {
  if (isEachExpression(value)) return true;
  if (isSubExpression(value)) return ANY_EACH_TOKEN_RE.test(value.sub);
  if (Array.isArray(value)) return value.some(usesEach);
  if (isPlainObject(value)) return Object.values(value).some(usesEach);
  return false;
};

/** Every `each` reference made inside a value, as `key` / `value` / other. */
const eachReferences = (value: unknown, found: Set<string>): Set<string> => {
  if (isEachExpression(value)) {
    found.add(typeof value.each === 'string' ? value.each : '');
  } else if (isSubExpression(value)) {
    for (const match of value.sub.matchAll(EACH_TOKEN_RE)) {
      found.add(`sub:${match[1]}`);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      eachReferences(item, found);
    }
  } else if (isPlainObject(value)) {
    for (const item of Object.values(value)) {
      eachReferences(item, found);
    }
  }
  return found;
};

const isText = (value: unknown): boolean => {
  return ['string', 'number', 'boolean'].includes(typeof value);
};

const referenceProblems = (args: {
  decl: Record<string, unknown>;
  entries: Entries;
}): string[] => {
  const refs = eachReferences(
    [args.decl.properties, args.decl.metadata],
    new Set()
  );
  const problems: string[] = [];
  for (const ref of refs) {
    if (ref === 'key' || ref === 'value' || ref === 'sub:key') continue;
    if (ref === 'sub:value') {
      const nonText = Object.keys(args.entries).find((key) => {
        return !isText(args.entries[key]);
      });
      if (nonText !== undefined) {
        problems.push(
          `\`\${each.value}\` in a \`sub\` needs text values; entry '${nonText}' is not text — use \`{ "each": "value" }\` instead`
        );
      }
      continue;
    }
    const name = ref.startsWith('sub:') ? ref.slice(4) : ref;
    problems.push(`\`each\` reads \`key\` or \`value\`, not '${name}'`);
  }
  return problems;
};

/**
 * Why a declaration's `for_each` cannot be expanded, or nothing when it can.
 * `logicalIds` is every other logical id the template declares, which an
 * instance id may not reuse.
 */
export const forEachProblems = (args: {
  logicalId: string;
  decl: Record<string, unknown>;
  logicalIds: Set<string>;
}): string[] => {
  const entries = args.decl.for_each;
  if (!isPlainObject(entries)) {
    return ['`for_each` must be an object mapping each key to its value'];
  }

  const problems: string[] = [];
  for (const key of Object.keys(entries)) {
    if (key === '') {
      problems.push('`for_each` keys must not be empty');
    } else if (FORBIDDEN_KEY_CHARS.test(key)) {
      problems.push(
        `\`for_each\` key '${key}' must not contain '[', ']', '{' or '}'`
      );
    } else {
      const id = instanceLogicalId({ logicalId: args.logicalId, key });
      if (args.logicalIds.has(id)) {
        problems.push(
          `\`for_each\` key '${key}' names '${id}', which another resource already declares`
        );
      }
    }
  }
  problems.push(...referenceProblems({ decl: args.decl, entries }));
  return problems;
};

const substitute = (args: {
  node: unknown;
  key: string;
  value: unknown;
}): unknown => {
  const { node, key, value } = args;
  if (isEachExpression(node)) {
    return node.each === 'key' ? key : value;
  }
  if (isSubExpression(node)) {
    return {
      sub: node.sub.replace(EACH_TOKEN_RE, (_token, name: string) => {
        return name === 'key' ? key : String(value);
      }),
    };
  }
  if (Array.isArray(node)) {
    return node.map((item) => {
      return substitute({ node: item, key, value });
    });
  }
  if (isPlainObject(node)) {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => {
        return [k, substitute({ node: v, key, value })];
      })
    );
  }
  return node;
};

const instancesOf = (args: {
  logicalId: string;
  decl: Record<string, unknown>;
}): [string, Record<string, unknown>][] => {
  const { for_each: entries, ...rest } = args.decl;
  return Object.entries(entries as Entries).map(([key, value]) => {
    const instance: Record<string, unknown> = { ...rest };
    for (const field of ['properties', 'metadata'] as const) {
      if (rest[field] !== undefined) {
        instance[field] = substitute({ node: rest[field], key, value });
      }
    }
    return [instanceLogicalId({ logicalId: args.logicalId, key }), instance];
  });
};

/** `depends_on` naming an expanded group waits on every one of its instances. */
const withGroupsExpanded = (args: {
  decl: unknown;
  groups: Map<string, string[]>;
}): unknown => {
  const { decl, groups } = args;
  if (!isPlainObject(decl) || !Array.isArray(decl.depends_on)) return decl;
  return {
    ...decl,
    depends_on: decl.depends_on.flatMap((name: unknown) => {
      return typeof name === 'string' ? (groups.get(name) ?? [name]) : [name];
    }),
  };
};

/**
 * The template with every well-formed `for_each` declaration replaced by its
 * instances. Returns the input by identity when nothing expands.
 */
export const expandForEach = (template: unknown): unknown => {
  if (!isPlainObject(template) || !isPlainObject(template.resources)) {
    return template;
  }
  const declared = template.resources;
  const expandable = Object.entries(declared).filter(([logicalId, decl]) => {
    if (!isPlainObject(decl) || decl.for_each === undefined) return false;
    const others = new Set(Object.keys(declared));
    others.delete(logicalId);
    return (
      forEachProblems({ logicalId, decl, logicalIds: others }).length === 0
    );
  });
  if (expandable.length === 0) return template;
  log(
    'expandForEach: groups=%o',
    expandable.map(([id]) => {
      return id;
    })
  );

  const groups = new Map<string, string[]>();
  const expanded: [string, unknown][] = [];
  for (const [logicalId, decl] of Object.entries(declared)) {
    const isGroup = expandable.some(([id]) => {
      return id === logicalId;
    });
    if (!isGroup) {
      expanded.push([logicalId, decl]);
      continue;
    }
    const instances = instancesOf({
      logicalId,
      decl: decl as Record<string, unknown>,
    });
    groups.set(
      logicalId,
      instances.map(([id]) => {
        return id;
      })
    );
    expanded.push(...instances);
  }
  const resources = Object.fromEntries(
    expanded.map(([logicalId, decl]) => {
      return [logicalId, withGroupsExpanded({ decl, groups })];
    })
  );
  log('expandForEach: resources=%d', Object.keys(resources).length);
  return { ...template, resources };
};

/**
 * The `for_each` problems of one declaration as validation errors: a
 * `for_each` left unexpanded, or an `each` expression outside one.
 */
export const forEachValidationErrors = (args: {
  logicalId: string;
  decl: Record<string, unknown>;
  logicalIds: Set<string>;
}): ValidationError[] => {
  const basePath = `resources.${args.logicalId}`;
  if (args.decl.for_each !== undefined) {
    const others = new Set(args.logicalIds);
    others.delete(args.logicalId);
    return forEachProblems({ ...args, logicalIds: others }).map((message) => {
      return { path: `${basePath}.for_each`, message };
    });
  }
  return (['properties', 'metadata'] as const).flatMap((field) => {
    return usesEach(args.decl[field])
      ? [
          {
            path: `${basePath}.${field}`,
            message:
              '`each` is only defined inside a resource that declares `for_each`',
          },
        ]
      : [];
  });
};
