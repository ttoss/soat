import * as React from 'react';

import { apiFetch } from '@/api/client';
import { useAuth } from '@/auth/authContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

import {
  type BoardColumnState,
  boardColumnStates,
  boardResourceParam,
  findBoardCardsModule,
  groupCardsByState,
} from './boardUtils';
import { useNavigation } from './navigationContext';
import {
  buildUrl,
  extractItems,
  extractPathParams,
  withQuery,
} from './specUtils';
import { StatusBadge } from './statusBadge';
import type { JsonObject, ModuleInfo, OpenApiSpec } from './types';

type BoardViewProps = {
  module: ModuleInfo;
  spec: OpenApiSpec;
  pathParams: Record<string, string>;
  modules?: ModuleInfo[];
};

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; workflow: JsonObject; cards: JsonObject[] };

const cardTitle = (card: JsonObject): string => {
  const value = card.title ?? card.name ?? card.id;
  return value === undefined || value === null ? '' : String(value);
};

const BoardCard = ({
  card,
  onOpen,
}: {
  card: JsonObject;
  onOpen: (card: JsonObject) => void;
}) => {
  const assignee = typeof card.assignee === 'string' ? card.assignee : '';
  return (
    <Card
      interactive
      className="p-3 flex flex-col gap-2"
      role="button"
      tabIndex={0}
      onClick={() => {
        return onOpen(card);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(card);
        }
      }}
    >
      <span className="text-sm font-medium leading-snug break-words">
        {cardTitle(card) || '(untitled)'}
      </span>
      <div className="flex items-center gap-2 flex-wrap">
        {typeof card.status === 'string' && card.status && (
          <StatusBadge status={card.status} />
        )}
        {assignee && <Badge tone="neutral">{assignee}</Badge>}
      </div>
    </Card>
  );
};

