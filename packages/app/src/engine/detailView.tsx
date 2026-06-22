import * as React from 'react';

import { apiFetch } from '@/api/client';
import { useAuth } from '@/auth/authContext';
import { Button } from '@/components/ui/button';

import { useRefNavigation } from './crossRef';
import { DetailSections } from './detailSections';
import { findSubResources, SubResourceTabs } from './detailSubResources';
import { useNavigation } from './navigationContext';
import {
  actionLabel,
  buildUrl,
  extractRefFields,
  getResponseItemSchema,
} from './specUtils';
import { StatusBadge } from './statusBadge';
import type { JsonObject, ModuleInfo, OpenApiSpec } from './types';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; item: JsonObject };

const getItemName = (item: JsonObject): string => {
  const name = item.name ?? item.title ?? item.id;
  return name ? String(name) : '';
};

const getHeadingKey = (item: JsonObject): string | undefined => {
  if (item.name !== undefined) return 'name';
  if (item.title !== undefined) return 'title';
  return undefined;
};

const hasStatus = (item: JsonObject): boolean => {
  return typeof item.status === 'string' && item.status !== '';
};

// Fields rendered in the body, excluding the id, the heading, and the status
// (the latter two are shown in the header).
const sectionFields = (item: JsonObject): string[] => {
  const headingKey = getHeadingKey(item);
  const skipStatus = hasStatus(item);
  return Object.keys(item).filter((k) => {
    if (k === 'id' && item.id) return false;
    if (k === headingKey) return false;
    if (k === 'status' && skipStatus) return false;
    return true;
  });
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

const DeleteButtons = ({
  deleting,
  onDelete,
  onCancel,
}: {
  deleting: boolean;
  onDelete: () => void;
  onCancel: () => void;
}) => {
  return (
    <>
      <span className="text-sm text-muted-foreground self-center">
        {'Are you sure?'}
      </span>
      <Button
        variant="destructive"
        size="sm"
        disabled={deleting}
        onClick={onDelete}
      >
        {deleting ? 'Deleting…' : 'Confirm delete'}
      </Button>
      <Button variant="outline" size="sm" onClick={onCancel}>
        {'Cancel'}
      </Button>
    </>
  );
};

type DetailToolbarProps = {
  module: ModuleInfo;
  pathParams: Record<string, string>;
  confirmDelete: boolean;
  deleting: boolean;
  onEdit: () => void;
  onAskDelete: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
};

const DetailToolbar = ({
  module,
  pathParams,
  confirmDelete,
  deleting,
  onEdit,
  onAskDelete,
  onDelete,
  onCancelDelete,
}: DetailToolbarProps) => {
  return (
    <div className="flex gap-2 flex-wrap justify-end">
      {module.updateOp && (
        <Button variant="outline" size="sm" onClick={onEdit}>
          {'Edit'}
        </Button>
      )}
      <DetailActions module={module} pathParams={pathParams} />
      {module.deleteOp && !confirmDelete && (
        <Button variant="destructive" size="sm" onClick={onAskDelete}>
          {'Delete'}
        </Button>
      )}
      {confirmDelete && (
        <DeleteButtons
          deleting={deleting}
          onDelete={onDelete}
          onCancel={onCancelDelete}
        />
      )}
    </div>
  );
};

type DetailViewProps = {
  module: ModuleInfo;
  spec: OpenApiSpec;
  pathParams: Record<string, string>;
  modules?: ModuleInfo[];
};

export const DetailView = ({
  module,
  spec,
  pathParams,
  modules = [],
}: DetailViewProps) => {
  const { state } = useAuth();
  const { navigate } = useNavigation();

  const refFields = React.useMemo(() => {
    return extractRefFields(getResponseItemSchema(module.getOp, spec), spec);
  }, [module.getOp, spec]);

  const handleRefClick = useRefNavigation(modules);
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
  const itemName = getItemName(item);
  const fields = sectionFields(item);
  const subResources = findSubResources(module, modules);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="self-start -ml-2 text-muted-foreground"
            onClick={() => {
              return navigate(null);
            }}
          >
            {`← ${module.label}`}
          </Button>
          {itemName && (
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">{itemName}</h1>
              {typeof item.status === 'string' && item.status && (
                <StatusBadge status={item.status} />
              )}
            </div>
          )}
        </div>
        <DetailToolbar
          module={module}
          pathParams={pathParams}
          confirmDelete={confirmDelete}
          deleting={deleting}
          onEdit={handleEdit}
          onAskDelete={() => {
            return setConfirmDelete(true);
          }}
          onDelete={handleDelete}
          onCancelDelete={() => {
            return setConfirmDelete(false);
          }}
        />
      </div>

      <DetailSections
        item={item}
        fields={fields}
        refFields={refFields}
        onRefClick={modules.length > 0 ? handleRefClick : undefined}
      />

      <SubResourceTabs
        subResources={subResources}
        pathParams={pathParams}
        token={token}
      />
    </div>
  );
};
