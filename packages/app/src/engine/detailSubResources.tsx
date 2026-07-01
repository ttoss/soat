import * as React from 'react';

import { apiFetch } from '@/api/client';

import { buildUrl, extractItems } from './specUtils';
import { StatusBadge } from './statusBadge';
import type { JsonObject, JsonValue, ModuleInfo } from './types';

const SubCell = ({ colKey, value }: { colKey: string; value: JsonValue }) => {
  if (colKey === 'status' && typeof value === 'string' && value) {
    return <StatusBadge status={value} />;
  }
  if (colKey === 'error') {
    return value ? <StatusBadge error /> : <span>{'—'}</span>;
  }
  return <span>{String(value ?? '')}</span>;
};

type TabState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; items: JsonObject[] }
  | { status: 'error'; message: string };

const SubResourceTable = ({
  module,
  pathParams,
  token,
}: {
  module: ModuleInfo;
  pathParams: Record<string, string>;
  token: string;
}) => {
  const [tabState, setTabState] = React.useState<TabState>({
    status: 'loading',
  });

  React.useEffect(() => {
    if (!module.listOp || !token) return;
    const url = buildUrl(module.listOp.pathTemplate, pathParams);
    apiFetch<unknown>({ url, token })
      .then((result) => {
        if (!result.ok) {
          setTabState({ status: 'error', message: result.error.message });
          return;
        }
        setTabState({ status: 'ok', items: extractItems(result.data) });
      })
      .catch((error: unknown) => {
        setTabState({ status: 'error', message: String(error) });
      });
  }, [module.listOp, pathParams, token]);

  if (tabState.status === 'loading') {
    return (
      <div className="py-4 text-sm text-muted-foreground">{'Loading…'}</div>
    );
  }
  if (tabState.status === 'error') {
    return (
      <div className="py-4 text-sm text-destructive">{tabState.message}</div>
    );
  }
  if (tabState.status === 'idle' || tabState.items.length === 0) {
    return (
      <div className="py-4 text-sm text-muted-foreground">{'No items.'}</div>
    );
  }

  const cols = Object.keys(tabState.items[0]).slice(0, 4);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr>
          {cols.map((c) => {
            return (
              <th
                key={c}
                className="px-3 py-2 text-left text-xs text-muted-foreground"
              >
                {c}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {tabState.items.map((item, i) => {
          return (
            <tr key={String(item.id ?? i)}>
              {cols.map((c) => {
                return (
                  <td key={c} className="px-3 py-2 text-xs">
                    <SubCell colKey={c} value={item[c] ?? null} />
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

type SubResourceTabsProps = {
  subResources: ModuleInfo[];
  pathParams: Record<string, string>;
  token: string;
};

export const SubResourceTabs = ({
  subResources,
  pathParams,
  token,
}: SubResourceTabsProps) => {
  const [activeIdx, setActiveIdx] = React.useState(0);

  if (subResources.length === 0) return null;

  const active = subResources[activeIdx];

  return (
    <div className="mt-4">
      <div className="flex gap-1 border-b">
        {subResources.map((m, i) => {
          return (
            <button
              key={m.tag}
              onClick={() => {
                return setActiveIdx(i);
              }}
              className={[
                'px-3 py-2 text-sm font-medium transition-colors',
                i === activeIdx
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <div className="pt-3">
        <SubResourceTable
          key={active.tag}
          module={active}
          pathParams={pathParams}
          token={token}
        />
      </div>
    </div>
  );
};