const BoardColumn = ({
  state,
  cards,
  onOpen,
}: {
  state: BoardColumnState;
  cards: JsonObject[];
  onOpen: (card: JsonObject) => void;
}) => {
  return (
    <div className="flex w-72 shrink-0 flex-col gap-3 rounded-lg bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{state.name}</h3>
          {state.terminal && <Badge tone="neutral">{'terminal'}</Badge>}
        </div>
        <span className="text-xs text-muted-foreground">{cards.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {cards.length === 0 ? (
          <p className="text-xs text-muted-foreground italic px-1 py-2">
            {'No tasks'}
          </p>
        ) : (
          cards.map((card, idx) => {
            return (
              <BoardCard
                key={String(card.id ?? idx)}
                card={card}
                onOpen={onOpen}
              />
            );
          })
        )}
      </div>
    </div>
  );
};

// The board's data-loading seam: fetches the workflow record and its cards in
// parallel, exposing the combined state and a `reload`. Kept as a hook so the
// component body stays a thin render.
const useBoardData = (args: {
  module: ModuleInfo;
  pathParams: Record<string, string>;
  cardsModule: ModuleInfo | null;
  token: string;
  activeProjectId: string | null;
}): { loadState: LoadState; reload: () => void } => {
  const { module, pathParams, cardsModule, token, activeProjectId } = args;
  const [loadState, setLoadState] = React.useState<LoadState>({
    status: 'loading',
  });
  const resourceParam = boardResourceParam(module);
  const resourceId = resourceParam ? pathParams[resourceParam] : undefined;

  const fetchBoard = React.useCallback(() => {
    if (!module.getOp || !token) return;
    const cardsListOp = cardsModule?.listOp;
    const cardsUrl =
      cardsListOp && resourceParam && resourceId
        ? withQuery(buildUrl(cardsListOp.pathTemplate, pathParams), {
            [resourceParam]: resourceId,
            project_id: activeProjectId,
          })
        : null;

    const workflowReq = apiFetch<JsonObject>({
      url: buildUrl(module.getOp.pathTemplate, pathParams),
      token,
    });
    const cardsReq = cardsUrl
      ? apiFetch<unknown>({ url: cardsUrl, token })
      : Promise.resolve(null);

    Promise.all([workflowReq, cardsReq])
      .then(([workflowRes, cardsRes]) => {
        if (!workflowRes.ok) {
          setLoadState({ status: 'error', message: workflowRes.error.message });
          return;
        }
        if (cardsRes && !cardsRes.ok) {
          setLoadState({ status: 'error', message: cardsRes.error.message });
          return;
        }
        setLoadState({
          status: 'ok',
          workflow: workflowRes.data,
          cards: cardsRes ? extractItems(cardsRes.data) : [],
        });
      })
      .catch((error: unknown) => {
        setLoadState({ status: 'error', message: String(error) });
      });
  }, [
    module.getOp,
    pathParams,
    token,
    cardsModule,
    resourceParam,
    resourceId,
    activeProjectId,
  ]);

  const reload = React.useCallback(() => {
    setLoadState({ status: 'loading' });
    fetchBoard();
  }, [fetchBoard]);

  React.useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  return { loadState, reload };
};

const BoardColumns = ({
  columns,
  onOpen,
}: {
  columns: Array<{ state: BoardColumnState; cards: JsonObject[] }>;
  onOpen: (card: JsonObject) => void;
}) => {
  return (
    <div
      className="flex gap-4 overflow-x-auto pb-4"
      data-testid="board-columns"
    >
      {columns.map((column) => {
        return (
          <BoardColumn
            key={column.state.name}
            state={column.state}
            cards={column.cards}
            onOpen={onOpen}
          />
        );
      })}
    </div>
  );
};

const BoardLoaded = ({
  workflow,
  cards,
  moduleLabel,
  hasCardsModule,
  onOpenCard,
  onBack,
  onRefresh,
}: {
  workflow: JsonObject;
  cards: JsonObject[];
  moduleLabel: string;
  hasCardsModule: boolean;
  onOpenCard: (card: JsonObject) => void;
  onBack: () => void;
  onRefresh: () => void;
}) => {
  const states = boardColumnStates(workflow);
  const { columns, extraColumns } = groupCardsByState({ cards, states });
  const workflowName =
    typeof workflow.name === 'string'
      ? workflow.name
      : String(workflow.id ?? '');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="self-start -ml-2 text-muted-foreground"
            onClick={onBack}
          >
            {`← ${workflowName || moduleLabel}`}
          </Button>
          <h1 className="text-2xl font-bold">{`${workflowName} board`}</h1>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          {'Refresh'}
        </Button>
      </div>

      {states.length === 0 && (
        <div className="rounded-md border p-4 text-sm text-muted-foreground">
          {'This resource has no states to render as a board.'}
        </div>
      )}
      {states.length > 0 && !hasCardsModule && (
        <div className="rounded-md border p-4 text-sm text-muted-foreground">
          {'No task collection is available for this workflow.'}
        </div>
      )}
      {states.length > 0 && hasCardsModule && (
        <BoardColumns
          columns={[...columns, ...extraColumns]}
          onOpen={onOpenCard}
        />
      )}
    </div>
  );
};

export const BoardView = ({
  module,
  pathParams,
  modules = [],
}: BoardViewProps) => {
  const { state } = useAuth();
  const { navigate, activeProjectId } = useNavigation();
  const token = state.status === 'authenticated' ? state.token : '';
  const cardsModule = React.useMemo(() => {
    return findBoardCardsModule(module, modules);
  }, [module, modules]);

  const { loadState, reload } = useBoardData({
    module,
    pathParams,
    cardsModule,
    token,
    activeProjectId,
  });

  const openCard = (card: JsonObject) => {
    if (!cardsModule?.getOp) return;
    const id = String(card.id ?? '');
    if (!id) return;
    const params = extractPathParams(cardsModule.getOp.pathTemplate);
    const idParam = params[params.length - 1] ?? 'id';
    navigate({
      tag: cardsModule.tag,
      operationId: cardsModule.getOp.operation.operationId,
      pathParams: { [idParam]: id },
      mode: 'detail',
    });
  };

  const openDetail = () => {
    if (!module.getOp) return;
    navigate({
      tag: module.tag,
      operationId: module.getOp.operation.operationId,
      pathParams,
      mode: 'detail',
    });
  };

  if (loadState.status === 'loading') {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        {'Loading…'}
      </div>
    );
  }

  if (loadState.status === 'error') {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {loadState.message}
      </div>
    );
  }

  return (
    <BoardLoaded
      workflow={loadState.workflow}
      cards={loadState.cards}
      moduleLabel={module.label}
      hasCardsModule={cardsModule !== null}
      onOpenCard={openCard}
      onBack={openDetail}
      onRefresh={reload}
    />
  );
};
