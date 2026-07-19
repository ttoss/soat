import { extractPathParams } from './specUtils';
import type { JsonObject, ModuleInfo, ModuleOp } from './types';

// The field on a task record that names the column it belongs to.
export const BOARD_COLUMN_FIELD = 'state';

export type BoardColumnState = {
  name: string;
  terminal: boolean;
};

const asRecordArray = (value: unknown): JsonObject[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JsonObject => {
    return typeof item === 'object' && item !== null && !Array.isArray(item);
  });
};

// The ordered column states of a workflow-shaped record: its `states` array,
// each entry contributing a `name` (and whether it is terminal). Returns an
// empty list for a record that carries no usable states.
export const boardColumnStates = (item: JsonObject): BoardColumnState[] => {
  return asRecordArray(item.states)
    .filter((state) => {
      return typeof state.name === 'string' && state.name !== '';
    })
    .map((state) => {
      return {
        name: String(state.name),
        terminal: state.terminal === true,
      };
    });
};

// A record is board-shaped when it exposes at least one named column state.
export const isBoardShaped = (item: JsonObject): boolean => {
  return boardColumnStates(item).length > 0;
};

// True when an operation accepts a query parameter of the given name.
const opAcceptsQueryParam = (op: ModuleOp, name: string): boolean => {
  return (op.operation.parameters ?? []).some((param) => {
    return param.name === name && param.in === 'query';
  });
};

// The trailing path parameter of a module's detail route — the id by which a
// companion collection filters (e.g. `/workflows/{workflow_id}` → `workflow_id`).
export const boardResourceParam = (module: ModuleInfo): string | null => {
  if (!module.getOp) return null;
  const params = extractPathParams(module.getOp.pathTemplate);
  return params.length > 0 ? params[params.length - 1] : null;
};

// The companion "cards" module for a board: another module whose collection can
// be filtered by this resource's id (its `<resource>_id` query parameter). For
// the Workflows module this resolves to the Tasks module. Generic — nothing is
// hard-coded to workflows or tasks.
export const findBoardCardsModule = (
  module: ModuleInfo,
  modules: ModuleInfo[]
): ModuleInfo | null => {
  const param = boardResourceParam(module);
  if (!param) return null;
  return (
    modules.find((candidate) => {
      return (
        candidate.tag !== module.tag &&
        candidate.listOp !== undefined &&
        opAcceptsQueryParam(candidate.listOp, param)
      );
    }) ?? null
  );
};

// Groups card records into columns keyed by their column-field value, preserving
// the workflow's declared state order. Cards whose state is not in the
// definition (e.g. a state removed after the card entered it) are collected
// under `extraColumns` so nothing is silently dropped from the board.
export const groupCardsByState = (args: {
  cards: JsonObject[];
  states: BoardColumnState[];
}): {
  columns: Array<{ state: BoardColumnState; cards: JsonObject[] }>;
  extraColumns: Array<{ state: BoardColumnState; cards: JsonObject[] }>;
} => {
  const known = new Set(
    args.states.map((state) => {
      return state.name;
    })
  );
  const buckets = new Map<string, JsonObject[]>();
  for (const card of args.cards) {
    const key =
      typeof card[BOARD_COLUMN_FIELD] === 'string'
        ? String(card[BOARD_COLUMN_FIELD])
        : '';
    const list = buckets.get(key) ?? [];
    list.push(card);
    buckets.set(key, list);
  }

  const columns = args.states.map((state) => {
    return { state, cards: buckets.get(state.name) ?? [] };
  });

  const extraColumns = Array.from(buckets.entries())
    .filter(([key]) => {
      return key !== '' && !known.has(key);
    })
    .map(([key, cards]) => {
      return { state: { name: key, terminal: false }, cards };
    });

  return { columns, extraColumns };
};
