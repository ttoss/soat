import * as React from 'react';

import { apiFetch } from '@/api/client';
import { useAuth } from '@/auth/authContext';
import { Button } from '@/components/ui/button';

import { useNavigation } from './navigationContext';
import {
  actionLabel,
  buildUrl,
  formatValue,
  humanizeKey,
  isSensitiveKey,
} from './specUtils';
import type { JsonObject, JsonValue, ModuleInfo, OpenApiSpec } from './types';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; item: JsonObject };

const FieldRow = ({ label, value }: { label: string; value: JsonValue }) => {
  const displayValue = isSensitiveKey(label)
    ? '[hidden]'
    : formatValue(label, value);
  const isLong = typeof displayValue === 'string' && displayValue.length > 80;

  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 border-b py-3 last:border-0">
      <span className="text-sm font-medium text-muted-foreground">
        {humanizeKey(label)}
      </span>
      {isLong ? (
        <pre className="whitespace-pre-wrap break-all text-sm font-mono">
          {displayValue}
        </pre>
      ) : (
        <span className="text-sm">{displayValue}</span>
      )}
    </div>
  );
};

const DetailActions = ({
  module,
  pathParams,
}: {
  module: ModuleInfo;
  pathParams: Record<string, string>;
}) => {
  const { navigate } = useNavigation();
  return (module.actions ?? []).map((action) => {
    return (
      <Button
        key={action.operation.operationId}
        variant="secondary"
        size="sm"
        onClick={() => {
          return navigate({
            tag: module.tag,
            operationId: action.operation.operationId,
            pathParams,
            mode: 'action',
          });
        }}
      >
        {actionLabel(action)}
      </Button>
    );
  });
};

type DetailViewProps = {
  module: ModuleInfo;
  spec: OpenApiSpec;
  pathParams: Record<string, string>;
};

export const DetailView = ({
  module,
  spec: _spec,
  pathParams,
}: DetailViewProps) => {
  const { state } = useAuth();
  const { navigate } = useNavigation();
  const [viewState, setViewState] = React.useState<DetailState>({
    status: 'loading',
  });
  const [deleting, setDeleting] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const token = state.status === 'authenticated' ? state.token : '';

  const fetchData = React.useCallback(() => {
    if (!module.getOp || !token) return;
    const url = buildUrl(module.getOp.pathTemplate, pathParams);
    apiFetch<JsonObject>({ url, token })
      .then((result) => {
        if (!result.ok) {
          setViewState({ status: 'error', message: result.error.message });
          return;
        }
        setViewState({ status: 'ok', item: result.data });
      })
      .catch((error: unknown) => {
        setViewState({ status: 'error', message: String(error) });
      });
  }, [module.getOp, pathParams, token]);

  React.useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleEdit = () => {
    if (!module.updateOp) return;
    navigate({
      tag: module.tag,
      operationId: module.updateOp.operation.operationId,
      pathParams,
      mode: 'edit',
    });
  };

  const handleDelete = async () => {
    if (!module.deleteOp || !token) return;
    setDeleting(true);
    const url = buildUrl(module.deleteOp.pathTemplate, pathParams);
    const result = await apiFetch<unknown>({ url, method: 'DELETE', token });
    setDeleting(false);
    setConfirmDelete(false);
    if (result.ok) {
      navigate(null);
    } else {
      setViewState({ status: 'error', message: result.error.message });
    }
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

  const { item } = viewState;
  const fields = Object.keys(item).filter((k) => {
    return k !== 'id' || !item.id;
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{module.label}</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              return navigate(null);
            }}
          >
            {'← Back'}
          </Button>
          {module.updateOp && (
            <Button variant="outline" size="sm" onClick={handleEdit}>
              {'Edit'}
            </Button>
          )}
          <DetailActions module={module} pathParams={pathParams} />
          {module.deleteOp && !confirmDelete && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                return setConfirmDelete(true);
              }}
            >
              {'Delete'}
            </Button>
          )}
          {confirmDelete && (
            <>
              <span className="text-sm text-muted-foreground self-center">
                {'Are you sure?'}
              </span>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleting}
                onClick={handleDelete}
              >
                {deleting ? 'Deleting…' : 'Confirm delete'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  return setConfirmDelete(false);
                }}
              >
                {'Cancel'}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="rounded-md border">
        {fields.map((key) => {
          return <FieldRow key={key} label={key} value={item[key]} />;
        })}
      </div>
    </div>
  );
};
