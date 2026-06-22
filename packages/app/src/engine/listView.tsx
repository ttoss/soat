import * as React from 'react';

import { apiFetch } from '@/api/client';
import { useAuth } from '@/auth/authContext';
import { Button } from '@/components/ui/button';

import { CellValue } from './cellValue';
import type { RefResolver } from './crossRef';
import { useRefResolver } from './crossRef';
import { ALL_STATUSES, EmptyState, ListToolbar } from './listToolbar';
import { useNavigation } from './navigationContext';
import {
  buildListRequestUrl,
  deriveColumns,
  extractItems,
  extractRefFields,
  getListItemSchema,
  humanizeKey,
  refLinkContext,
  resolvableRefFields,
} from './specUtils';
import type { JsonObject, JsonValue, ModuleInfo, OpenApiSpec } from './types';

const PER_PAGE = 15;

const distinctStatuses = (items: JsonObject[]): string[] => {
  const set = new Set<string>();
  for (const item of items) {
    if (typeof item.status === 'string' && item.status) set.add(item.status);
  }
  return Array.from(set);
};

const matchesSearch = (item: JsonObject, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return Object.values(item).some((value) => {
    return (
      (typeof value === 'string' || typeof value === 'number') &&
      String(value).toLowerCase().includes(q)
    );
  });
};

const PaginationFooter = ({
  total,
  page,
  onPrev,
  onNext,
}: {
  total: number;
  page: number;
  onPrev: () => void;
  onNext: () => void;
}) => {
  const from = page * PER_PAGE + 1;
  const to = Math.min((page + 1) * PER_PAGE, total);
  const hasPrev = page > 0;
  const hasNext = to < total;

  return (
    <div className="flex items-center justify-between pt-2 text-sm text-muted-foreground">
      <span>{`${from}–${to} of ${total}`}</span>
      <div className="flex gap-1">
        <button
          onClick={onPrev}
          disabled={!hasPrev}
          aria-label="Previous page"
          className="rounded px-2 py-1 text-xs hover:bg-muted disabled:opacity-40"
        >
          {'‹'}
        </button>
        <button
          onClick={onNext}
          disabled={!hasNext}
          aria-label="Next page"
          className="rounded px-2 py-1 text-xs hover:bg-muted disabled:opacity-40"
        >
          {'›'}
        </button>
      </div>
    </div>
  );
};

