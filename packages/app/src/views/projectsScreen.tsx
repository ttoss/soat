import { FolderOpen, Plus, RefreshCw } from 'lucide-react';
import * as React from 'react';

import { apiFetch } from '@/api/client';
import { useAuth } from '@/auth/authContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useNavigation } from '@/engine/navigationContext';
import { buildUrl, extractItems, formatValue } from '@/engine/specUtils';
import type { JsonObject, ModuleInfo, OpenApiSpec } from '@/engine/types';

type ProjectsScreenProps = {
  module: ModuleInfo;
  spec: OpenApiSpec;
  pathParams: Record<string, string>;
};

type ProjectCardFooterProps = {
  id: string;
  isActive: boolean;
  hasGetOp: boolean;
  onSelect: (id: string) => void;
  onView: (id: string) => void;
};

const ProjectCardFooter = ({
  id,
  isActive,
  hasGetOp,
  onSelect,
  onView,
}: ProjectCardFooterProps): React.ReactElement => {
  return (
    <CardFooter className="gap-2 pt-2">
      <Button
        variant={isActive ? 'secondary' : 'outline'}
        size="sm"
        className="flex-1"
        onClick={() => {
          onSelect(id);
        }}
        disabled={isActive}
      >
        {isActive ? 'Selected' : 'Select'}
      </Button>
      {hasGetOp && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onView(id);
          }}
        >
          {'View →'}
        </Button>
      )}
    </CardFooter>
  );
};

type ProjectCardProps = {
  item: JsonObject;
  isActive: boolean;
  module: ModuleInfo;
  onSelect: (id: string) => void;
  onView: (id: string) => void;
};

const ProjectCard = ({
  item,
  isActive,
  module,
  onSelect,
  onView,
}: ProjectCardProps): React.ReactElement => {
  const id = String(item.id ?? '');
  const name = String(item.name ?? item.id ?? 'Untitled');
  const description = item.description ? String(item.description) : undefined;
  const createdAt = item.created_at
    ? formatValue('created_at', item.created_at)
    : undefined;

  return (
    <Card
      className={
        isActive
          ? 'border-primary/40 shadow-sm'
          : 'transition-shadow hover:shadow-sm'
      }
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base font-semibold leading-snug">
            {name}
          </CardTitle>
          {isActive && (
            <Badge tone="primary" dot className="shrink-0">
              {'Active'}
            </Badge>
          )}
        </div>
        {description && (
          <CardDescription className="line-clamp-2 text-xs">
            {description}
          </CardDescription>
        )}
      </CardHeader>
      {createdAt && (
        <CardContent className="pb-2 pt-0">
          <p className="text-xs text-muted-foreground">
            {`Created ${createdAt}`}
          </p>
        </CardContent>
      )}
      <ProjectCardFooter
        id={id}
        isActive={isActive}
        hasGetOp={Boolean(module.getOp)}
        onSelect={onSelect}
        onView={onView}
      />
    </Card>
  );
};

export const ProjectsScreen = ({
  module,
}: ProjectsScreenProps): React.ReactElement => {
  const { state } = useAuth();
  const token = state.status === 'authenticated' ? state.token : '';
  const { activeProjectId, navigate, setProject } = useNavigation();

  const [items, setItems] = React.useState<JsonObject[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const fetchProjects = React.useCallback(() => {
    if (!module.listOp) return;
    apiFetch<unknown>({ url: buildUrl(module.listOp.pathTemplate, {}), token })
      .then((result) => {
        if (result.ok) {
          setItems(extractItems(result.data));
        } else {
          setError(result.error.message);
        }
      })
      .finally(() => {
        setLoading(false);
      });
  }, [module, token]);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    fetchProjects();
  }, [fetchProjects]);

  React.useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleCreate = () => {
    if (!module.createOp) return;
    navigate({
      tag: module.tag,
      operationId: module.createOp.operation.operationId,
      pathParams: {},
      mode: 'create',
    });
  };

  const handleView = (id: string) => {
    if (!module.getOp) return;
    navigate({
      tag: module.tag,
      operationId: module.getOp.operation.operationId,
      pathParams: { project_id: id },
      mode: 'detail',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        {'Loading projects…'}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-heading text-xl font-semibold tracking-tight">
            {'Projects'}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {'Select or manage your SOAT projects.'}
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
            <Button variant="gradient" size="sm" onClick={handleCreate}>
              <Plus className="mr-1.5 h-4 w-4" />
              {'New Project'}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {items.length === 0 && !error ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed py-20 text-muted-foreground">
          <FolderOpen className="h-10 w-10 opacity-30" />
          <p className="text-sm">{'No projects yet.'}</p>
          {module.createOp && (
            <Button variant="outline" size="sm" onClick={handleCreate}>
              {'Create your first project'}
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => {
            const id = String(item.id ?? '');
            return (
              <ProjectCard
                key={id}
                item={item}
                isActive={id === activeProjectId}
                module={module}
                onSelect={setProject}
                onView={handleView}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};
