import { FolderOpen, Key, LogOut, Settings, Shield, Users } from 'lucide-react';
import * as React from 'react';
import { useLocation } from 'react-router-dom';

import { apiFetch } from '@/api/client';
import { useAuth } from '@/auth/authContext';
import { GuideChat } from '@/chat/guideChat';
import { EngineView } from '@/engine/engineView';
import { useNavigation } from '@/engine/navigationContext';
import { useSpec } from '@/engine/specContext';
import {
  buildUrl,
  extractItems,
  extractPathParams,
  itemLabel,
  opAcceptsProjectIdQuery,
} from '@/engine/specUtils';
import type { ModuleInfo } from '@/engine/types';
import { BRAND_ASSETS } from '@/lib/brandAssets';

import type { Project } from './navComponents';
import { ModuleList, NavItem, ProjectPicker } from './navComponents';

// Global / governance modules — not scoped to the selected project and gated to
// admins. They render in the sidebar's distinct "Admin" block (soat-design),
// rather than in the flat project-module list.
const ADMIN_TAGS = new Set([
  'Projects',
  'Users',
  'Policies',
  'Api Keys',
  'API Keys',
  'ApiKeys',
]);

const isAdminModule = (m: ModuleInfo): boolean => {
  return ADMIN_TAGS.has(m.tag) || ADMIN_TAGS.has(m.label);
};

// Sidebar modules are listed alphabetically by their display label.
const byLabel = (a: ModuleInfo, b: ModuleInfo): number => {
  return a.label.localeCompare(b.label);
};

// A module is reachable from the top-level sidebar only if its list path has no
// parent path param to fill (project_id is supplied from the active project).
// Nested sub-resources (e.g. Sessions at /agents/{agent_id}/sessions) are
// reached from their parent's detail view instead — listing them standalone
// would leave an unfilled {agent_id} in the URL.
const isTopLevelModule = (m: ModuleInfo): boolean => {
  if (!m.listOp) return false;
  return extractPathParams(m.listOp.pathTemplate).every((param) => {
    return param === 'project_id';
  });
};