const ItemTable = ({
  items,
  columns,
  hasDetail,
  onRowClick,
  refFields,
  pathParams,
  resolveRef,
}: {
  items: JsonObject[];
  columns: string[];
  hasDetail: boolean;
  onRowClick: (item: JsonObject) => void;
  refFields: Record<string, string>;
  pathParams: Record<string, string>;
  resolveRef?: RefResolver;
}) => {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            {columns.map((col) => {
              return (
                <th
                  key={col}
                  className="px-4 py-2 text-left font-medium text-muted-foreground"
                >
                  {humanizeKey(col)}
                </th>
              );
            })}
            {hasDetail && <th className="px-4 py-2" />}
          </tr>
        </thead>
        <tbody>
          {items.map((item, idx) => {
            const context = refLinkContext(item, pathParams);
            return (
              <tr
                key={String(item.id ?? idx)}
                className="border-b last:border-0 hover:bg-muted/30 transition-colors"
              >
                {columns.map((col) => {
                  return (
                    <td key={col} className="px-4 py-2">
                      <CellValue
                        colKey={col}
                        value={item[col] ?? (null as JsonValue)}
                        refResource={refFields[col]}
                        context={context}
                        resolveRef={resolveRef}
                        onOpen={
                          col === 'id' && hasDetail
                            ? () => {
                                return onRowClick(item);
                              }
                            : undefined
                        }
                      />
                    </td>
                  );
                })}
                {hasDetail && (
                  <td className="px-4 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        return onRowClick(item);
                      }}
                    >
                      {'View →'}
                    </Button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

type ListViewProps = {
  module: ModuleInfo;
  spec: OpenApiSpec;
  pathParams: Record<string, string>;
  modules?: ModuleInfo[];
};

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; items: JsonObject[] };

type LoadedListProps = {
  module: ModuleInfo;
  items: JsonObject[];
  onRowClick: (item: JsonObject) => void;
  onCreate: () => void;
  refFields: Record<string, string>;
  pathParams: Record<string, string>;
  resolveRef?: RefResolver;
};

const LoadedList = ({
  module,
  items,
  onRowClick,
  onCreate,
  refFields,
  pathParams,
  resolveRef,
}: LoadedListProps) => {
  const [page, setPage] = React.useState(0);
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<string>(ALL_STATUSES);

  const columns = deriveColumns(items);
  const statuses = distinctStatuses(items);
  const filtered = items.filter((item) => {
    const statusOk =
      statusFilter === ALL_STATUSES || item.status === statusFilter;
    return statusOk && matchesSearch(item, search);
  });
  const paginated = filtered.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  const totalPages = Math.ceil(filtered.length / PER_PAGE);
  const isFiltered = search.trim() !== '' || statusFilter !== ALL_STATUSES;

  return (
    <>
      {items.length > 0 && (
        <ListToolbar
          search={search}
          onSearch={(value) => {
            setSearch(value);
            setPage(0);
          }}
          label={module.label}
          statuses={statuses}
          selectedStatus={statusFilter}
          onSelectStatus={(status) => {
            setStatusFilter(status);
            setPage(0);
          }}
        />
      )}

      {filtered.length === 0 ? (
        <EmptyState
          label={module.label}
          filtered={isFiltered}
          canCreate={Boolean(module.createOp)}
          onCreate={onCreate}
        />
      ) : (
        <>
          <ItemTable
            items={paginated}
            columns={columns}
            hasDetail={Boolean(module.getOp)}
            onRowClick={onRowClick}
            refFields={refFields}
            pathParams={pathParams}
            resolveRef={resolveRef}
          />
          {filtered.length > PER_PAGE && (
            <PaginationFooter
              total={filtered.length}
              page={page}
              onPrev={() => {
                return setPage((p) => {
                  return Math.max(0, p - 1);
                });
              }}
              onNext={() => {
                return setPage((p) => {
                  return Math.min(totalPages - 1, p + 1);
                });
              }}
            />
          )}
        </>
      )}
    </>
  );
};

export const ListView = ({
  module,
  spec,
  pathParams,
  modules = [],
}: ListViewProps) => {
  const { state } = useAuth();
  const { navigate, activeProjectId } = useNavigation();
  const [viewState, setViewState] = React.useState<ViewState>({
    status: 'loading',
  });

  const token = state.status === 'authenticated' ? state.token : '';

  const refFields = React.useMemo(() => {
    const all = extractRefFields(getListItemSchema(module.listOp, spec), spec);
    return resolvableRefFields(all, modules);
  }, [module.listOp, spec, modules]);

  const resolveRef = useRefResolver(modules);

  const fetchData = React.useCallback(() => {
    if (!module.listOp || !token) return;
    // Scope the collection to the active project (when the op supports it).
    const url = buildListRequestUrl(module.listOp, pathParams, activeProjectId);
    apiFetch<unknown>({ url, token })
      .then((result) => {
        if (!result.ok) {
          setViewState({ status: 'error', message: result.error.message });
          return;
        }
        setViewState({ status: 'ok', items: extractItems(result.data) });
      })
      .catch((error: unknown) => {
        setViewState({ status: 'error', message: String(error) });
      });
  }, [module.listOp, pathParams, token, activeProjectId]);

  const load = React.useCallback(() => {
    setViewState({ status: 'loading' });
    fetchData();
  }, [fetchData]);

  React.useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRowClick = (item: JsonObject) => {
    if (!module.getOp) return;
    const id = String(item.id ?? '');
    if (!id) return;
    const idParam = module.getOp.pathTemplate.split('/').find((p) => {
      return p.startsWith('{') && !pathParams[p.slice(1, -1)];
    });
    const newParam = idParam ? idParam.slice(1, -1) : 'id';
    navigate({
      tag: module.tag,
      operationId: module.getOp.operation.operationId,
      pathParams: { ...pathParams, [newParam]: id },
      mode: 'detail',
    });
  };

  const handleCreate = () => {
    if (!module.createOp) return;
    navigate({
      tag: module.tag,
      operationId: module.createOp.operation.operationId,
      pathParams,
      mode: 'create',
    });
  };

  if (viewState.status === 'loading') {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        {'Loading…'}
      </div>
    );
  }

  if (viewState.status === 'error') {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {viewState.message}
      </div>
    );
  }

  const { items } = viewState;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{module.label}</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            {'Refresh'}
          </Button>
          {module.createOp && (
            <Button variant="gradient" size="sm" onClick={handleCreate}>
              {'Create'}
            </Button>
          )}
        </div>
      </div>

      <LoadedList
        module={module}
        items={items}
        onRowClick={handleRowClick}
        onCreate={handleCreate}
        refFields={refFields}
        pathParams={pathParams}
        resolveRef={modules.length > 0 ? resolveRef : undefined}
      />
    </div>
  );
};
