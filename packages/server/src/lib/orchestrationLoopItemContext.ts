/**
 * A `loop` node's `item_tool_context`: per-item `tool_context` keys, each a
 * JSON Logic value over `{ <item_variable>: item, state }`, laid over the bag
 * every child inherits.
 */
import createDebug from 'debug';

import { DomainError, type ErrorCode } from '../errors';
import { evaluateLogic } from './jsonLogicMapping';
import { assertAssignableToolContextKeys } from './toolContext';

const log = createDebug('soat:orchestrations');

/** An item whose `item_tool_context` failed, so no child run started for it. */
export type LoopItemError = { index: number; code: ErrorCode; message: string };

export type LoopItemStart = {
  index: number;
  item: unknown;
  toolContext?: Record<string, string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/** Write-time check: a bag of assignable keys, or absent. */
export const assertValidItemToolContext = (value: unknown): void => {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new DomainError(
      'INVALID_TOOL_CONTEXT_KEY',
      'item_tool_context must be an object mapping tool_context keys to JSON Logic values.'
    );
  }
  assertAssignableToolContextKeys({
    field: 'item_tool_context',
    keys: Object.keys(value),
  });
};

const evaluateItemKeys = (args: {
  itemToolContext: Record<string, unknown>;
  scope: Record<string, unknown>;
}): Record<string, string | null> => {
  const evaluated: Record<string, string | null> = {};
  for (const [key, expression] of Object.entries(args.itemToolContext)) {
    const value = evaluateLogic(expression, args.scope);
    if (value !== null && value !== undefined && typeof value !== 'string') {
      throw new DomainError(
        'LOOP_ITEM_TOOL_CONTEXT_INVALID',
        `item_tool_context key '${key}' evaluated to ${JSON.stringify(value)}; a tool_context value must be a string, or null to drop the key.`,
        { key }
      );
    }
    evaluated[key] = value ?? null;
  }
  return evaluated;
};

/**
 * Inherited keys are replaced case-insensitively, since a key names a header;
 * a `null` value drops the key outright, so an item without a value never runs
 * under the parent's.
 */
const overlay = (args: {
  inherited?: Record<string, string>;
  evaluated: Record<string, string | null>;
}): Record<string, string> | undefined => {
  const replaced = new Set(
    Object.keys(args.evaluated).map((key) => {
      return key.toLowerCase();
    })
  );
  const bag: Record<string, string> = Object.fromEntries(
    Object.entries(args.inherited ?? {}).filter(([key]) => {
      return !replaced.has(key.toLowerCase());
    })
  );
  for (const [key, value] of Object.entries(args.evaluated)) {
    if (value !== null) bag[key] = value;
  }
  return Object.keys(bag).length === 0 ? undefined : bag;
};

const toItemError = (args: {
  index: number;
  error: unknown;
}): LoopItemError => {
  if (!(args.error instanceof DomainError)) throw args.error;
  return {
    index: args.index,
    code: args.error.code,
    message: args.error.message,
  };
};

/**
 * Each item's child bag, or the error that keeps it from starting. Evaluated
 * for every item before any child starts.
 */
export const resolveLoopItemStarts = (args: {
  items: unknown[];
  itemVariable: string;
  itemToolContext?: Record<string, unknown>;
  state: Record<string, unknown>;
  inherited?: Record<string, string>;
}): { starts: LoopItemStart[]; itemErrors: LoopItemError[] } => {
  const { items, itemVariable, itemToolContext, state, inherited } = args;
  if (!itemToolContext) {
    return {
      starts: items.map((item, index) => {
        return { index, item, toolContext: inherited };
      }),
      itemErrors: [],
    };
  }
  const starts: LoopItemStart[] = [];
  const itemErrors: LoopItemError[] = [];
  for (const [index, item] of items.entries()) {
    try {
      const evaluated = evaluateItemKeys({
        itemToolContext,
        scope: { [itemVariable]: item, state },
      });
      starts.push({
        index,
        item,
        toolContext: overlay({ inherited, evaluated }),
      });
    } catch (error) {
      itemErrors.push(toItemError({ index, error }));
    }
  }
  log(
    'resolveLoopItemStarts: items=%d failed=%d',
    items.length,
    itemErrors.length
  );
  return { starts, itemErrors };
};

/** The `item_errors` a parked `loop` node stored on its `child_run` action. */
export const readLoopItemErrors = (value: unknown): LoopItemError[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is LoopItemError => {
    return (
      isRecord(entry) &&
      typeof entry.index === 'number' &&
      typeof entry.code === 'string' &&
      typeof entry.message === 'string'
    );
  });
};
