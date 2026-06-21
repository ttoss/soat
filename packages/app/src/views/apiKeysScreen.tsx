import { Key, Plus, RefreshCw } from 'lucide-react';
import * as React from 'react';

import { apiFetch } from '@/api/client';
import { useAuth } from '@/auth/authContext';
import { Button } from '@/components/ui/button';
import {
  buildRequestBody,
  getOpRequestSchema,
  initFormData,
} from '@/engine/formHelpers';
import { useNavigation } from '@/engine/navigationContext';
import { buildUrl, extractItems } from '@/engine/specUtils';
import type { JsonObject, ModuleInfo, OpenApiSpec } from '@/engine/types';

import {
  type ApiKeyItem,
  CreatePanel,
  KeyTableRow,
  type NewKeyBanner,
  NewKeyBannerAlert,
} from './apiKeysComponents';

type ApiKeysScreenProps = {
  module: ModuleInfo;
  spec: OpenApiSpec;
  pathParams: Record<string, string>;
};

const useApiKeysState = ({
  module,
  spec,
  pathParams,
  token,
}: {
  module: ModuleInfo;
  spec: OpenApiSpec;
  pathParams: Record<string, string>;
  token: string;
}) => {
  const [items, setItems] = React.useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [newKeyBanner, setNewKeyBanner] = React.useState<NewKeyBanner | null>(
    null
  );
  const [showCreatePanel, setShowCreatePanel] = React.useState(false);
  const [formData, setFormData] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const listUrl = module.listOp
    ? buildUrl(module.listOp.pathTemplate, pathParams)
    : null;

  const fetchKeys = React.useCallback(() => {
    if (!listUrl) return;
    apiFetch<unknown>({ url: listUrl, token })
      .then((result) => {
        if (result.ok) {
          setItems(extractItems(result.data) as ApiKeyItem[]);
        } else {
          setError(result.error.message);
        }
      })
      .finally(() => {
        setLoading(false);
      });
  }, [listUrl, token]);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    fetchKeys();
  }, [fetchKeys]);

  React.useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const createSchema = getOpRequestSchema(module.createOp, spec);

  const openCreatePanel = () => {
    setFormData(initFormData(createSchema, {}));
    setFormError(null);
    setShowCreatePanel(true);
  };

  const handleFieldChange = (key: string, value: string) => {
    setFormData((prev) => {
      return { ...prev, [key]: value };
    });
  };

  const handleCreate = async () => {
    if (!module.createOp) return;
    const result = buildRequestBody(formData, createSchema);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const res = await apiFetch<JsonObject>({
      url: buildUrl(module.createOp.pathTemplate, pathParams),
      method: 'POST',
      body: result.body,
      token,
    });
    setSubmitting(false);
    if (!res.ok) {
      setFormError(res.error.message);
      return;
    }
    const rawKey =
      res.data && typeof res.data === 'object'
        ? String((res.data as JsonObject).key ?? '')
        : '';
    if (rawKey) setNewKeyBanner({ value: rawKey });
    setShowCreatePanel(false);
    fetchKeys();
  };

  const handleRevoke = async (id: string) => {
    if (!module.deleteOp) return;
    setDeletingId(id);
    const firstParam = Object.keys(pathParams)[0] ?? 'key_id';
    await apiFetch({
      url: buildUrl(module.deleteOp.pathTemplate, {
        ...pathParams,
        [firstParam]: id,
      }),
      method: 'DELETE',
      token,
    });
    setDeletingId(null);
    fetchKeys();
  };

  const handleCopy = () => {
    if (!newKeyBanner) return;
    navigator.clipboard.writeText(newKeyBanner.value).then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    });
  };

  return {
    items,
    loading,
    error,
    newKeyBanner,
    setNewKeyBanner,
    showCreatePanel,
    setShowCreatePanel,
    formData,
    formError,
    submitting,
    deletingId,
    copied,
    createSchema,
    load,
    openCreatePanel,
    handleFieldChange,
    handleCreate,
    handleRevoke,
    handleCopy,
  };
};

export const ApiKeysScreen = ({
  module,
  spec,
  pathParams,
}: ApiKeysScreenProps): React.ReactElement => {
  const { state } = useAuth();
  const token = state.status === 'authenticated' ? state.token : '';
  useNavigation();

  const {
    items,
    loading,
    error,
    newKeyBanner,
    setNewKeyBanner,
    showCreatePanel,
    setShowCreatePanel,
    formData,
    formError,
    submitting,
    deletingId,
    copied,
    createSchema,
    load,
    openCreatePanel,
    handleFieldChange,
    handleCreate,
    handleRevoke,
    handleCopy,
  } = useApiKeysState({ module, spec, pathParams, token });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-heading text-xl font-semibold tracking-tight">
            {'API Keys'}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {'Manage project API keys and access credentials.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={load}
            aria-label="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          {module.createOp && (
            <Button variant="gradient" size="sm" onClick={openCreatePanel}>
              <Plus className="mr-1.5 h-4 w-4" />
              {'Create Key'}
            </Button>
          )}
        </div>
      </div>

      {newKeyBanner && (
        <NewKeyBannerAlert
          banner={newKeyBanner}
          copied={copied}
          onCopy={handleCopy}
          onDismiss={() => {
            setNewKeyBanner(null);
          }}
        />
      )}

      {showCreatePanel && (
        <CreatePanel
          createSchema={createSchema}
          formData={formData}
          formError={formError}
          submitting={submitting}
          onFieldChange={handleFieldChange}
          onCreate={handleCreate}
          onClose={() => {
            setShowCreatePanel(false);
          }}
        />
      )}

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {'Loading keys…'}
        </p>
      ) : items.length === 0 && !error ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-muted-foreground">
          <Key className="h-10 w-10 opacity-30" />
          <p className="text-sm">{'No API keys yet.'}</p>
          {module.createOp && (
            <Button variant="outline" size="sm" onClick={openCreatePanel}>
              {'Create your first key'}
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-3">{'Name'}</th>
                <th className="px-4 py-3">{'Key'}</th>
                <th className="px-4 py-3">{'Status'}</th>
                <th className="px-4 py-3">{'Scopes'}</th>
                <th className="px-4 py-3">{'Expires'}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const id = String(item.id ?? '');
                return (
                  <KeyTableRow
                    key={id}
                    item={item}
                    deletingId={deletingId}
                    module={module}
                    onRevoke={handleRevoke}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
