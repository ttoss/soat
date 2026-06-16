import * as React from 'react';

import { useAuth } from '@/auth/authContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useNavigation } from '@/engine/navigationContext';
import { useSpec } from '@/engine/specContext';
import type { ViewDescriptor } from '@/engine/types';
import { cn } from '@/lib/utils';

import { runGuideTurn } from './guideAgent';
import { listAiProviders, provisionGuide } from './guideProvisioning';
import { executeRenderPage } from './renderPage';
import type { AiProvider, ChatMessage } from './types';

const providerStorageKey = (projectId: string): string => {
  return `soat-guide-provider:${projectId}`;
};

type ProvisionState =
  | { status: 'idle' }
  | { status: 'provisioning' }
  | { status: 'ready'; agentId: string }
  | { status: 'error'; error: string };

// Scoped to a single project: the panel is remounted (keyed on projectId) when
// the project changes, so this hook never needs to reset state across projects.
const useGuideSession = (args: { token: string; projectId: string }) => {
  const { token, projectId } = args;
  const { modules } = useSpec();
  const [providers, setProviders] = React.useState<AiProvider[]>([]);
  const [providersLoading, setProvidersLoading] = React.useState(true);
  const [providerId, setProviderId] = React.useState<string | null>(null);
  const [provision, setProvision] = React.useState<ProvisionState>({
    status: 'idle',
  });
  // Guards against stale provisioning results when the provider changes mid-flight.
  const reqRef = React.useRef(0);

  const runProvision = React.useCallback(
    (id: string) => {
      const seq = ++reqRef.current;
      setProvision({ status: 'provisioning' });
      provisionGuide({ token, projectId, providerId: id, modules }).then(
        (result) => {
          if (seq !== reqRef.current) return;
          setProvision(
            result.ok
              ? { status: 'ready', agentId: result.agentId }
              : { status: 'error', error: result.error }
          );
        }
      );
    },
    [token, projectId, modules]
  );

  // Load providers once on mount; auto-provision the remembered selection.
  React.useEffect(() => {
    let cancelled = false;
    listAiProviders({ token, projectId })
      .then((list) => {
        if (cancelled) return;
        setProviders(list);
        const stored = localStorage.getItem(providerStorageKey(projectId));
        const valid =
          stored &&
          list.some((p) => {
            return p.id === stored;
          })
            ? stored
            : null;
        if (valid) {
          setProviderId(valid);
          runProvision(valid);
        }
      })
      .finally(() => {
        if (!cancelled) setProvidersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, projectId, runProvision]);

  const selectProvider = React.useCallback(
    (id: string) => {
      localStorage.setItem(providerStorageKey(projectId), id);
      setProviderId(id);
      runProvision(id);
    },
    [projectId, runProvision]
  );

  return { providers, providersLoading, providerId, provision, selectProvider };
};

const ProviderPicker = ({
  providers,
  providersLoading,
  providerId,
  onSelect,
}: {
  providers: AiProvider[];
  providersLoading: boolean;
  providerId: string | null;
  onSelect: (id: string) => void;
}) => {
  if (providersLoading) {
    return (
      <p className="text-sm text-muted-foreground">{'Loading providers…'}</p>
    );
  }
  if (providers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {'No AI providers in this project. Create one to enable the guide.'}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor="guide-provider"
        className="text-xs font-medium text-muted-foreground"
      >
        {'AI provider'}
      </label>
      <select
        id="guide-provider"
        aria-label="AI provider"
        value={providerId ?? ''}
        onChange={(e) => {
          return onSelect(e.target.value);
        }}
        className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
      >
        <option value="" disabled>
          {'Choose a provider…'}
        </option>
        {providers.map((p) => {
          return (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          );
        })}
      </select>
    </div>
  );
};

const MessageBubble = ({
  message,
  onMountView,
}: {
  message: ChatMessage;
  onMountView: (view: ViewDescriptor) => void;
}) => {
  const isUser = message.role === 'user';
  return (
    <div
      className={cn(
        'flex flex-col gap-1',
        isUser ? 'items-end' : 'items-start'
      )}
    >
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-foreground'
        )}
      >
        {message.content}
      </div>
      {message.view && (
        <button
          onClick={() => {
            return message.view && onMountView(message.view);
          }}
          className="text-xs text-primary underline-offset-2 hover:underline"
        >
          {`Showing: ${message.view.tag} (${message.view.mode}) →`}
        </button>
      )}
    </div>
  );
};

