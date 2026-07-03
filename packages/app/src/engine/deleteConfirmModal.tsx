import * as React from 'react';

import { apiFetch } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

import { FieldEditor } from './fieldEditor';
import { buildUrl, humanizeKey, withQuery } from './specUtils';
import type { ModuleInfo, ModuleOp, OpenApiParameter } from './types';

// The query-string parameters declared on the delete operation, e.g. `force`
// on `deleteAgent` — read straight from the OpenAPI spec, no per-module
// plumbing needed.
const getQueryParameters = (op: ModuleOp | undefined): OpenApiParameter[] => {
  return (op?.operation.parameters ?? []).filter((param) => {
    return param.in === 'query';
  });
};

const initQueryValues = (
  params: OpenApiParameter[]
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const param of params) {
    const defaultValue = param.schema?.default;
    result[param.name] = defaultValue !== undefined ? String(defaultValue) : '';
  }
  return result;
};

// Booleans omit the query param entirely unless checked (force=false is the
// server's default anyway); other types are dropped when left blank.
const buildDeleteQuery = (
  params: OpenApiParameter[],
  values: Record<string, string>
): Record<string, string | undefined> => {
  const query: Record<string, string | undefined> = {};
  for (const param of params) {
    const value = values[param.name];
    if (param.schema?.type === 'boolean') {
      if (value === 'true') query[param.name] = 'true';
    } else if (value) {
      query[param.name] = value;
    }
  }
  return query;
};

type DeleteConfirmModalProps = {
  module: ModuleInfo;
  pathParams: Record<string, string>;
  itemName: string;
  token: string;
  onDeleted: () => void;
  onCancel: () => void;
};

export const DeleteConfirmModal = ({
  module,
  pathParams,
  itemName,
  token,
  onDeleted,
  onCancel,
}: DeleteConfirmModalProps): React.ReactElement | null => {
  const deleteOp = module.deleteOp;
  const queryParams = React.useMemo(() => {
    return getQueryParameters(deleteOp);
  }, [deleteOp]);
  const [values, setValues] = React.useState<Record<string, string>>(() => {
    return initQueryValues(queryParams);
  });
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!deleteOp) return null;

  const forceParam = queryParams.find((param) => {
    return param.schema?.type === 'boolean';
  });
  const showForceHint = Boolean(
    error && forceParam && values[forceParam.name] !== 'true'
  );

  const handleConfirm = async () => {
    setDeleting(true);
    setError(null);
    const url = withQuery(
      buildUrl(deleteOp.pathTemplate, pathParams),
      buildDeleteQuery(queryParams, values)
    );
    const result = await apiFetch<unknown>({ url, method: 'DELETE', token });
    setDeleting(false);
    if (result.ok) {
      onDeleted();
      return;
    }
    setError(result.error.message);
  };

  return (
    <Dialog title="Confirm delete" onClose={onCancel}>
      <p className="text-sm text-muted-foreground">
        {`Are you sure you want to delete ${
          itemName ? `"${itemName}"` : 'this item'
        }? This action cannot be undone.`}
      </p>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <p>{error}</p>
          {showForceHint && (
            <p className="mt-1">
              {`If this resource has dependents, enable "${humanizeKey(
                forceParam!.name
              )}" below and try again.`}
            </p>
          )}
        </div>
      )}

      {queryParams.length > 0 && (
        <div className="flex flex-col gap-4">
          {queryParams.map((param) => {
            return (
              <div key={param.name} className="flex flex-col gap-1">
                <FieldEditor
                  name={param.name}
                  schema={param.schema ?? {}}
                  value={values[param.name] ?? ''}
                  onChange={(v) => {
                    return setValues((prev) => {
                      return { ...prev, [param.name]: v };
                    });
                  }}
                  required={param.required}
                />
                {param.description && (
                  <p className="text-xs text-muted-foreground">
                    {param.description}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <Button
          variant="destructive"
          disabled={deleting}
          onClick={handleConfirm}
        >
          {deleting ? 'Deleting…' : 'Confirm delete'}
        </Button>
        <Button variant="outline" disabled={deleting} onClick={onCancel}>
          {'Cancel'}
        </Button>
      </div>
    </Dialog>
  );
};
