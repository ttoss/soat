import {
  Cpu,
  FolderOpen,
  Key,
  LogOut,
  Settings,
  Shield,
  Users,
} from 'lucide-react';
import * as React from 'react';

import { apiFetch } from '@/api/client';
import { useAuth } from '@/auth/authContext';
import { GuideChat } from '@/chat/guideChat';
import { EngineView } from '@/engine/engineView';
import { useNavigation } from '@/engine/navigationContext';
import { useSpec } from '@/engine/specContext';
import type { JsonObject, ModuleInfo } from '@/engine/types';

import { ApiKeysScreen } from './apiKeysScreen';
import { IamScreen } from './iamScreen';
import type { Project } from './navComponents';
import {
  buildGroups,
  ModuleGroups,
  NavItem,
  ProjectPicker,
} from './navComponents';
import { ProjectsScreen } from './projectsScreen';

const API_KEY_TAGS = new Set(['Api Keys', 'API Keys']);
const IAM_TAGS = new Set([
  'Users',
  'Policies',
  'Ai Providers',
  'AiProviders',
  'AI Providers',
]);

const ADMIN_TAGS = new Set([
  'Users',
  'Policies',
  'Ai Providers',
  'AiProviders',
  'AI Providers',
]);

const ADMIN_ICONS: Record<string, React.ElementType> = {
  Users,
  Policies: Shield,
  'Ai Providers': Settings,
  AiProviders: Settings,
  'AI Providers': Settings,
  'Api Keys': Key,
  'API Keys': Key,
};

const buildPathParams = (
  module: ModuleInfo,
  projectId: string | null
): Record<string, string> => {
  if (module.isProjectScoped && projectId) {
    return { project_id: projectId };
  }
  return {};
};

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

// ─── LeftNav ──────────────────────────────────────────────────────────────────

const LeftNav = ({
  projects,
  projectsLoading,
}: {
  projects: Project[];
  projectsLoading: boolean;
}) => {
  const { state, logout } = useAuth();
  const { modules } = useSpec();
  const { view, activeProjectId, navigate, setProject } = useNavigation();
  const user = state.status === 'authenticated' ? state.user : null;

  const [openGroups, setOpenGroups] = React.useState<Set<string>>(() => {
    return new Set(['orchestration']);
  });

  const activeListTag = view?.mode === 'list' ? view.tag : null;

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

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

  const navModules = React.useMemo(() => {
    return modules.filter((m) => {
      return m.tag !== 'Projects' && !ADMIN_TAGS.has(m.label);
    });
  }, [modules]);

  const groups = React.useMemo(() => {
    return buildGroups(navModules);
  }, [navModules]);

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

  return (
    <nav className="flex h-full w-56 shrink-0 flex-col overflow-hidden border-r bg-muted/20">
      <div className="px-3.5 pb-3 pt-4">
        <h1 className="w-fit bg-galaxy-gradient bg-clip-text text-base font-bold tracking-heading text-transparent">
          {'SOAT'}
        </h1>
      </div>

      {(() => {
        const projectsModule = modules.find((m) => {
          return m.tag === 'Projects';
        });
        if (!projectsModule?.listOp) return null;
        const isProjectsActive = activeListTag === 'Projects';
        return (
          <NavItem
            label="Projects"
            Icon={FolderOpen}
            active={isProjectsActive}
            onClick={() => {
              navigate({
                tag: 'Projects',
                operationId: projectsModule.listOp!.operation.operationId,
                pathParams: {},
                mode: 'list',
              });
            }}
          />
        );
      })()}

      <ProjectPicker
        projects={projects}
        loading={projectsLoading}
        activeProjectId={activeProjectId}
        onSelect={setProject}
      />

      <ModuleGroups
        groups={groups}
        openGroups={openGroups}
        activeListTag={activeListTag}
        onToggle={toggleGroup}
        onSelect={navigateToModule}
      />

      {adminOnlyModules.length > 0 && (
        <div className="border-t py-1.5">
          <p className="mb-1 px-2.5 pt-1 text-[0.67rem] font-bold uppercase tracking-widest text-muted-foreground/60">
            {'Admin'}
          </p>
          {adminOnlyModules.map((m) => {
            const Icon = ADMIN_ICONS[m.label] ?? Settings;
            return (
              <NavItem
                key={m.tag}
                label={m.label}
                Icon={Icon}
                active={activeListTag === m.tag}
                onClick={() => {
                  return navigateToModule(m);
                }}
              />
            );
          })}
        </div>
      )}

      <div className="border-t px-2.5 py-2">
        {user && (
          <p className="mb-1.5 px-1 text-xs text-muted-foreground/70">
            {`${user.username} · ${user.role}`}
          </p>
        )}
        <button
          onClick={logout}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <LogOut className="h-3.5 w-3.5 shrink-0" />
          {'Sign out'}
        </button>
      </div>
    </nav>
  );
};

// ─── MainArea ─────────────────────────────────────────────────────────────────

type ViewDescriptor = NonNullable<ReturnType<typeof useNavigation>['view']>;
type SpecType = NonNullable<ReturnType<typeof useSpec>['spec']>;

const renderView = (
  view: ViewDescriptor,
  modules: ModuleInfo[],
  spec: SpecType
): React.ReactElement => {
  if (view.tag === 'Projects' && view.mode === 'list') {
    const projectsModule = modules.find((m) => {
      return m.tag === 'Projects';
    });
    if (projectsModule) {
      return (
        <ProjectsScreen
          module={projectsModule}
          spec={spec}
          pathParams={view.pathParams}
        />
      );
    }
  }

  if (API_KEY_TAGS.has(view.tag) && view.mode === 'list') {
    const keysModule = modules.find((m) => {
      return API_KEY_TAGS.has(m.tag);
    });
    if (keysModule) {
      return (
        <ApiKeysScreen
          module={keysModule}
          spec={spec}
          pathParams={view.pathParams}
        />
      );
    }
  }

  if (IAM_TAGS.has(view.tag) && view.mode === 'list') {
    return (
      <IamScreen
        key={view.tag}
        modules={modules}
        spec={spec}
        initialTag={view.tag}
      />
    );
  }

  return <EngineView descriptor={view} modules={modules} spec={spec} />;
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
    return renderView(view, modules, spec);
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
    <div className="flex flex-col items-center justify-center gap-6 py-16 text-muted-foreground">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-galaxy-gradient">
        <Cpu className="h-7 w-7 text-white" />
      </div>
      <div className="text-center">
        <p className="font-heading text-xl font-bold text-foreground">
          {'Welcome to SOAT'}
        </p>
        <p className="mt-1 text-sm">
          {'Select a project to start deploying AI agents.'}
        </p>
      </div>
    </div>
  );
};

// ─── Workspace ────────────────────────────────────────────────────────────────

export const Workspace = () => {
  const { state } = useAuth();
  const token = state.status === 'authenticated' ? state.token : '';
  const { projects, loading: projectsLoading } = useProjects(token);

  return (
    <div className="flex h-screen overflow-hidden">
      <LeftNav projects={projects} projectsLoading={projectsLoading} />
      <main className="flex-1 overflow-y-auto p-6">
        <MainArea />
      </main>
      <GuideChat />
    </div>
  );
};