const GuidePanel = ({
  token,
  projectId,
}: {
  token: string;
  projectId: string;
}) => {
  const { spec, modules } = useSpec();
  const { navigate } = useNavigation();
  const { providers, providersLoading, providerId, provision, selectProvider } =
    useGuideSession({ token, projectId });

  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState('');
  const [sending, setSending] = React.useState(false);

  const agentId = provision.status === 'ready' ? provision.agentId : null;

  const send = async () => {
    const text = input.trim();
    if (!text || !agentId || !spec || sending) return;
    const history: ChatMessage[] = [
      ...messages,
      { role: 'user', content: text },
    ];
    setMessages(history);
    setInput('');
    setSending(true);

    const result = await runGuideTurn({
      token,
      agentId,
      messages: history.map((m) => {
        return { role: m.role, content: m.content };
      }),
      executeToolCall: (call) => {
        return executeRenderPage({
          toolArgs: call.args,
          spec,
          modules,
          activeProjectId: projectId,
          navigate,
        });
      },
    });

    setMessages((prev) => {
      return [
        ...prev,
        result.ok
          ? { role: 'assistant', content: result.text, view: result.view }
          : { role: 'assistant', content: `⚠ ${result.error}` },
      ];
    });
    setSending(false);
  };

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <ProviderPicker
        providers={providers}
        providersLoading={providersLoading}
        providerId={providerId}
        onSelect={selectProvider}
      />

      {provision.status === 'provisioning' && (
        <p className="text-sm text-muted-foreground">
          {'Preparing the guide…'}
        </p>
      )}
      {provision.status === 'error' && (
        <p className="text-sm text-destructive">{provision.error}</p>
      )}

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
        {messages.length === 0 && agentId && (
          <p className="text-sm text-muted-foreground">
            {'Ask me to show or manage anything in this project.'}
          </p>
        )}
        {messages.map((m, i) => {
          return <MessageBubble key={i} message={m} onMountView={navigate} />;
        })}
        {sending && (
          <p className="text-xs text-muted-foreground">{'Thinking…'}</p>
        )}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Input
          aria-label="Message the guide"
          placeholder="Show me the agents…"
          value={input}
          disabled={!agentId || sending}
          onChange={(e) => {
            return setInput(e.target.value);
          }}
        />
        <Button
          type="submit"
          size="sm"
          disabled={!agentId || sending || !input.trim()}
        >
          {'Send'}
        </Button>
      </form>
    </div>
  );
};

export const GuideChat = () => {
  const { state } = useAuth();
  const { activeProjectId } = useNavigation();
  const [collapsed, setCollapsed] = React.useState(false);
  const token = state.status === 'authenticated' ? state.token : '';

  // The active project is derived from the main view's URL, which the guide
  // itself changes when it mounts a non-project-scoped view. Pin the guide to
  // the last project the user selected so its session survives navigation; it
  // only switches when the user explicitly opens a different project.
  // Track the last non-null project so the panel survives navigation to
  // views that are not project-scoped (where activeProjectId becomes null).
  const [pinnedProjectId, setPinnedProjectId] = React.useState<string | null>(
    activeProjectId
  );
  const [prevActiveProjectId, setPrevActiveProjectId] =
    React.useState(activeProjectId);
  if (prevActiveProjectId !== activeProjectId) {
    setPrevActiveProjectId(activeProjectId);
    if (activeProjectId !== null) setPinnedProjectId(activeProjectId);
  }
  const guideProjectId = activeProjectId ?? pinnedProjectId;

  if (collapsed) {
    return (
      <aside className="flex h-full w-12 shrink-0 flex-col items-center border-l bg-muted/20 py-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open guide"
          onClick={() => {
            return setCollapsed(false);
          }}
        >
          {'💬'}
        </Button>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l bg-muted/20">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-semibold">{'AI Guide'}</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Collapse guide"
          onClick={() => {
            return setCollapsed(true);
          }}
        >
          {'×'}
        </Button>
      </div>
      {guideProjectId ? (
        <GuidePanel
          key={guideProjectId}
          token={token}
          projectId={guideProjectId}
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {'Select a project to use the AI guide.'}
        </p>
      )}
    </aside>
  );
};
