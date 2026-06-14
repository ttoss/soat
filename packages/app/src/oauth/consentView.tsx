import * as React from 'react';

import { apiFetch } from '@/api/client';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

type CatalogAction = { action: string; description: string };
type CatalogModule = { module: string; actions: CatalogAction[] };
type ConsentInfo = {
  projects: { id: string; name: string }[];
  modules: CatalogModule[];
};
type ConsentResult = {
  project_id: string;
  scopes: string[];
  authorize_url?: string;
};

/** The original OAuth `/authorize` query string, carried through by the AS. */
const authorizeQuery = (): string => {
  return window.location.search.replace(/^\?/, '');
};

const ModuleGroup = ({
  module,
  selected,
  disabled,
  onToggleAction,
  onToggleModule,
}: {
  module: CatalogModule;
  selected: Set<string>;
  disabled: boolean;
  onToggleAction: (action: string, checked: boolean) => void;
  onToggleModule: (actions: string[], checked: boolean) => void;
}) => {
  const actions = module.actions.map((a) => {
    return a.action;
  });
  const checkedCount = actions.filter((a) => {
    return selected.has(a);
  }).length;
  const all = checkedCount === actions.length && actions.length > 0;
  const none = checkedCount === 0;

  const moduleRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (moduleRef.current) {
      moduleRef.current.indeterminate = !all && !none;
    }
  }, [all, none]);

  return (
    <fieldset className="rounded-md border p-3">
      <legend className="px-1">
        <label className="flex items-center gap-2 font-medium">
          <input
            ref={moduleRef}
            type="checkbox"
            checked={all}
            disabled={disabled}
            onChange={(e) => {
              return onToggleModule(actions, e.target.checked);
            }}
          />
          {module.module}
        </label>
      </legend>
      <div className="mt-2 grid gap-1">
        {module.actions.map((a) => {
          return (
            <label key={a.action} className="flex items-baseline gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.has(a.action)}
                disabled={disabled}
                onChange={(e) => {
                  return onToggleAction(a.action, e.target.checked);
                }}
              />
              <code>{a.action}</code>
              <span className="text-muted-foreground">{a.description}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
};

export const ConsentView = ({ token }: { token: string }) => {
  const [info, setInfo] = React.useState<ConsentInfo | null>(null);
  const [projectId, setProjectId] = React.useState('');
  const [grantAll, setGrantAll] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    apiFetch<ConsentInfo>({ url: '/api/v1/oauth/consent-info', token }).then(
      (res) => {
        if (res.ok) setInfo(res.data);
        else setError(res.error.message);
      }
    );
  }, [token]);

  const toggleAction = (action: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(action);
      else next.delete(action);
      return next;
    });
  };

  const toggleModule = (actions: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const a of actions) {
        if (checked) next.add(a);
        else next.delete(a);
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!projectId) {
      setError('Select a project.');
      return;
    }
    const selection = grantAll
      ? { kind: 'all' as const }
      : { kind: 'actions' as const, actions: [...selected] };
    if (!grantAll && selected.size === 0) {
      setError('Select at least one permission, or grant all.');
      return;
    }

    setSubmitting(true);
    const res = await apiFetch<ConsentResult>({
      url: '/api/v1/oauth/consent',
      method: 'POST',
      token,
      body: {
        project_id: projectId,
        selection,
        authorize_query: authorizeQuery(),
      },
    });
    setSubmitting(false);

    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    if (res.data.authorize_url) {
      // Hand control back to the authorization server (carries the cookie).
      window.location.assign(res.data.authorize_url);
    } else {
      setError('Permissions granted, but no authorization request was found.');
    }
  };

  if (!info) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">
          {error || 'Loading consent…'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-background p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-2xl">{'Authorize MCP access'}</CardTitle>
          <CardDescription>
            {'Choose a project and the permissions to grant.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="grid gap-4">
            <label className="grid gap-1">
              <span className="font-medium">{'Project'}</span>
              <select
                required
                value={projectId}
                onChange={(e) => {
                  return setProjectId(e.target.value);
                }}
                className="rounded-md border bg-background p-2"
              >
                <option value="" disabled>
                  {'Select a project…'}
                </option>
                {info.projects.map((p) => {
                  return (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.id})
                    </option>
                  );
                })}
              </select>
            </label>

            <label className="flex items-center gap-2 rounded-md bg-muted p-3 font-medium">
              <input
                type="checkbox"
                checked={grantAll}
                onChange={(e) => {
                  return setGrantAll(e.target.checked);
                }}
              />
              {'Grant all permissions for the selected project'}
            </label>

            <div className="grid gap-2">
              {info.modules.map((m) => {
                return (
                  <ModuleGroup
                    key={m.module}
                    module={m}
                    selected={selected}
                    disabled={grantAll}
                    onToggleAction={toggleAction}
                    onToggleModule={toggleModule}
                  />
                );
              })}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" disabled={submitting}>
              {submitting ? 'Authorizing…' : 'Authorize'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
