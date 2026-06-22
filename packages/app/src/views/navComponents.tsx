import {
  Activity,
  ChevronDown,
  Cpu,
  Database,
  FolderOpen,
  Plug,
  Settings,
} from 'lucide-react';
import * as React from 'react';

import type { ModuleInfo } from '@/engine/types';

export type Project = { id: string; name: string };

// Static module grouping — tag labels must match the OpenAPI spec tag values.
export const MODULE_GROUPS: Array<{
  key: string;
  label: string;
  Icon: React.ElementType;
  tags: string[];
}> = [
  {
    key: 'orchestration',
    label: 'Orchestration',
    Icon: Cpu,
    tags: [
      'Agents',
      'Actors',
      'Chats',
      'Tools',
      'Formations',
      'Orchestrations',
    ],
  },
  {
    key: 'memory',
    label: 'Memory',
    Icon: Database,
    tags: ['Conversations', 'Files', 'Documents', 'Knowledge', 'Memories'],
  },
  {
    key: 'observability',
    label: 'Observability',
    Icon: Activity,
    tags: ['Traces'],
  },
  {
    key: 'api',
    label: 'API',
    Icon: Plug,
    tags: ['Webhooks', 'Api Keys', 'API Keys', 'Secrets'],
  },
];

export type GroupDef = {
  key: string;
  label: string;
  Icon: React.ElementType;
  modules: ModuleInfo[];
};

export const buildGroups = (navModules: ModuleInfo[]): GroupDef[] => {
  const assigned = new Set<string>();
  const result: GroupDef[] = [];

  for (const group of MODULE_GROUPS) {
    const matched = navModules.filter((m) => {
      return group.tags.includes(m.label);
    });
    if (matched.length > 0) {
      result.push({ ...group, modules: matched });
      for (const m of matched) {
        assigned.add(m.tag);
      }
    }
  }

  const other = navModules.filter((m) => {
    return !assigned.has(m.tag);
  });
  if (other.length > 0) {
    result.push({
      key: 'other',
      label: 'Other',
      Icon: Settings,
      modules: other,
    });
  }
  return result;
};

// Flattens the grouped modules into a single ordered list, preserving the
// MODULE_GROUPS order (then "other") so related modules stay adjacent without
// any collapsible group headers.
export const orderModules = (navModules: ModuleInfo[]): ModuleInfo[] => {
  return buildGroups(navModules).flatMap((group) => {
    return group.modules;
  });
};

export const NavItem = ({
  label,
  Icon,
  active,
  indent,
  onClick,
}: {
  label: string;
  Icon?: React.ElementType;
  active?: boolean;
  indent?: boolean;
  onClick: () => void;
}) => {
  return (
    <button
      onClick={onClick}
      className={[
        'flex w-full items-center gap-2 rounded-r-md border-l-2 py-1.5 text-left text-sm transition-all',
        indent ? 'pl-6 pr-3' : 'pl-2.5 pr-3',
        active
          ? 'border-primary bg-primary/10 font-semibold text-primary dark:shadow-glow'
          : 'border-transparent text-muted-foreground hover:bg-primary/5 hover:text-foreground',
      ].join(' ')}
    >
      {Icon && (
        <Icon
          className={`h-3.5 w-3.5 shrink-0 ${active ? 'opacity-100' : 'opacity-55'}`}
        />
      )}
      <span>{label}</span>
    </button>
  );
};

export const ProjectPicker = ({
  projects,
  loading,
  activeProjectId,
  onSelect,
}: {
  projects: Project[];
  loading: boolean;
  activeProjectId: string | null;
  onSelect: (id: string) => void;
}) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const activeProject = projects.find((p) => {
    return p.id === activeProjectId;
  });

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
    };
  }, []);

  const toggle = () => {
    setOpen((o) => {
      return !o;
    });
  };

  return (
    <div className="relative px-2.5 pb-3" ref={ref}>
      <p className="mb-1.5 px-1 text-[0.67rem] font-bold uppercase tracking-widest text-muted-foreground/60">
        {'Project'}
      </p>

      {loading ? (
        <div className="flex h-8 items-center rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground">
          {'Loading…'}
        </div>
      ) : activeProject ? (
        <button
          onClick={toggle}
          className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          <div
            className="h-3.5 w-3.5 shrink-0 rounded-sm bg-primary"
            aria-hidden="true"
          />
          <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
            {activeProject.name}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      ) : (
        <button
          onClick={toggle}
          className="flex w-full items-center gap-2 rounded-md border border-dashed border-border bg-card px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent"
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 text-left">{'Select project…'}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      )}

      {open && (
        <div className="absolute left-2.5 right-2.5 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-card shadow-md">
          {projects.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {'No projects yet.'}
            </p>
          )}
          {projects.map((p) => {
            return (
              <button
                key={p.id}
                onClick={() => {
                  onSelect(p.id);
                  setOpen(false);
                }}
                className={[
                  'flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                  activeProjectId === p.id
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground hover:bg-muted',
                ].join(' ')}
              >
                <div className="h-3.5 w-3.5 shrink-0 rounded-sm bg-primary opacity-70" />
                <span className="flex-1 text-left">{p.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const ModuleList = ({
  modules,
  activeListTag,
  onSelect,
}: {
  modules: ModuleInfo[];
  activeListTag: string | null;
  onSelect: (m: ModuleInfo) => void;
}) => {
  return (
    <div className="flex-1 overflow-y-auto pb-2">
      <p className="mb-1 px-2.5 text-[0.67rem] font-bold uppercase tracking-widest text-muted-foreground/60">
        {'Modules'}
      </p>
      {modules.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {'No modules available.'}
        </p>
      )}
      {modules.map((m) => {
        return (
          <NavItem
            key={m.tag}
            label={m.label}
            active={activeListTag === m.tag}
            onClick={() => {
              return onSelect(m);
            }}
          />
        );
      })}
    </div>
  );
};
