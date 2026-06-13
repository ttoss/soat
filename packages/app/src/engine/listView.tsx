import * as React from 'react';

import { apiFetch } from '@/api/client';
import { useAuth } from '@/auth/authContext';
import { Button } from '@/components/ui/button';

import { useNavigation } from './navigationContext';
import {
  buildUrl,
  extractItems,
  formatValue,
  humanizeKey,
  isSensitiveKey,
} from './specUtils';
import type { JsonObject, JsonValue, ModuleInfo, OpenApiSpec } from './types';

const HIDDEN_COLUMNS = new Set(['id']);
const MAX_COLUMNS = 6;

const deriveColumns = (items: JsonObject[]): string[] => {
  if (items.length === 0) return [];
  const keys = Object.keys(items[0]);
  return keys
    .filter((k) => {
      return !HIDDEN_COLUMNS.has(k) && !isSensitiveKey(k);
    })
    .slice(0, MAX_COLUMNS);
};

const CellValue = ({ colKey, value }: { colKey: string; value: JsonValue }) => {
  if (isSensitiveKey(colKey)) {
    return <span className="text-muted-foreground italic">{'[hidden]'}</span>;
  }
  const formatted = formatValue(colKey, value);
  if (formatted.length > 60) {
    return <span title={formatted}>{`${formatted.slice(0, 57)}…`}</span>;
  }
  return <span>{formatted}</span>;
};

type ListViewProps = {
  module: ModuleInfo;
  spec: OpenApiSpec;
  pathParams: Record<string, string>;
};

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; items: JsonObject[] };

export const ListView = ({
  module,
  spec: _spec,
  pathParams,
}: ListViewProps) => {
  const { state } = useAuth();
  const { navigate } = useNavigation();
  const [viewState, setViewState] = React.useState<ViewState>({
    status: 'loading',
  });

  const token = state.status === 'authenticated' ? state.token : '';

  const fetchData = React.useCallback(() => {
    if (!module.listOp || !token) return;
    const url = buildUrl(module.listOp.pathTemplate, pathParams);
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
  }, [module.listOp, pathParams, token]);

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
  const columns = deriveColumns(items);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{module.label}</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            {'Refresh'}
          </Button>
          {module.createOp && (
            <Button size="sm" onClick={handleCreate}>
              {'Create'}
            </Button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">
          {'No items found.'}
        </p>
      ) : (
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
                {module.getOp && <th className="px-4 py-2" />}
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => {
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
                          />
                        </td>
                      );
                    })}
                    {module.getOp && (
                      <td className="px-4 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            return handleRowClick(item);
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
      )}
    </div>
  );
};
