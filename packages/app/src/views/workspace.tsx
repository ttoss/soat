import * as React from 'react';

import { apiFetch } from '@/api/client';
import { useAuth } from '@/auth/authContext';
import { Button } from '@/components/ui/button';
import { EngineView } from '@/engine/engineView';
import { useNavigation } from '@/engine/navigationContext';
import { useSpec } from '@/engine/specContext';
import type { JsonObject, ModuleInfo } from '@/engine/types';

type Project = { id: string; name: string };

const extractProjects = (data: unknown): Project[] => {
  const list = Array.isArray(data) ? data : [];
  return list
    .filter((item): item is JsonObject => {
      return typeof item === 'object' && item !== null && !Array.isArray(item);
    })
    .map((item) => {
      return {
        id: String(item.id ?? ''),
        name: String(item.name ?? item.id ?? ''),
      };
    });
};

const useProjects = (token: string) => {
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!token) return;
    apiFetch<unknown>({ url: '/api/v1/projects', token })
      .then((result) => {
        if (result.ok) setProjects(extractProjects(result.data));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [token]);

  return { projects, loading };
};

const NavSection = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => {
  return (
    <div className="flex flex-col gap-1">
      <p className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
};

const NavItem = ({
  label,
  active,
  onClick,
  indent,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  indent?: boolean;
}) => {
  return (
    <button
      onClick={onClick}
      className={[
        'w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors',
        indent ? 'pl-6' : '',
        active
          ? 'bg-primary text-primary-foreground dark:shadow-glow'
          : 'text-foreground hover:bg-muted',
      ].join(' ')}
    >
      {label}
    </button>
  );
};

const ADMIN_TAGS = new Set([
  'Users',
  'Policies',
  'Ai Providers',
  'AiProviders',
  'AI Providers',
]);

type NavModuleListProps = {
  modules: ModuleInfo[];
  activeTag: string | null;
  indent?: boolean;
  onSelect: (m: ModuleInfo) => void;
};

const NavModuleList = ({
  modules,
  activeTag,
  indent,
  onSelect,
}: NavModuleListProps) => {
  return modules.map((m) => {
    return (
      <NavItem
        key={m.tag}
        label={m.label}
        active={activeTag === m.tag}
        indent={indent}
        onClick={() => {
          return onSelect(m);
        }}
      />
    );
  });
};

const buildPathParams = (
  module: ModuleInfo,
  projectId: string | null
): Record<string, string> => {
  const pathParams: Record<string, string> = {};
  if (module.isProjectScoped && projectId) {
    pathParams.project_id = projectId;
  }
  return pathParams;
};

const LeftNav = ({
  projects,
  projectsLoading,
}: {
  projects: Project[];
  projectsLoading: boolean;
}) => {
  const { state, logout } = useAuth();
  const { modules, spec } = useSpec();
  const { view, activeProjectId, navigate, setProject } = useNavigation();
  const user = state.status === 'authenticated' ? state.user : null;

  const activeListTag = view?.mode === 'list' ? view.tag : null;

  const projectModules = React.useMemo(() => {
    return modules.filter((m) => {
      return m.isProjectScoped;
    });
  }, [modules]);

  const adminModules = React.useMemo(() => {
    return modules.filter((m) => {
      return (
        !m.isProjectScoped && m.tag !== 'Projects' && !ADMIN_TAGS.has(m.label)
      );
    });
  }, [modules]);

  const adminOnlyModules = React.useMemo(() => {
    return user?.role === 'admin'
      ? modules.filter((m) => {
          return (
            !m.isProjectScoped &&
            m.tag !== 'Projects' &&
            ADMIN_TAGS.has(m.label)
          );
        })
      : [];
  }, [modules, user]);

  const navigateToModule = React.useCallback(
    (m: ModuleInfo) => {
      if (!m.listOp) return;
      navigate({
        tag: m.tag,
        operationId: m.listOp.operation.operationId,
        pathParams: buildPathParams(m, activeProjectId),
        mode: 'list',
      });
    },
    [navigate, activeProjectId]
  );

  const navigateToProjects = React.useCallback(() => {
    if (!spec) return;
    const mod = modules.find((m) => {
      return m.tag === 'Projects';
    });
    if (!mod?.listOp) return;
    navigate({
      tag: 'Projects',
      operationId: mod.listOp.operation.operationId,
      pathParams: {},
      mode: 'list',
    });
  }, [spec, modules, navigate]);

  return (
    <nav className="flex h-full flex-col gap-4 overflow-y-auto py-4 px-2">
      <div className="px-3">
        <h1 className="w-fit bg-galaxy-gradient bg-clip-text text-lg font-bold tracking-heading text-transparent">
          {'SOAT'}
        </h1>
      </div>

      <NavSection title={'Projects'}>
        <NavItem
          label={'All Projects'}
          active={activeListTag === 'Projects'}
          onClick={navigateToProjects}
        />
        {projectsLoading && (
          <p className="px-3 text-xs text-muted-foreground">{'Loading…'}</p>
        )}
        {projects.map((p) => {
          return (
            <NavItem
              key={p.id}
              label={p.name}
              active={activeProjectId === p.id && !view}
              indent
              onClick={() => {
                return setProject(p.id);
              }}
            />
          );
        })}
      </NavSection>

      {activeProjectId && projectModules.length > 0 && (
        <NavSection title={'Project'}>
          <NavModuleList
            modules={projectModules}
            activeTag={activeListTag}
            indent
            onSelect={navigateToModule}
          />
        </NavSection>
      )}

      {adminModules.length > 0 && (
        <NavSection title={'Other'}>
          <NavModuleList
            modules={adminModules}
            activeTag={activeListTag}
            onSelect={navigateToModule}
          />
        </NavSection>
      )}

      {adminOnlyModules.length > 0 && (
        <NavSection title={'Admin'}>
          <NavModuleList
            modules={adminOnlyModules}
            activeTag={activeListTag}
            onSelect={navigateToModule}
          />
        </NavSection>
      )}

      <div className="mt-auto flex flex-col gap-1 border-t pt-4">
        <p className="px-3 text-xs text-muted-foreground">
          {user ? `${user.username} · ${user.role}` : ''}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={logout}
        >
          {'Sign out'}
        </Button>
      </div>
    </nav>
  );
};

const MainArea = () => {
  const { view, activeProjectId } = useNavigation();
  const { modules, spec, loading, error } = useSpec();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        {'Loading workspace…'}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-sm text-destructive">
        {`Failed to load spec: ${error}`}
      </div>
    );
  }

  if (view && spec) {
    return <EngineView descriptor={view} modules={modules} spec={spec} />;
  }

  if (activeProjectId) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
        <p className="text-lg font-medium text-foreground">
          {'Project selected'}
        </p>
        <p className="text-sm">{'Choose a module from the left navigation.'}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
      <p className="text-lg font-medium text-foreground">{'Welcome to SOAT'}</p>
      <p className="text-sm">
        {'Select a project or browse resources from the left navigation.'}
      </p>
    </div>
  );
};

export const Workspace = () => {
  const { state } = useAuth();
  const token = state.status === 'authenticated' ? state.token : '';
  const { projects, loading: projectsLoading } = useProjects(token);

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-56 shrink-0 border-r bg-muted/20">
        <LeftNav projects={projects} projectsLoading={projectsLoading} />
      </aside>
      <main className="flex-1 overflow-y-auto p-6">
        <MainArea />
      </main>
    </div>
  );
};
