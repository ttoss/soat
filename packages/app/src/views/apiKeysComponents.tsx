import { CheckCircle, Copy, Key, Trash2, X } from 'lucide-react';
import type * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldEditor } from '@/engine/fieldEditor';
import type { getOpRequestSchema } from '@/engine/formHelpers';
import { formatValue, isSensitiveKey } from '@/engine/specUtils';
import type { JsonObject, ModuleInfo } from '@/engine/types';

export type ApiKeyItem = JsonObject & {
  id?: unknown;
  name?: unknown;
  key?: unknown;
  status?: unknown;
  scopes?: unknown;
  expires_at?: unknown;
  created_at?: unknown;
};

export type NewKeyBanner = {
  value: string;
};

const maskKey = (key: string): string => {
  if (key.length <= 4) return '••••';
  return `••••${key.slice(-4)}`;
};

const formatScopes = (scopes: unknown): string => {
  if (Array.isArray(scopes)) return (scopes as string[]).join(', ');
  if (scopes) return String(scopes);
  return '—';
};

const StatusBadge = ({ status }: { status: string }) => {
  const tone =
    status === 'active'
      ? 'success'
      : status === 'revoked'
        ? 'danger'
        : 'neutral';
  return (
    <Badge tone={tone} dot>
      {status}
    </Badge>
  );
};

type NewKeyBannerAlertProps = {
  banner: NewKeyBanner;
  copied: boolean;
  onCopy: () => void;
  onDismiss: () => void;
};

export const NewKeyBannerAlert = ({
  banner,
  copied,
  onCopy,
  onDismiss,
}: NewKeyBannerAlertProps): React.ReactElement => {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-orange-500/30 bg-orange-500/10 px-4 py-3">
      <Key className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium text-orange-700 dark:text-orange-400">
          {'Copy your API key — it will not be shown again.'}
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-auto rounded bg-black/10 px-2 py-1 font-mono text-xs dark:bg-white/10">
            {banner.value}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={onCopy}
            className="shrink-0"
          >
            {copied ? (
              <CheckCircle className="mr-1.5 h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="mr-1.5 h-3.5 w-3.5" />
            )}
            {copied ? 'Copied!' : 'Copy'}
          </Button>
        </div>
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
};

type KeyTableRowProps = {
  item: ApiKeyItem;
  deletingId: string | null;
  module: ModuleInfo;
  onRevoke: (id: string) => void;
};

export const KeyTableRow = ({
  item,
  deletingId,
  module,
  onRevoke,
}: KeyTableRowProps): React.ReactElement => {
  const id = String(item.id ?? '');
  const name = String(item.name ?? id);
  const rawKey = isSensitiveKey('key') ? '' : String(item.key ?? '');
  const keyDisplay = rawKey ? maskKey(rawKey) : '••••••••';
  const status = item.status ? String(item.status) : undefined;
  const scopes = formatScopes(item.scopes);
  const expiresAt = item.expires_at
    ? formatValue('expires_at', String(item.expires_at))
    : '—';

  return (
    <tr className="border-b last:border-0 transition-colors hover:bg-muted/30">
      <td className="px-4 py-3 font-medium">{name}</td>
      <td className="px-4 py-3">
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {keyDisplay}
        </code>
      </td>
      <td className="px-4 py-3">
        {status ? (
          <StatusBadge status={status} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-muted-foreground">{scopes}</td>
      <td className="px-4 py-3 text-muted-foreground">{expiresAt}</td>
      <td className="px-4 py-3 text-right">
        {module.deleteOp && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              onRevoke(id);
            }}
            disabled={deletingId === id}
            aria-label={`Revoke ${name}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </td>
    </tr>
  );
};

type CreatePanelProps = {
  createSchema: ReturnType<typeof getOpRequestSchema>;
  formData: Record<string, string>;
  formError: string | null;
  submitting: boolean;
  onFieldChange: (key: string, value: string) => void;
  onCreate: () => void;
  onClose: () => void;
};

export const CreatePanel = ({
  createSchema,
  formData,
  formError,
  submitting,
  onFieldChange,
  onCreate,
  onClose,
}: CreatePanelProps): React.ReactElement => {
  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{'New API Key'}</CardTitle>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {createSchema?.properties &&
          Object.entries(createSchema.properties).map(([key, fieldSchema]) => {
            return (
              <FieldEditor
                key={key}
                name={key}
                schema={fieldSchema}
                value={formData[key] ?? ''}
                onChange={(v) => {
                  onFieldChange(key, v);
                }}
                required={createSchema.required?.includes(key)}
              />
            );
          })}
        {!createSchema?.properties && (
          <FieldEditor
            name="name"
            schema={{ type: 'string', description: 'Key name' }}
            value={formData['name'] ?? ''}
            onChange={(v) => {
              onFieldChange('name', v);
            }}
            required
          />
        )}
        {formError && <p className="text-sm text-destructive">{formError}</p>}
        <div className="flex gap-2">
          <Button
            variant="gradient"
            size="sm"
            onClick={onCreate}
            disabled={submitting}
          >
            {submitting ? 'Creating…' : 'Create Key'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {'Cancel'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