const ADMIN_ICONS: Record<string, React.ElementType> = {
  Projects: FolderOpen,
  Users,
  Policies: Shield,
  'Api Keys': Key,
  'API Keys': Key,
  ApiKeys: Key,
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

// Maps a projects list response to picker options using the same engine
// helpers the generic views use: extractItems for the list shape and itemLabel
// for the display name. No hardcoded field names.
const toProjectOptions = (data: unknown): Project[] => {
  return extractItems(data).map((item) => {
    return { id: String(item.id ?? ''), name: itemLabel(item) };
  });
};

// Fetches projects from the spec-derived list path (the Projects module's
// listOp), rather than a hardcoded URL. Stays in the loading state until a
// path is available so the picker does not flash an empty state.
const useProjects = (token: string, listPath: string | undefined) => {
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!token || !listPath) return;
    apiFetch<unknown>({ url: buildUrl(listPath, {}), token })
      .then((result) => {
        if (result.ok) setProjects(toProjectOptions(result.data));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [token, listPath]);

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

  const activeListTag = view?.mode === 'list' ? view.tag : null;

  // Global / governance modules (Projects, Users, Policies, AI Providers, API
  // Keys) live in the Admin block, admin-only, sorted alphabetically.
  const adminModules = React.useMemo(() => {
    if (user?.role !== 'admin') return [];
    return modules
      .filter((m) => {
        return isAdminModule(m) && isTopLevelModule(m);
      })
      .sort(byLabel);
  }, [modules, user]);

  // Project-scoped, top-level modules sorted alphabetically by label. Nested
  // sub-resources and global/admin modules are excluded (the latter render in
  // their own Admin block below).
  const navModules = React.useMemo(() => {
    return modules
      .filter((m) => {
        return !isAdminModule(m) && isTopLevelModule(m);
      })
      .sort(byLabel);
  }, [modules]);

  const navigateToModule = React.useCallback(
    (m: ModuleInfo) => {
      if (!m.listOp) return;
      // The Projects collection (GET /projects) is global — never scope its
      // list to the active project, even though its detail paths take
      // {project_id} (which would otherwise mark the module project-scoped).
      const pathParams =
        m.tag === 'Projects' ? {} : buildPathParams(m, activeProjectId);
      navigate({
        tag: m.tag,
        operationId: m.listOp.operation.operationId,
        pathParams,
        mode: 'list',
      });
    },
    [navigate, activeProjectId]
  );

  return (
    <nav className="flex h-full w-56 shrink-0 flex-col overflow-hidden border-r bg-muted/20">
      <div className="flex items-center gap-2 px-3.5 pb-3 pt-4">
        <img
          src={BRAND_ASSETS.logoMark}
          alt=""
          aria-hidden="true"
          className="h-6 w-6 object-contain"
        />
        <h1 className="w-fit bg-galaxy-gradient bg-clip-text text-base font-bold tracking-heading text-transparent">
          {'SOAT'}
        </h1>
      </div>

      <ProjectPicker
        projects={projects}
        loading={projectsLoading}
        activeProjectId={activeProjectId}
        onSelect={setProject}
      />

      <ModuleList
        modules={navModules}
        activeListTag={activeListTag}
        onSelect={navigateToModule}
      />

      {adminModules.length > 0 && (
        <div className="border-t py-1.5">
          <p className="mb-1 px-2.5 pt-1 text-[0.67rem] font-bold uppercase tracking-widest text-muted-foreground/60">
            {'Admin'}
          </p>
          {adminModules.map((m) => {
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
        <p className="mt-1.5 px-1 text-[0.67rem] text-muted-foreground/40">
          {`v${__APP_VERSION__}`}
        </p>
      </div>
    </nav>
  );
};

// ─── SelectProjectPrompt ────────────────────────────────────────────────────

// Shown when the current view needs a project but none is selected. Lists the
// available projects inline so the user can pick one without hunting for the
// sidebar picker.
const SelectProjectPrompt = ({
  projects,
  loading,
  onSelect,
}: {
  projects: Project[];
  loading: boolean;
  onSelect: (projectId: string) => void;
}) => {
  return (
    <div className="flex flex-col items-center justify-center gap-6 py-16">
      <img
        src={BRAND_ASSETS.logoMark}
        alt=""
        aria-hidden="true"
        className="h-20 w-20 object-contain"
      />
      <div className="text-center">
        <p className="font-heading text-xl font-bold text-foreground">
          {'Select a project first'}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {
            'Choose a project to work in — its agents, chats and other resources will appear here.'
          }
        </p>
      </div>

      <div className="flex w-full max-w-sm flex-col gap-2">
        {loading && (
          <p className="text-center text-sm text-muted-foreground">
            {'Loading projects…'}
          </p>
        )}
        {!loading && projects.length === 0 && (
          <p className="text-center text-sm text-muted-foreground">
            {'No projects yet. Create one from the Projects section.'}
          </p>
        )}
        {projects.map((p) => {
          return (
            <button
              key={p.id}
              onClick={() => {
                return onSelect(p.id);
              }}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left text-sm font-medium text-foreground transition-all hover:border-primary/40 hover:bg-accent"
            >
              <span
                className="h-3.5 w-3.5 shrink-0 rounded-sm bg-primary"
                aria-hidden="true"
              />
              <span className="flex-1 truncate">{p.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

// ─── MainArea ─────────────────────────────────────────────────────────────────

const MainArea = ({
  projects,
  projectsLoading,
}: {
  projects: Project[];
  projectsLoading: boolean;
}) => {
  const location = useLocation();
  const { view, activeProjectId, setProject } = useNavigation();
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

  // A view backed by a project-scoped module (one whose list accepts a
  // project_id query param) is meaningless without a selected project.
  const currentModule = view
    ? modules.find((m) => {
        return m.tag === view.tag;
      })
    : undefined;
  const viewNeedsProject =
    !!currentModule && opAcceptsProjectIdQuery(currentModule.listOp);

  if (view && spec && (activeProjectId || !viewNeedsProject)) {
    // Key by the URL so navigating to another page remounts the view: it
    // restarts in its loading state instead of showing the previous page's
    // stale content while the new data is fetched.
    return (
      <EngineView
        key={location.pathname}
        descriptor={view}
        modules={modules}
        spec={spec}
      />
    );
  }

  // No project selected (either at the workspace root or on a project-scoped
  // page) — prompt the user to pick one, listing the projects inline.
  if (!activeProjectId) {
    return (
      <SelectProjectPrompt
        projects={projects}
        loading={projectsLoading}
        onSelect={setProject}
      />
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
      <p className="text-lg font-medium text-foreground">
        {'Project selected'}
      </p>
      <p className="text-sm">{'Choose a module from the left navigation.'}</p>
    </div>
  );
};

// ─── Workspace ────────────────────────────────────────────────────────────────

export const Workspace = () => {
  const { state } = useAuth();
  const token = state.status === 'authenticated' ? state.token : '';
  const { modules, loading: specLoading } = useSpec();
  const projectsPath = modules.find((m) => {
    return m.tag === 'Projects';
  })?.listOp?.pathTemplate;
  const { projects, loading: projectsLoading } = useProjects(
    token,
    projectsPath
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <LeftNav
        projects={projects}
        projectsLoading={specLoading || projectsLoading}
      />
      <main className="flex-1 overflow-y-auto p-6">
        <MainArea
          projects={projects}
          projectsLoading={specLoading || projectsLoading}
        />
      </main>
      <GuideChat />
    </div>
  );
};
