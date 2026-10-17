import type {
  PlaybookDefinition,
  PlaybookExecutor,
  PlaybookInputSource,
} from './playbookDefinition';
import { nodesByKey } from './playbookGraph';
import { stableDigest } from './stableDigest';

export type PlaybookInputChange =
  'added' | 'removed' | 'source' | 'schema' | 'required';

export type PlaybookNodeChange = {
  node_id: string;
  executor: boolean;
  inputs: { name: string; change: PlaybookInputChange }[];
};

export type PlaybookUpgradeDiff = {
  added: string[];
  removed: string[];
  changed: PlaybookNodeChange[];
};

const sameSource = (args: {
  left: PlaybookInputSource;
  right: PlaybookInputSource;
}): boolean => {
  const { left, right } = args;

  if (left === 'manual' || right === 'manual') return left === right;

  return left.node_id === right.node_id && left.field === right.field;
};

const sameExecutor = (args: {
  left?: PlaybookExecutor;
  right?: PlaybookExecutor;
}): boolean => {
  return stableDigest(args.left ?? null) === stableDigest(args.right ?? null);
};

/**
 * What an upgrade from one version to another changes, by node id. Titles,
 * descriptions and transformations change no value, so they are not listed.
 */
export const playbookUpgradeDiff = (args: {
  from: PlaybookDefinition;
  to: PlaybookDefinition;
}): PlaybookUpgradeDiff => {
  const before = nodesByKey({ definition: args.from });
  const after = nodesByKey({ definition: args.to });

  const changed: PlaybookNodeChange[] = [];

  for (const [key, node] of after) {
    const old = before.get(key);

    if (!old) continue;

    const oldInputs = new Map(
      old.inputs.map((input) => {
        return [input.name, input];
      })
    );
    const names = new Set(
      node.inputs.map((input) => {
        return input.name;
      })
    );

    const inputs: PlaybookNodeChange['inputs'] = node.inputs.flatMap(
      (input) => {
        const was = oldInputs.get(input.name);
        const change: PlaybookInputChange | undefined = !was
          ? 'added'
          : !sameSource({ left: was.source, right: input.source })
            ? 'source'
            : stableDigest(was.schema) !== stableDigest(input.schema)
              ? 'schema'
              : was.required !== input.required
                ? 'required'
                : undefined;

        return change ? [{ name: input.name, change }] : [];
      }
    );

    for (const input of old.inputs) {
      if (!names.has(input.name)) {
        inputs.push({ name: input.name, change: 'removed' });
      }
    }

    const executor = !sameExecutor({
      left: old.executor,
      right: node.executor,
    });

    if (executor || inputs.length > 0) {
      changed.push({ node_id: key, executor, inputs });
    }
  }

  return {
    added: [...after.keys()].filter((key) => {
      return !before.has(key);
    }),
    removed: [...before.keys()].filter((key) => {
      return !after.has(key);
    }),
    changed,
  };
};
